import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest } from "./guestIdentity";
import worker from "./index";
import { bindReactor, gateReaction, setReaction } from "./reactions";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

let sqlite: SqliteD1;
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

async function join(nickname: string): Promise<{ token: string; sessionId: string }> {
  const result = await joinEventAsGuest(sqlite.db, {
    eventId: "ev1", nickname, avatarSeed: null, presentedToken: null, enforceClaims: true,
  });
  if (!result.ok || !result.guestToken) throw new Error("join failed");
  const row = sqlite.raw.prepare("SELECT id FROM guest_sessions WHERE participant_id = ?").get(result.participant.id) as { id: string };
  return { token: result.guestToken, sessionId: row.id };
}

const hearts = (momentId: string) =>
  (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moment_reactions WHERE moment_id = ?").get(momentId) as { n: number }).n;
const reactedAs = (momentId: string, reactorId: string) =>
  !!sqlite.raw.prepare("SELECT 1 FROM moment_reactions WHERE moment_id = ? AND reactor_id = ?").get(momentId, reactorId);

/** As the routes do: gate, then write. */
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

describe("reactor binding", () => {
  it("binds the session on its first heart", async () => {
    const sara = await join("Sara");
    await heart(sara.token, DEVICE_A);
    const row = sqlite.raw.prepare("SELECT reactor_id FROM guest_sessions WHERE id = ?").get(sara.sessionId) as { reactor_id: string };
    expect(row.reactor_id).toBe(DEVICE_A);
  });

  it("keeps one heart per session when the device id changes", async () => {
    const sara = await join("Sara");
    await heart(sara.token, DEVICE_A);
    await heart(sara.token, DEVICE_B);
    expect(hearts("m1")).toBe(1);
  });

  it("moves earlier hearts to the new id (a reinstall that kept the token)", async () => {
    const sara = await join("Sara");
    await heart(sara.token, DEVICE_A, "m1");
    await heart(sara.token, DEVICE_B, "m2");
    expect(reactedAs("m1", DEVICE_B)).toBe(true);
    expect(reactedAs("m1", DEVICE_A)).toBe(false);
    expect(hearts("m1") + hearts("m2")).toBe(2);
  });

  it("leaves other guests' hearts alone", async () => {
    const sara = await join("Sara");
    const lina = await join("Lina");
    await heart(sara.token, DEVICE_A);
    await heart(lina.token, "33333333-3333-4333-8333-333333333333");
    await heart(sara.token, DEVICE_B);
    expect(hearts("m1")).toBe(2);
  });

  it("only moves hearts within the event", async () => {
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev2', 'other', 'Other', 'party')").run();
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('x1', 'ev2', 'Sara', '/media/x1')").run();
    await setReaction(sqlite.db, { eventId: "ev2", momentId: "x1", reactorId: DEVICE_A, reacted: true });
    const sara = await join("Sara");
    await heart(sara.token, DEVICE_A);
    await heart(sara.token, DEVICE_B);
    expect(reactedAs("x1", DEVICE_A)).toBe(true);
  });

  it("never binds or moves an id another session holds", async () => {
    const sara = await join("Sara");
    const lina = await join("Lina");
    await heart(sara.token, DEVICE_A, "m1");
    // Lina's browser shares Sara's id (one browser, two joins): Lina stays unbound.
    await heart(lina.token, DEVICE_A, "m2");
    const bound = (id: string) =>
      (sqlite.raw.prepare("SELECT reactor_id FROM guest_sessions WHERE id = ?").get(id) as { reactor_id: string | null }).reactor_id;
    expect(bound(lina.sessionId)).toBeNull();
    // Lina presenting a new id binds it without carrying Sara's hearts along.
    await heart(lina.token, DEVICE_B, "m2");
    expect(bound(lina.sessionId)).toBe(DEVICE_B);
    expect(reactedAs("m1", DEVICE_A)).toBe(true);
    // Sara can't move onto Lina's id: her heart is written under her bound id.
    expect(await bindReactor(sqlite.db, { sessionId: sara.sessionId, eventId: "ev1", reactorId: DEVICE_B })).toBe(DEVICE_A);
    expect(bound(sara.sessionId)).toBe(DEVICE_A);
  });

  it("only moves hearts under the session's current id", async () => {
    const sara = await join("Sara");
    await heart(sara.token, DEVICE_A, "m1");
    // The session already moved from A to C; a later stray heart under A is not its own.
    const DEVICE_C = "44444444-4444-4444-8444-444444444444";
    await heart(sara.token, DEVICE_C, "m1");
    sqlite.raw.prepare("INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES ('stray', 'm2', 'ev1', ?)").run(DEVICE_A);
    expect(await bindReactor(sqlite.db, { sessionId: sara.sessionId, eventId: "ev1", reactorId: DEVICE_B })).toBe(DEVICE_B);
    expect(reactedAs("m2", DEVICE_A)).toBe(true); // not this session's id any more: untouched
    expect(reactedAs("m1", DEVICE_B)).toBe(true);
  });

  // In-process SQLite runs these one after the other; this checks the end state
  // (one bound id, one heart), the batch is what makes it hold on D1.
  it("ends with one binding and one heart after two first binds", async () => {
    const sara = await join("Sara");
    await Promise.all([
      bindReactor(sqlite.db, { sessionId: sara.sessionId, eventId: "ev1", reactorId: DEVICE_A }),
      bindReactor(sqlite.db, { sessionId: sara.sessionId, eventId: "ev1", reactorId: DEVICE_B }),
    ]);
    const row = sqlite.raw.prepare("SELECT reactor_id FROM guest_sessions WHERE id = ?").get(sara.sessionId) as { reactor_id: string };
    expect([DEVICE_A, DEVICE_B]).toContain(row.reactor_id);
    await heart(sara.token, DEVICE_A);
    await heart(sara.token, DEVICE_B);
    expect(hearts("m1")).toBe(1);
  });
});

describe("gateReaction", () => {
  it("lets tokenless hearts through until enforcement", async () => {
    expect(await heart(null, DEVICE_A)).toMatchObject({ reacted: true });
    expect(await heart(null, DEVICE_B, "m1", { GUEST_TOKENS_ENFORCED: "true" })).toMatchObject({ ok: false, status: 403 });
  });

  it("ignores an unknown token like no token", async () => {
    const result = await heart("gt_" + "a".repeat(43), DEVICE_A, "m1", { GUEST_TOKENS_ENFORCED: "true" });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rate-limits per guest session, else per IP", async () => {
    const sara = await join("Sara");
    const limit = vi.fn(async () => ({ success: false }));
    expect(await heart(sara.token, DEVICE_A, "m1", { REACTION_LIMITER: { limit } })).toMatchObject({ status: 429 });
    expect(limit).toHaveBeenCalledWith({ key: `ev1:guest:${sara.sessionId}` });
    await heart(null, DEVICE_A, "m1", { REACTION_LIMITER: { limit } });
    expect(limit).toHaveBeenLastCalledWith({ key: "ev1:ip:1.2.3.4" });
  });
});

describe("POST /api/events/:slug/moments/:id/reactions (web toggle)", () => {
  function toggle(body: unknown, token?: string, overrides: Record<string, unknown> = {}) {
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
    return worker.fetch(
      new Request("https://moments.test/api/events/party/moments/m1/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Guest-Token": token } : {}) },
        body: JSON.stringify(body),
      }),
      env as never,
      ctx
    );
  }

  it("refuses reactor ids outside the device-id shape", async () => {
    for (const reactor_id of ["guest:p1", "x", "a".repeat(101), 42]) {
      expect((await toggle({ reactor_id })).status).toBe(400);
    }
  });

  it("toggles, binding the guest's session when it sends its token", async () => {
    const sara = await join("Sara");
    const on = await toggle({ reactor_id: DEVICE_A }, sara.token);
    expect(await on.json()).toEqual({ reacted: true, reaction_count: 1 });
    // Another id under the same token can't add a second heart: it takes the first one over.
    const again = await toggle({ reactor_id: DEVICE_B }, sara.token);
    expect(await again.json()).toEqual({ reacted: false, reaction_count: 0 });
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
