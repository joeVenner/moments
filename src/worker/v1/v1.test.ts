import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { accessCookieName, hashEventPin, MAX_PIN_FAILURES_PER_CLIENT, signAccessGrant } from "../eventAccess";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { isBelowMinimumBuild, parseIosBuild } from "./index";
import {
  AccessResponseSchema,
  ErrorSchema,
  EventSchema,
  FeedChangesSchema,
  FeedPageSchema,
  HighlightsSchema,
  JoinResponseSchema,
  LeaderboardSchema,
  PartUrlsSchema,
  ReactionSchema,
  TooManyAttemptsSchema,
  UploadSessionSchema,
  UploadStatusSchema,
} from "./schemas";

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

  it("signs R2 media URLs with ?at= on private feeds only", async () => {
    addMoment("m1", "event-p");
    addMoment("m2", "event-1");
    sqlite.raw.prepare("UPDATE moments SET thumb_key = 'events/event-p/thumbs/m1.jpg' WHERE id = 'm1'").run();
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-p",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const headers = { "X-Event-Access": grant };
    const at = /\?at=\d{10}\.[\w-]{43}$/;
    const page = (await (await call("/events/secret/feed", { headers })).json()) as {
      moments: { media_url: string; media: { url: string; thumb_url: string | null; display_url: string | null } }[];
    };
    const [moment] = page.moments;
    expect(moment.media_url).toMatch(at);
    expect(moment.media.url).toMatch(at);
    expect(moment.media.thumb_url).toMatch(/^\/media\/events\/event-p\/thumbs\/m1\.jpg\?at=/);
    expect(moment.media.display_url).toBeNull();
    const changes = (await (await call("/events/secret/feed/changes?since=0", { headers })).json()) as {
      upserts: { media: { url: string } }[];
    };
    expect(changes.upserts[0].media.url).toMatch(at);
    const open = (await (await call("/events/party/feed")).json()) as { moments: { media: { url: string } }[] };
    expect(open.moments[0].media.url).toBe("/media/events/event-1/moments/m2.jpg");
  });

  it("signs a private event's cover; the web event response is unchanged", async () => {
    addMoment("m1", "event-p");
    sqlite.raw.prepare("UPDATE events SET cover_image_url = '/media/events/event-p/cover' WHERE id = 'event-p'").run();
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-p",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const native = (await (await call("/events/secret", { headers: { "X-Event-Access": grant } })).json()) as {
      event: { cover_image_url: string };
    };
    expect(native.event.cover_image_url).toMatch(/^\/media\/events\/event-p\/cover\?at=\d{10}\.[\w-]{43}$/);
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const webEvent = await worker.fetch(
      new Request("https://moments.test/api/events/secret", { headers: { "X-Event-Access": grant } }),
      env(),
      ctx
    );
    expect(JSON.stringify(await webEvent.json())).not.toContain("?at=");
    const ctx2 = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const webFeed = await worker.fetch(
      new Request("https://moments.test/api/events/secret/moments", { headers: { "X-Event-Access": grant } }),
      env(),
      ctx2
    );
    expect(webFeed.status).toBe(200);
    expect(JSON.stringify(await webFeed.json())).not.toContain("?at=");
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

describe("highlights and leaderboard", () => {
  function heart(momentId: string, reactorId: string) {
    sqlite.raw
      .prepare("INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES (?, ?, 'event-1', ?)")
      .run(`${momentId}-${reactorId}`, momentId, reactorId);
  }

  function addGuest(id: string, nickname: string, joinedAt: string, eventId = "event-1") {
    sqlite.raw
      .prepare("INSERT INTO participants (id, event_id, nickname, avatar_seed, joined_at) VALUES (?, ?, ?, 'seed', ?)")
      .run(id, eventId, nickname, joinedAt);
  }

  function addMomentBy(id: string, uploader: string, points: number, eventId = "event-1") {
    sqlite.raw
      .prepare(
        "INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type, points_awarded) VALUES (?, ?, ?, ?, 'image/jpeg', ?)"
      )
      .run(id, eventId, uploader, `/media/events/${eventId}/moments/${id}.jpg`, points);
  }

  it("ranks visible moments by hearts, newest first among ties, with this device's state", async () => {
    for (const id of ["m1", "m2", "m3", "m4"]) addMoment(id);
    heart("m1", "aaaaaaaa1");
    heart("m3", "aaaaaaaa1");
    heart("m3", "bbbbbbbb2");
    heart("m4", "bbbbbbbb2");
    sqlite.raw.prepare("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm4'").run();
    const res = await call("/events/party/highlights?reactor_id=aaaaaaaa1&limit=3");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = exact(HighlightsSchema, await res.json());
    expect(body.moments.map((m) => [m.id, m.reaction_count, m.reacted])).toEqual([
      ["m3", 2, true],
      ["m1", 1, true],
      ["m2", 0, false],
    ]);
  });

  it("signs private-event media for the grant holder", async () => {
    seedEvent("event-p", "secret", "private");
    addMoment("mp", "event-p");
    expect((await call("/events/secret/highlights")).status).toBe(401);
    expect((await call("/events/secret/leaderboard")).status).toBe(401);
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-p",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const res = await call("/events/secret/highlights", { headers: { "X-Event-Access": grant } });
    const body = (await res.json()) as { moments: { media: { url: string } }[] };
    expect(body.moments[0].media.url).toMatch(/[?&]at=/);
  });

  it("rejects a bad limit and clamps big ones", async () => {
    expect((await call("/events/party/highlights?limit=lots")).status).toBe(400);
    for (let i = 0; i < 52; i += 1) addMoment(`bulk-${i}`);
    const body = (await (await call("/events/party/highlights?limit=500")).json()) as { moments: unknown[] };
    expect(body.moments).toHaveLength(50);
  });

  it("ranks guests by points from visible moments, sharing ranks on ties", async () => {
    addGuest("p-sara", "Sara", "2026-11-18 10:00:00");
    addGuest("p-omar", "Omar", "2026-11-18 10:05:00");
    addGuest("p-lina", "Lina", "2026-11-18 10:01:00");
    addGuest("p-zed", "Zed", "2026-11-18 10:10:00");
    addGuest("p-ali", "Ali", "2026-11-18 10:02:00");
    addMomentBy("ali-hidden", "Ali", 30);
    sqlite.raw.prepare("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'ali-hidden'").run();
    addMomentBy("a", "Sara", 10);
    addMomentBy("b", "Omar", 7);
    addMomentBy("c", "Omar", 3);
    addMomentBy("d", "Lina", 4);
    addMomentBy("hidden", "Lina", 50);
    sqlite.raw.prepare("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'hidden'").run();
    // Same nickname in another event doesn't count here.
    seedEvent("event-2", "other");
    addMomentBy("x", "Zed", 99, "event-2");
    const res = await call("/events/party/leaderboard");
    expect(res.status).toBe(200);
    const body = exact(LeaderboardSchema, await res.json());
    expect(body.entries.map((e) => [e.nickname, e.total_points, e.moment_count, e.rank])).toEqual([
      ["Sara", 10, 1, 1],
      ["Omar", 10, 2, 1],
      ["Lina", 4, 1, 3],
      // Equal points: the earlier joiner first.
      ["Ali", 0, 0, 4],
      ["Zed", 0, 0, 4],
    ]);
    expect(body.entries[0]).toMatchObject({ participant_id: "p-sara", avatar_seed: "seed" });
  });

  it("rate limits both per event and IP before reading", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    extraEnv = { GUEST_READ_LIMITER: { limit } };
    for (const path of ["highlights", "leaderboard"]) {
      const res = await call(`/events/party/${path}`, { headers: { "CF-Connecting-IP": "198.51.100.4" } });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: "rate_limited" });
    }
    expect(limit).toHaveBeenCalledWith({ key: "event-1:ip:198.51.100.4" });
  });

  it("is empty for an event nobody joined", async () => {
    expect(await (await call("/events/party/leaderboard")).json()).toEqual({ entries: [] });
    expect(await (await call("/events/party/highlights")).json()).toEqual({ moments: [] });
  });
});

