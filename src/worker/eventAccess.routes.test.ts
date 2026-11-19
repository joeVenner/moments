import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { hashEventPin, signAccessGrant } from "./eventAccess";
import type { Env, EventRow } from "./types";

const SECRET = "test-access-secret-123";
const PIN = "482913";
const PIN_SALT = "salt-for-tests";
const INVITE_TOKEN = "a".repeat(64);

interface FakeDbState {
  event: EventRow;
  clientFailures: number;
  eventFailures: number;
  insertedFailures: unknown[][];
  deletedFailures: unknown[][];
}

/** Minimal D1 stand-in that answers only the queries the access paths make. */
function makeDb(state: FakeDbState): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    first: async () => {
      if (sql.includes("FROM events")) return state.event;
      if (sql.includes("FROM access_failures")) {
        return { client_failures: state.clientFailures, event_failures: state.eventFailures };
      }
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => {
      if (sql.startsWith("INSERT INTO access_failures")) state.insertedFailures.push(args);
      if (sql.startsWith("DELETE FROM access_failures")) state.deletedFailures.push(args);
      return { success: true };
    },
  });
  // The admin login lockout batches its write and count; nothing recorded = no failures.
  const batch = vi.fn(async (statements: unknown[]) => statements.map(() => ({ meta: { changes: 0 }, results: [] })));
  return { prepare: vi.fn((sql: string) => statement(sql)), batch } as unknown as D1Database;
}

function makeEnv(state: FakeDbState, secret: string | null = SECRET): Env {
  return {
    DB: makeDb(state),
    BUCKET: { get: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EVENT_ACCESS_SECRET: secret ?? undefined,
  };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test${path}`, init), env, ctx);
}

function postAccess(env: Env, body: Record<string, string>): Promise<Response> {
  return call(env, "/api/events/party/access", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

let state: FakeDbState;

beforeEach(async () => {
  state = {
    event: {
      id: "event-1",
      slug: "party",
      title: "Party",
      type: "Party",
      main_characters: null,
      description: null,
      cover_image_url: null,
      created_at: "2026-11-01 00:00:00",
      starts_at: null,
      expires_at: null,
      uploads_close_at: null,
      purge_after: null,
      archived_at: null,
      access_mode: "private",
      access_pin_hash: await hashEventPin(PIN, PIN_SALT),
      access_pin_salt: PIN_SALT,
      invite_token: INVITE_TOKEN,
      access_version: 1,
    },
    clientFailures: 0,
    eventFailures: 0,
    insertedFailures: [],
    deletedFailures: [],
  };
});

describe("private event gate", () => {
  it("rejects requests with no credential on the event, middleware and media paths", async () => {
    const env = makeEnv(state);
    expect((await call(env, "/api/events/party")).status).toBe(401);
    expect((await call(env, "/api/events/party/moments")).status).toBe(401);
    const media = await call(env, "/media/events/event-1/moments/photo.jpg");
    expect(media.status).toBe(401);
    // Every /media answer forbids type sniffing (uploads are served with their declared type).
    expect(media.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("rejects a wrong credential", async () => {
    const env = makeEnv(state);
    const res = await call(env, "/api/events/party/moments", { headers: { "X-Event-Access": "nope" } });
    expect(res.status).toBe(401);
  });

  it("accepts a signed grant for the current access version", async () => {
    const env = makeEnv(state);
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-1",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await call(env, "/api/events/party", { headers: { "X-Event-Access": grant } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: Record<string, unknown> };
    expect(body.event).not.toHaveProperty("invite_token");
    expect(body.event).not.toHaveProperty("access_version");
  });

  it("revokes a grant once access_version is bumped", async () => {
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-1",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    state.event.access_version = 2;
    const res = await call(makeEnv(state), "/api/events/party", { headers: { "X-Event-Access": grant } });
    expect(res.status).toBe(401);
  });

  it("rejects a grant signed for another event", async () => {
    const grant = await signAccessGrant(SECRET, {
      eventId: "event-2",
      accessVersion: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await call(makeEnv(state), "/api/events/party", { headers: { "X-Event-Access": grant } });
    expect(res.status).toBe(401);
  });

  it("still accepts the legacy raw invite-token cookie at access_version 1 only", async () => {
    const cookie = `moments_access_event1=${INVITE_TOKEN}`;
    expect((await call(makeEnv(state), "/api/events/party", { headers: { Cookie: cookie } })).status).toBe(200);
    state.event.access_version = 2;
    expect((await call(makeEnv(state), "/api/events/party", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("route exemption", () => {
  it("does not exempt GET requests to the access path from the gate", async () => {
    expect((await call(makeEnv(state), "/api/events/party/access")).status).toBe(401);
  });
});

describe("POST /api/events/:slug/access", () => {
  it("returns a usable signed grant for the correct PIN", async () => {
    const env = makeEnv(state);
    const res = await postAccess(env, { pin: PIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unlocked: boolean; access_token: string; expires_at: string };
    expect(body.unlocked).toBe(true);
    expect(state.deletedFailures).toHaveLength(1);
    expect(body.access_token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(res.headers.get("Set-Cookie")).toContain(`moments_access_event1=${body.access_token}`);

    const follow = await call(env, "/api/events/party", { headers: { "X-Event-Access": body.access_token } });
    expect(follow.status).toBe(200);
  });

  it("records a failure for a wrong PIN", async () => {
    const res = await postAccess(makeEnv(state), { pin: "000000" });
    expect(res.status).toBe(401);
    expect(state.insertedFailures).toHaveLength(1);
    expect(JSON.stringify(state.insertedFailures)).not.toContain("203.0.113.7");
  });

  it("blocks a client after too many failures, even with the right PIN", async () => {
    // The fake count includes the attempt being made, as the real query does.
    state.clientFailures = 11;
    state.eventFailures = 11;
    const res = await postAccess(makeEnv(state), { pin: PIN });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("900");
  });

  it("never throttles the host's invite link", async () => {
    state.clientFailures = 50;
    state.eventFailures = 500;
    const res = await postAccess(makeEnv(state), { invite_token: INVITE_TOKEN });
    expect(res.status).toBe(200);
  });

  it("fails closed with 503 when the signing secret is missing", async () => {
    const res = await postAccess(makeEnv(state, null), { invite_token: INVITE_TOKEN });
    expect(res.status).toBe(503);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects an oversized PIN before hashing it", async () => {
    const res = await postAccess(makeEnv(state), { pin: "9".repeat(10_000) });
    expect(res.status).toBe(401);
    expect(state.insertedFailures).toHaveLength(0);
  });
});

describe("PATCH /api/admin/events/:id/access", () => {
  const adminHeaders = {
    "Content-Type": "application/json",
    Authorization: `Basic ${btoa("admin:secret")}`,
  };

  function patchAccess(env: Env, body: Record<string, string>): Promise<Response> {
    return call(env, "/api/admin/events/event-1/access", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify(body),
    });
  }

  it("rejects new PINs shorter than 6 characters", async () => {
    const res = await patchAccess(makeEnv(state), { mode: "private", pin: "1234" });
    expect(res.status).toBe(400);
  });

  it("accepts a 6-character PIN", async () => {
    const res = await patchAccess(makeEnv(state), { mode: "private", pin: "123456" });
    expect(res.status).toBe(200);
  });
});
