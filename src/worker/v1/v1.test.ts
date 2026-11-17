import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { accessCookieName, signAccessGrant } from "../eventAccess";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { isBelowMinimumBuild, parseIosBuild } from "./index";
import { ErrorSchema, EventSchema, FeedChangesSchema, FeedPageSchema, JoinResponseSchema } from "./schemas";

const SECRET = "test-access-secret-123";
let sqlite: SqliteD1;
let extraEnv: Partial<Env>;

function seedEvent(id: string, slug: string, accessMode = "public") {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, access_mode, access_version) VALUES (?, ?, ?, 'Party', ?, 1)")
    .run(id, slug, `Event ${slug}`, accessMode);
}

function addMoment(id: string, eventId = "event-1") {
  sqlite.raw
    .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type) VALUES (?, ?, 'Sara', ?, 'image/jpeg')")
    .run(id, eventId, `/media/events/${eventId}/moments/${id}.jpg`);
}

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EVENT_ACCESS_SECRET: SECRET,
    ...extraEnv,
  };
}

function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, init), env(), ctx);
}

function join(slug: string, body: unknown, headers: Record<string, string> = {}) {
  return call(`/events/${slug}/participants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Parses with the published schema and fails if the response had extra keys. */
function exact<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  const parsed = schema.parse(value);
  expect(parsed).toEqual(value);
  return parsed;
}

beforeEach(() => {
  sqlite = createSqliteD1();
  extraEnv = {};
  seedEvent("event-1", "party");
});

describe("parseIosBuild / isBelowMinimumBuild", () => {
  it.each([
    ["ios/1.2.0(42)", 42],
    ["ios/1(7)", 7],
    ["web", null],
    ["ios/1.0", null],
    ["ios/1.0(42) extra", null],
    [undefined, null],
  ])("%j -> %j", (header, build) => {
    expect(parseIosBuild(header)).toBe(build);
  });

  it("only gates iOS builds below a valid minimum", () => {
    expect(isBelowMinimumBuild(41, "42")).toBe(true);
    expect(isBelowMinimumBuild(42, "42")).toBe(false);
    expect(isBelowMinimumBuild(null, "42")).toBe(false);
    expect(isBelowMinimumBuild(1, undefined)).toBe(false);
    expect(isBelowMinimumBuild(1, "abc")).toBe(false);
  });
});

describe("GET /events/{slug}", () => {
  it("returns the public event without secrets", async () => {
    const res = await call("/events/party");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: Record<string, unknown> };
    expect(exact(EventSchema, body.event)).toMatchObject({ id: "event-1", slug: "party", access_mode: "public" });
    for (const secret of ["access_pin_hash", "access_pin_salt", "invite_token", "access_version"]) {
      expect(body.event).not.toHaveProperty(secret);
    }
  });

  it("returns a stable 404 for unknown events", async () => {
    const res = await call("/events/nope");
    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await res.json())).toMatchObject({ code: "event_not_found" });
  });
});

describe("private events", () => {
  beforeEach(() => seedEvent("event-p", "secret", "private"));

  it.each(["/events/secret", "/events/secret/feed", "/events/secret/feed/changes?since=0"])(
    "%s needs a grant",
    async (path) => {
      const res = await call(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "access_required" });
    }
  );

  it("blocks joining without a grant", async () => {
    expect((await join("secret", { nickname: "Sara" })).status).toBe(401);
  });

  it("accepts a valid grant in X-Event-Access", async () => {
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-p",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    expect((await call("/events/secret", { headers: { "X-Event-Access": grant } })).status).toBe(200);
    expect((await call("/events/secret/feed", { headers: { "X-Event-Access": grant } })).status).toBe(200);
  });

  it("rejects the raw invite token and the web cookie", async () => {
    sqlite.raw.prepare("UPDATE events SET invite_token = 'raw-invite-123' WHERE id = 'event-p'").run();
    expect((await call("/events/secret", { headers: { "X-Event-Access": "raw-invite-123" } })).status).toBe(401);
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-p",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const cookie = `${accessCookieName("event-p")}=${grant}`;
    expect((await call("/events/secret", { headers: { Cookie: cookie } })).status).toBe(401);
    const ctx0 = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const webCookie = await worker.fetch(new Request("https://moments.test/api/events/secret", { headers: { Cookie: cookie } }), env(), ctx0);
    expect(webCookie.status).toBe(200);
    // The web route still honours the legacy invite token during its transition window.
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const web = await worker.fetch(
      new Request("https://moments.test/api/events/secret", { headers: { "X-Event-Access": "raw-invite-123" } }),
      env(),
      ctx
    );
    expect(web.status).toBe(200);
  });

  it("rejects a grant for another event", async () => {
    seedEvent("event-q", "other-secret", "private");
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-q",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    expect((await call("/events/secret/feed", { headers: { "X-Event-Access": grant } })).status).toBe(401);
  });
});

describe("feed", () => {
  it("returns a page and changes that match the published schemas", async () => {
    addMoment("m1");
    addMoment("m2");
    const res = await call("/events/party/feed?limit=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const page = exact(FeedPageSchema, await res.json());
    expect(page.moments.map((m) => m.id)).toEqual(["m2"]);
    expect(page.moments[0]).toMatchObject({ reacted: false, reaction_count: 0 });
    expect(page.next_before).toBe(2);

    const changes = exact(FeedChangesSchema, await (await call("/events/party/feed/changes?since=0")).json());
    expect(changes.upserts.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("reports reacted as a boolean for the reactor", async () => {
    addMoment("m1");
    sqlite.raw
      .prepare("INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES ('r1', 'm1', 'event-1', 'me')")
      .run();
    const page = FeedPageSchema.parse(await (await call("/events/party/feed?reactor_id=me")).json());
    expect(page.moments[0]).toMatchObject({ reacted: true, reaction_count: 1 });
  });

  it.each([
    "/events/party/feed?before=-1",
    "/events/party/feed?limit=abc",
    "/events/party/feed/changes",
    "/events/party/feed/changes?since=1.5",
    `/events/party/feed?reactor_id=${"x".repeat(101)}`,
  ])("%s is a 400 with a stable error shape", async (path) => {
    const res = await call(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request", code: "invalid_request" });
  });
});

describe("POST /events/{slug}/participants", () => {
  it("joins with JSON and returns a guest token once", async () => {
    const first = await join("party", { nickname: "  Sara  ", avatar_seed: "seed-1" });
    expect(first.status).toBe(200);
    const joined = exact(JoinResponseSchema, await first.json());
    expect(joined.participant).toMatchObject({ nickname: "Sara", avatar_seed: "seed-1" });
    expect(joined.guest_token).toMatch(/^gt_/);
    expect(joined.participant).not.toHaveProperty("claimed_at");

    const again = JoinResponseSchema.parse(
      await (await join("party", { nickname: "Sara" }, { "X-Guest-Token": joined.guest_token ?? "" })).json()
    );
    expect(again.guest_token).toBeUndefined();
    expect(again.participant.id).toBe(joined.participant.id);
  });

  it("returns 409 nickname_taken when enforcement is on", async () => {
    extraEnv = { GUEST_TOKENS_ENFORCED: "true" };
    await join("party", { nickname: "Sara" });
    const res = await join("party", { nickname: "Sara" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "nickname_taken" });
  });

  it.each([{}, { nickname: "   " }, { nickname: "x".repeat(61) }, { nickname: 3 }])(
    "rejects invalid body %j",
    async (body) => {
      expect((await join("party", body)).status).toBe(400);
    }
  );

  it("rejects a non-JSON body", async () => {
    const res = await call("/events/party/participants", { method: "POST", body: "nickname=Sara" });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "invalid request", code: "invalid_request" });
  });
});

describe("error shapes", () => {
  it("rejects malformed JSON with 400", async () => {
    const res = await call("/events/party/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nickname",
    });
    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).code).toBe("invalid_request");
  });

  it("returns JSON 404 for unknown v1 paths", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
  });

  it("checks the event before validating the query", async () => {
    expect(await (await call("/events/missing/feed/changes")).json()).toMatchObject({ code: "event_not_found" });
  });
});

describe("client version gate", () => {
  it("sends 426 to iOS builds below MIN_IOS_BUILD and lets others through", async () => {
    extraEnv = { MIN_IOS_BUILD: "10" };
    const old = await call("/events/party", { headers: { "X-Client": "ios/1.0(9)" } });
    expect(old.status).toBe(426);
    expect(await old.json()).toMatchObject({ code: "client_upgrade_required" });
    expect((await call("/events/party", { headers: { "X-Client": "ios/1.1(10)" } })).status).toBe(200);
    expect((await call("/events/party")).status).toBe(200);
  });

  it("runs before event lookup and on every v1 path", async () => {
    extraEnv = { MIN_IOS_BUILD: "10" };
    const headers = { "X-Client": "ios/1.0(9)" };
    expect((await call("/events/missing", { headers })).status).toBe(426);
    expect((await call("/openapi.json", { headers })).status).toBe(426);
  });
});

describe("web routes", () => {
  it("are unaffected by the v1 mount", async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://moments.test/api/events/party"), env(), ctx);
    expect(res.status).toBe(200);
  });
});