describe("reactions", () => {
  const REACTOR = "3f2a9c1e5b7d4f60a8e2c4b6d8f0a1b2";

  function react(
    method: "PUT" | "DELETE",
    momentId: string,
    reactorId = REACTOR,
    headers: Record<string, string> = {},
    slug = "party"
  ) {
    return call(`/events/${slug}/moments/${momentId}/reaction`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ reactor_id: reactorId }),
    });
  }

  beforeEach(() => addMoment("m1"));

  it("adds and removes idempotently, counting every device", async () => {
    const first = await react("PUT", "m1");
    expect(first.status).toBe(200);
    expect(exact(ReactionSchema, await first.json())).toEqual({ reacted: true, reaction_count: 1 });
    expect(await (await react("PUT", "m1")).json()).toEqual({ reacted: true, reaction_count: 1 });
    expect(await (await react("PUT", "m1", "a1b2c3d4-0000-4000-8000-000000000000")).json()).toEqual({
      reacted: true,
      reaction_count: 2,
    });
    expect(await (await react("DELETE", "m1")).json()).toEqual({ reacted: false, reaction_count: 1 });
    expect(await (await react("DELETE", "m1")).json()).toEqual({ reacted: false, reaction_count: 1 });
  });

  it("shows in the feed as this device's reaction", async () => {
    await react("PUT", "m1");
    const page = (await (await call(`/events/party/feed?reactor_id=${REACTOR}`)).json()) as {
      moments: { reacted: boolean; reaction_count: number }[];
    };
    expect(page.moments[0]).toMatchObject({ reacted: true, reaction_count: 1 });
  });

  it("rejects malformed reactor ids", async () => {
    for (const bad of ["short77", "has space here", "x".repeat(101), "semi;colon00"]) {
      const put = await react("PUT", "m1", bad);
      expect(put.status).toBe(400);
      expect(await put.json()).toMatchObject({ code: "invalid_request" });
      expect((await react("DELETE", "m1", bad)).status).toBe(400);
    }
  });

  it("accepts the shortest and longest reactor ids", async () => {
    expect((await react("PUT", "m1", "abcdefgh")).status).toBe(200);
    expect((await react("PUT", "m1", "A".repeat(100))).status).toBe(200);
  });

  it("needs a body", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const res = await call("/events/party/moments/m1/reaction", {
        method,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
    }
  });

  it("stays at one heart under concurrent adds", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => react("PUT", "m1")));
    expect(results.every((res) => res.status === 200)).toBe(true);
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moment_reactions").get()).toEqual({ n: 1 });
  });

  it("works on a private event with its grant", async () => {
    seedEvent("event-p", "secret", "private");
    addMoment("m3", "event-p");
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-p",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const res = await react("PUT", "m3", REACTOR, { "X-Event-Access": grant }, "secret");
    expect(await res.json()).toEqual({ reacted: true, reaction_count: 1 });
  });

  it("is rate limited per device, before touching moments", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    extraEnv = { REACTION_LIMITER: { limit } };
    const res = await react("PUT", "m1", REACTOR, { "CF-Connecting-IP": "203.0.113.9" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    expect(limit).toHaveBeenCalledWith({ key: "event-1:ip:203.0.113.9" });
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moment_reactions").get()).toEqual({ n: 0 });
  });

  it("keys the limit on the guest session when there is one", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    extraEnv = { REACTION_LIMITER: { limit } };
    const joined = (await (await join("party", { nickname: "Sara" })).json()) as { guest_token: string };
    await react("PUT", "m1", REACTOR, { "X-Guest-Token": joined.guest_token });
    expect(limit.mock.calls[0][0].key).toMatch(/^event-1:guest:/);
  });

  it("only reaches visible moments of this event", async () => {
    sqlite.raw.prepare("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm1'").run();
    seedEvent("event-2", "other");
    addMoment("m2", "event-2");
    for (const id of ["m1", "m2", "missing"]) {
      const res = await react("PUT", id);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "moment_not_found" });
    }
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moment_reactions").get()).toEqual({ n: 0 });
  });

  it("needs the grant on private events", async () => {
    seedEvent("event-p", "secret", "private");
    addMoment("m3", "event-p");
    const res = await call("/events/secret/moments/m3/reaction", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reactor_id: REACTOR }),
    });
    expect(res.status).toBe(401);
  });

  it("requires a joined device once guest tokens are enforced", async () => {
    extraEnv = { GUEST_TOKENS_ENFORCED: "true" };
    const blocked = await react("PUT", "m1");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "guest_required" });
    expect((await react("PUT", "m1", REACTOR, { "X-Guest-Token": "gt_" + "a".repeat(43) })).status).toBe(403);
    const joined = (await (await join("party", { nickname: "Sara" })).json()) as { guest_token: string };
    expect((await react("PUT", "m1", REACTOR, { "X-Guest-Token": joined.guest_token })).status).toBe(200);
    expect((await react("DELETE", "m1", REACTOR, { "X-Guest-Token": joined.guest_token })).status).toBe(200);
    expect((await react("DELETE", "m1")).status).toBe(403);
    // A token from another event doesn't count here.
    seedEvent("event-2", "other");
    const elsewhere = (await (await join("other", { nickname: "Sara" })).json()) as { guest_token: string };
    expect((await react("PUT", "m1", REACTOR, { "X-Guest-Token": elsewhere.guest_token })).status).toBe(403);
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

