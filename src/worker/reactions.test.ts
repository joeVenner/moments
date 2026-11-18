import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest } from "./guestIdentity";
import worker from "./index";
import { gateReaction, guestReactorId, REACTOR_ID_PATTERN, setReaction, viewerReactorId } from "./reactions";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

let sqlite: SqliteD1;
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

async function join(nickname: string): Promise<{ token: string; participantId: string }> {
  const result = await joinEventAsGuest(sqlite.db, {
    eventId: "ev1", nickname, avatarSeed: null, presentedToken: null, enforceClaims: true,
  });
  if (!result.ok || !result.guestToken) throw new Error("join failed");
  return { token: result.guestToken, participantId: result.participant.id };
}

const hearts = (momentId: string) =>
  (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moment_reactions WHERE moment_id = ?").get(momentId) as { n: number }).n;

/** As the routes do: gate, then write under the id the gate returns. */
async function heart(token: string | null, reactorId: string, momentId = "m1", env: Record<string, unknown> = {}) {
  const gate = await gateReaction({ DB: sqlite.db, ...env }, { eventId: "ev1", token, clientIp: "1.2.3.4", reactorId });
  if (!gate.ok) return gate;
  return setReaction(sqlite.db, { eventId: "ev1", momentId, reactorId: gate.reactorId, reacted: true });
}

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev1', 'party', 'Party', 'party')").run();
  for (const id of ["m1", "m2"]) {
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES (?, 'ev1', 'Sara', ?)").run(id, `/media/${id}`);
  }
});

describe("server-assigned reactors", () => {
  it("writes a guest's heart under their own id, whatever device id they send", async () => {
    const sara = await join("Sara");
    await heart(sara.token, DEVICE_A);
    await heart(sara.token, DEVICE_B);
    expect(hearts("m1")).toBe(1);
    const row = sqlite.raw.prepare("SELECT reactor_id FROM moment_reactions WHERE moment_id = 'm1'").get() as { reactor_id: string };
    expect(row.reactor_id).toBe(guestReactorId(sara.participantId));
  });

  it("keeps guests apart", async () => {
    const sara = await join("Sara");
    const lina = await join("Lina");
    await heart(sara.token, DEVICE_A);
    await heart(lina.token, DEVICE_A);
    expect(hearts("m1")).toBe(2);
  });

  it("uses an id clients can't send", () => {
    expect(REACTOR_ID_PATTERN.test(guestReactorId("11111111-1111-4111-8111-111111111111"))).toBe(false);
  });
});