describe("POST /events/{slug}/access", () => {
  const PIN = "482916";

  beforeEach(async () => {
    seedEvent("event-p", "secret", "private");
    sqlite.raw
      .prepare("UPDATE events SET access_pin_hash = ?, access_pin_salt = 'salt-1', invite_token = 'invite-abc' WHERE id = 'event-p'")
      .run(await hashEventPin(PIN, "salt-1"));
  });

  function requestAccess(slug: string, body: unknown, headers: Record<string, string> = {}) {
    return call(`/events/${slug}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
      body: JSON.stringify(body),
    });
  }

  function failureCount() {
    return (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM access_failures").get() as { n: number }).n;
  }

  it("grants a usable, cookie-free grant for the right PIN", async () => {
    const res = await requestAccess("secret", { pin: ` ${PIN} ` });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = exact(AccessResponseSchema, await res.json());
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const feed = await call("/events/secret/feed", { headers: { "X-Event-Access": body.access_token ?? "" } });
    expect(feed.status).toBe(200);
    expect(failureCount()).toBe(0);
  });

  it("grants with the invite token", async () => {
    const body = AccessResponseSchema.parse(await (await requestAccess("secret", { invite_token: "invite-abc" })).json());
    expect(body.access_token).toBeTruthy();
  });

  it("needs no grant for a public event", async () => {
    expect(exact(AccessResponseSchema, await (await requestAccess("party", { pin: "123456" })).json())).toEqual({
      access_token: null,
      expires_at: null,
    });
  });

  it("rejects a wrong PIN or invite and records PIN failures", async () => {
    const wrongPin = await requestAccess("secret", { pin: "000000" });
    expect(wrongPin.status).toBe(401);
    expect(ErrorSchema.parse(await wrongPin.json()).code).toBe("invalid_access");
    expect(failureCount()).toBe(1);
    const wrongInvite = await requestAccess("secret", { invite_token: "nope" });
    expect(await wrongInvite.json()).toMatchObject({ code: "invalid_access" });
  });

  it("locks a client out after too many failures, even with the right PIN", async () => {
    for (let i = 0; i < MAX_PIN_FAILURES_PER_CLIENT; i++) await requestAccess("secret", { pin: "000000" });
    const res = await requestAccess("secret", { pin: PIN });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("900");
    expect(exact(TooManyAttemptsSchema, await res.json()).retry_after_seconds).toBe(900);
    // Another client and the invite link still work.
    expect((await requestAccess("secret", { pin: PIN }, { "CF-Connecting-IP": "198.51.100.9" })).status).toBe(200);
    expect((await requestAccess("secret", { invite_token: "invite-abc" })).status).toBe(200);
  });

  it("shares the lockout with the web route", async () => {
    for (let i = 0; i < MAX_PIN_FAILURES_PER_CLIENT; i++) await requestAccess("secret", { pin: "000000" });
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const web = await worker.fetch(
      new Request("https://moments.test/api/events/secret/access", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ pin: PIN }),
      }),
      env(),
      ctx
    );
    expect(web.status).toBe(429);
  });

  it.each([{}, { pin: "   " }, { pin: "1".repeat(21) }, { invite_token: "x".repeat(201) }, { pin: 123456 }])(
    "rejects invalid body %j without recording a failure",
    async (body) => {
      const res = await requestAccess("secret", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid request", code: "invalid_request" });
      expect(failureCount()).toBe(0);
    }
  );

  it("fails closed with 503 when the signing secret is missing", async () => {
    extraEnv = { EVENT_ACCESS_SECRET: undefined };
    const res = await requestAccess("secret", { invite_token: "invite-abc" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "access_unavailable" });
  });

  it("returns 404 for unknown events and keeps other methods on the path gated", async () => {
    expect((await requestAccess("nope", { pin: PIN })).status).toBe(404);
    expect((await call("/events/secret/access")).status).toBe(401);
  });

  it("exempts only the exact access path from the gate", async () => {
    for (const path of ["/events/secret/feed/access", "/events/secret/x/events/y/access", "/events/secret/access/"]) {
      const res = await call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ code: "access_required" });
    }
  });

  it("marks gate errors as no-store", async () => {
    expect((await call("/events/secret/feed")).headers.get("Cache-Control")).toBe("no-store");
    expect((await requestAccess("nope", { pin: PIN })).headers.get("Cache-Control")).toBe("no-store");
  });

  it("accepts a padded PIN like the web route", async () => {
    expect((await requestAccess("secret", { pin: `   ${PIN}       ` })).status).toBe(200);
  });

  it("does not accept an invite token plus a wrong PIN as a PIN success", async () => {
    const res = await requestAccess("secret", { invite_token: "wrong", pin: "000000" });
    expect(res.status).toBe(401);
    expect(failureCount()).toBe(1);
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

describe("upload sessions", () => {
  const R2_ENV: Partial<Env> = {
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_S3_ENDPOINT: "https://r2.example.com",
    R2_BUCKET_NAME: "moments-media",
  };
  const CLIENT_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  let s3: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    extraEnv = { ...R2_ENV };
    let next = 0;
    s3 = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        return new Response(`<InitiateMultipartUploadResult><UploadId>mp-${++next}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (request.method === "GET" && url.searchParams.has("uploadId")) {
        return new Response(
          "<ListPartsResult><Part><PartNumber>2</PartNumber><ETag>\"b\"</ETag></Part><Part><PartNumber>1</PartNumber><ETag>\"a\"</ETag></Part></ListPartsResult>"
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", s3);
  });

  async function guestToken(slug = "party", nickname = "Sara"): Promise<string> {
    const body = (await (await join(slug, { nickname })).json()) as { guest_token: string };
    return body.guest_token;
  }

  function start(token: string | null, body: Record<string, unknown> = {}, slug = "party") {
    return call(`/events/${slug}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Guest-Token": token } : {}) },
      body: JSON.stringify({ client_upload_id: CLIENT_ID, content_type: "image/jpeg", size: 20 * 1024 * 1024, caption: "Cake", ...body }),
    });
  }

  const authed = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { "Content-Type": "application/json", "X-Guest-Token": token, ...(init.headers ?? {}) },
  });

  it("opens a session once and returns it again on retry", async () => {
    const token = await guestToken();
    const first = await start(token);
    expect(first.status).toBe(201);
    const session = exact(UploadSessionSchema, await first.json());
    expect(session).toMatchObject({ client_upload_id: CLIENT_ID, status: "open", part_count: 3, size: 20 * 1024 * 1024 });
    const again = await start(token);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(session.id);
    expect(s3.mock.calls.filter(([r]) => new URL((r as Request).url ?? String(r)).searchParams.has("uploads"))).toHaveLength(1);
    const row = sqlite.raw.prepare("SELECT caption, participant_id IS NOT NULL AS owned FROM uploads").get() as { caption: string; owned: number };
    expect(row).toEqual({ caption: "Cake", owned: 1 });
  });

  it("requires a joined guest", async () => {
    const res = await start(null);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "guest_required" });
    expect((await start("not-a-real-token")).status).toBe(403);
    expect(s3).not.toHaveBeenCalled();
  });

  it("maps invalid files, reused ids and closed events", async () => {
    const token = await guestToken();
    const bad = await start(token, { content_type: "application/zip" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_upload" });
    expect((await start(token, { client_upload_id: "nope" })).status).toBe(400);
    await start(token);
    const conflict = await start(token, { size: 99 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "upload_conflict" });
    sqlite.raw.prepare("UPDATE events SET uploads_close_at = datetime('now', '-1 minute') WHERE id = 'event-1'").run();
    const closed = await start(token, { client_upload_id: "00000000-0000-4000-8000-000000000001" });
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ code: "uploads_closed" });
  });

  it("is unavailable without R2 credentials", async () => {
    const token = await guestToken();
    extraEnv = {};
    const res = await start(token);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: "uploads_unavailable" });
  });

  it("reports R2 failures as storage_unavailable", async () => {
    const token = await guestToken();
    // A non-retried error (aws4fetch retries 5xx itself).
    s3.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const res = await start(token);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "storage_unavailable" });
  });

  it("signs every part for a day, or just the ones asked for", async () => {
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    const all = await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: "{}" }));
    expect(all.status).toBe(200);
    const body = exact(PartUrlsSchema, await all.json());
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    const url = new URL(body.parts[0].url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("21600");
    expect(url.searchParams.get("uploadId")).toBe("mp-1");
    const some = await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: JSON.stringify({ part_numbers: [3] }) }));
    expect(((await some.json()) as { parts: unknown[] }).parts).toHaveLength(1);
    const outside = await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: JSON.stringify({ part_numbers: [4] }) }));
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ code: "invalid_parts" });
  });

  it("reports which parts R2 already has", async () => {
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    const res = await call(`/events/party/uploads/${id}`, authed(token));
    expect(res.status).toBe(200);
    const status = exact(UploadStatusSchema, await res.json());
    expect(status.uploaded_parts).toEqual([1, 2]);
    expect(status.upload.id).toBe(id);
  });

  it("hides one guest's sessions from another, and from other events", async () => {
    seedEvent("event-2", "other");
    const sara = await guestToken("party", "Sara");
    const lea = await guestToken("party", "Lea");
    const otherEvent = await guestToken("other", "Sara");
    const { id } = (await (await start(sara)).json()) as { id: string };
    for (const [slug, token] of [["party", lea], ["other", otherEvent]] as const) {
      const status = await call(`/events/${slug}/uploads/${id}`, authed(token));
      expect(status.status).toBe(404);
      expect(await status.json()).toMatchObject({ code: "upload_not_found" });
      const parts = await call(`/events/${slug}/uploads/${id}/part-urls`, authed(token, { method: "POST", body: "{}" }));
      expect(parts.status).toBe(404);
    }
    // Same client id from another guest is a separate session.
    expect((await start(lea)).status).toBe(201);
  });

  it("stops signing once a session is closed or the finishing grace has passed", async () => {
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    sqlite.raw.prepare("UPDATE events SET uploads_close_at = datetime('now', '-10 minutes') WHERE id = 'event-1'").run();
    // Within the grace: still signs.
    expect((await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: "{}" }))).status).toBe(200);
    sqlite.raw.prepare("UPDATE events SET uploads_close_at = datetime('now', '-31 minutes') WHERE id = 'event-1'").run();
    const late = await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: "{}" }));
    expect(late.status).toBe(403);
    sqlite.raw.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").run(id);
    const aborted = await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: "{}" }));
    expect(aborted.status).toBe(409);
    expect(await aborted.json()).toMatchObject({ code: "upload_not_open" });
    const status = exact(UploadStatusSchema, await (await call(`/events/party/uploads/${id}`, authed(token))).json());
    expect(status).toMatchObject({ upload: { status: "aborted" }, uploaded_parts: [] });
  });

  it("recovers a session after uploads close, but opens no new one", async () => {
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    sqlite.raw.prepare("UPDATE events SET uploads_close_at = datetime('now', '-1 minute') WHERE id = 'event-1'").run();
    const retry = await start(token);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { id: string }).id).toBe(id);
    expect((await start(token, { client_upload_id: "00000000-0000-4000-8000-000000000002" })).status).toBe(403);
  });

  it("cancels a session idempotently and refuses its id afterwards", async () => {
    s3.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>mp-9</UploadId></InitiateMultipartUploadResult>");
      }
      if (request.method === "DELETE" && url.searchParams.get("uploadId") === "mp-9") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    const first = await call(`/events/party/uploads/${id}`, authed(token, { method: "DELETE" }));
    expect(first.status).toBe(200);
    expect(exact(UploadSessionSchema, await first.json()).status).toBe("aborted");
    expect((await call(`/events/party/uploads/${id}`, authed(token, { method: "DELETE" }))).status).toBe(200);
    const reused = await start(token);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "upload_not_open" });
    const lea = await guestToken("party", "Lea");
    expect((await call(`/events/party/uploads/${id}`, authed(lea, { method: "DELETE" }))).status).toBe(404);
  });

  it("rejects an empty part list and control characters in captions", async () => {
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    const empty = await call(`/events/party/uploads/${id}/part-urls`, authed(token, { method: "POST", body: JSON.stringify({ part_numbers: [] }) }));
    expect(empty.status).toBe(400);
    const caption = await start(token, { client_upload_id: "00000000-0000-4000-8000-000000000003", caption: "hi\u0007" });
    expect(caption.status).toBe(400);
    expect((await start(token, { client_upload_id: "00000000-0000-4000-8000-000000000004", caption: "line one\nline two" })).status).toBe(201);
  });

  it("logs R2 failures without the response body", async () => {
    const token = await guestToken();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    s3.mockResolvedValueOnce(
      new Response("<Error><Code>AccessDenied</Code><Key>events/event-1/moments/x-secret_name.jpg</Key></Error>", { status: 403 })
    );
    expect((await start(token, { filename: "secret name.jpg" })).status).toBe(502);
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("AccessDenied");
    expect(logged).not.toContain("secret");
    errors.mockRestore();
  });

  it("rate-limits the R2-backed session routes per guest", async () => {
    const token = await guestToken();
    const { id } = (await (await start(token)).json()) as { id: string };
    const limit = vi.fn().mockResolvedValue({ success: false });
    extraEnv = { ...R2_ENV, UPLOAD_LIMITER: { limit } };
    const res = await call(`/events/party/uploads/${id}`, authed(token));
    expect(res.status).toBe(429);
    expect(limit.mock.calls[0][0].key).toMatch(/^event-1:guest:/);
  });
});