describe("gateReaction", () => {
  it("lets tokenless hearts through until enforcement", async () => {
    expect(await heart(null, DEVICE_A)).toMatchObject({ reacted: true });
    expect(await heart(null, DEVICE_B, "m1", { GUEST_TOKENS_ENFORCED: "true" })).toMatchObject({ ok: false, status: 403 });
  });

  it("needs a client id only without a token", async () => {
    const sara = await join("Sara");
    const gate = (token: string | null, reactorId: string | undefined) =>
      gateReaction({ DB: sqlite.db }, { eventId: "ev1", token, clientIp: "1.2.3.4", reactorId });
    expect(await gate(sara.token, undefined)).toEqual({ ok: true, reactorId: guestReactorId(sara.participantId) });
    expect(await gate(null, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(await gate(null, "guest:p1")).toMatchObject({ ok: false, status: 400 });
  });

  it("ignores an unknown token like no token", async () => {
    const result = await heart("gt_" + "a".repeat(43), DEVICE_A, "m1", { GUEST_TOKENS_ENFORCED: "true" });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rate-limits per guest session, else per IP", async () => {
    const sara = await join("Sara");
    const limit = vi.fn(async () => ({ success: false }));
    expect(await heart(sara.token, DEVICE_A, "m1", { REACTION_LIMITER: { limit } })).toMatchObject({ status: 429 });
    expect(limit.mock.calls[0]).toEqual([{ key: expect.stringMatching(/^ev1:guest:/) }]);
    await heart(null, DEVICE_A, "m1", { REACTION_LIMITER: { limit } });
    expect(limit).toHaveBeenLastCalledWith({ key: "ev1:ip:1.2.3.4" });
  });
});

describe("viewerReactorId", () => {
  const view = (token: string | null, clientReactorId: string | undefined, enforced = false) =>
    viewerReactorId(
      { DB: sqlite.db, GUEST_TOKENS_ENFORCED: enforced ? "true" : undefined },
      { eventId: "ev1", token, clientReactorId }
    );

  it("is the token's guest, ignoring the client's id", async () => {
    const sara = await join("Sara");
    expect(await view(sara.token, DEVICE_A)).toBe(guestReactorId(sara.participantId));
  });

  it("is still the guest under enforcement", async () => {
    const sara = await join("Sara");
    expect(await view(sara.token, undefined, true)).toBe(guestReactorId(sara.participantId));
  });

  it("falls back to a well-formed client id only while tokenless guests are allowed", async () => {
    expect(await view(null, DEVICE_A)).toBe(DEVICE_A);
    expect(await view(null, DEVICE_A, true)).toBe("");
    // A client can't read as a guest by sending their id.
    expect(await view(null, "guest:p1")).toBe("");
  });
});

describe("web routes", () => {
  function call(path: string, init: RequestInit = {}, overrides: Record<string, unknown> = {}) {
    const env = {
      DB: sqlite.db,
      BUCKET: {} as R2Bucket,
      ASSETS: {} as Fetcher,
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "secret",
      ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ...overrides,
    };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    return worker.fetch(new Request(`https://moments.test${path}`, init), env as never, ctx);
  }
  const toggle = (body: unknown, token?: string, overrides: Record<string, unknown> = {}) =>
    call(
      "/api/events/party/moments/m1/reactions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Guest-Token": token } : {}) },
        body: JSON.stringify(body),
      },
      overrides
    );

  it("refuses reactor ids outside the device-id shape", async () => {
    for (const reactor_id of ["guest:p1", "x", "a".repeat(101), 42]) {
      expect((await toggle({ reactor_id })).status).toBe(400);
    }
  });

  it("toggles the guest's own heart, whichever device id comes along", async () => {
    const sara = await join("Sara");
    expect(await (await toggle({ reactor_id: DEVICE_A }, sara.token)).json()).toEqual({ reacted: true, reaction_count: 1 });
    expect(await (await toggle({ reactor_id: DEVICE_B }, sara.token)).json()).toEqual({ reacted: false, reaction_count: 0 });
  });

  it("lets a guest with a token omit reactor_id", async () => {
    const sara = await join("Sara");
    expect(await (await toggle({}, sara.token)).json()).toEqual({ reacted: true, reaction_count: 1 });
    expect((await toggle({})).status).toBe(400);
  });

  it("shows the guest's heart in the feed from the token", async () => {
    const sara = await join("Sara");
    await toggle({ reactor_id: DEVICE_A }, sara.token);
    const feed = await call(`/api/events/party/feed?reactor_id=${DEVICE_B}`, { headers: { "X-Guest-Token": sara.token } });
    const body = (await feed.json()) as { moments: { id: string; reacted: number | boolean }[] };
    expect(body.moments.find((m) => m.id === "m1")?.reacted).toBeTruthy();
    // Without the token, another device id sees no heart.
    const anonymous = (await (await call(`/api/events/party/feed?reactor_id=${DEVICE_B}`)).json()) as typeof body;
    expect(anonymous.moments.find((m) => m.id === "m1")?.reacted).toBeFalsy();
  });

  it("keeps per-guest reads out of shared caches", async () => {
    for (const path of ["/api/events/party/moments", "/api/events/party/highlights"]) {
      expect((await call(path)).headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("reports the guest's heart on the moments list and highlights from the token", async () => {
    const sara = await join("Sara");
    await toggle({}, sara.token);
    for (const path of ["/api/events/party/moments", "/api/events/party/highlights"]) {
      const body = (await (await call(`${path}?reactor_id=${DEVICE_B}`, { headers: { "X-Guest-Token": sara.token } })).json()) as {
        moments: { id: string; reacted: number | boolean }[];
      };
      expect(body.moments.find((m) => m.id === "m1")?.reacted).toBeTruthy();
    }
  });

  it("no longer keeps a device id on guest sessions (0019)", () => {
    const columns = sqlite.raw.prepare("PRAGMA table_info(guest_sessions)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("reactor_id");
  });

  it("requires a guest only when enforcement is on", async () => {
    expect((await toggle({ reactor_id: DEVICE_A })).status).toBe(200);
    const refused = await toggle({ reactor_id: DEVICE_B }, undefined, { GUEST_TOKENS_ENFORCED: "true" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "guest_required" });
  });

  it("rate-limits the toggle", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    expect((await toggle({ reactor_id: DEVICE_A }, undefined, { REACTION_LIMITER: { limit } })).status).toBe(429);
  });
});
