import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
  generateGuestToken,
  hashGuestToken,
  isWellFormedGuestToken,
  joinEventAsGuest,
  resolveGuestSession,
  type JoinInput,
} from "./guestIdentity";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;

function seedEvent(id: string, slug: string) {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type) VALUES (?, ?, ?, 'Party')")
    .run(id, slug, `Event ${slug}`);
}

function join(overrides: Partial<JoinInput> = {}) {
  return joinEventAsGuest(sqlite.db, {
    eventId: "event-1",
    nickname: "Sara",
    avatarSeed: "seed-a",
    presentedToken: null,
    enforceClaims: false,
    ...overrides,
  });
}

function count(sql: string, ...args: (string | number)[]): number {
  return Number((sqlite.raw.prepare(sql).get(...args) as { n: number }).n);
}

beforeEach(() => {
  sqlite = createSqliteD1();
  seedEvent("event-1", "party");
  seedEvent("event-2", "other");
});

describe("guest tokens", () => {
  it("generates unique, well-formed 256-bit tokens", () => {
    const first = generateGuestToken();
    expect(isWellFormedGuestToken(first)).toBe(true);
    expect(first).not.toBe(generateGuestToken());
    expect(isWellFormedGuestToken("gt_short")).toBe(false);
    expect(isWellFormedGuestToken(`xx_${"a".repeat(43)}`)).toBe(false);
  });

  it("stores only the token hash", async () => {
    const result = await join();
    if (!result.ok || !result.guestToken) throw new Error("expected a token");
    const stored = sqlite.raw.prepare("SELECT token_hash FROM guest_sessions").all() as { token_hash: string }[];
    expect(stored).toEqual([{ token_hash: await hashGuestToken(result.guestToken) }]);
    expect(JSON.stringify(stored)).not.toContain(result.guestToken);
  });
});

describe("joinEventAsGuest", () => {
  it("creates and claims a new nickname with a token", async () => {
    const result = await join();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.guestToken).toMatch(/^gt_/);
    expect(result.participant).toMatchObject({ nickname: "Sara", avatar_seed: "seed-a" });
    expect(result.participant.claimed_at).not.toBeNull();
  });

  it("returns the same participant and no new token when re-joining with its token", async () => {
    const first = await join();
    if (!first.ok) throw new Error("join failed");
    const again = await join({ presentedToken: first.guestToken, avatarSeed: "seed-b" });
    expect(again).toEqual({ ok: true, participant: first.participant, guestToken: null });
    expect(count("SELECT COUNT(*) AS n FROM guest_sessions")).toBe(1);
  });

  it("lets the first token-bearing join claim a legacy participant", async () => {
    sqlite.raw
      .prepare("INSERT INTO participants (id, event_id, nickname, avatar_seed) VALUES ('p-legacy', 'event-1', 'Sara', NULL)")
      .run();
    const result = await join({ enforceClaims: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.participant.id).toBe("p-legacy");
    expect(result.participant.avatar_seed).toBe("seed-a");
    expect(result.participant.claimed_at).not.toBeNull();
    expect(result.guestToken).toMatch(/^gt_/);
  });

  it("rejects a claimed nickname without its token when claims are enforced", async () => {
    await join();
    expect(await join({ enforceClaims: true })).toEqual({ ok: false, error: "nickname_taken" });
    const otherToken = await join({ nickname: "Omar" });
    if (!otherToken.ok) throw new Error("join failed");
    expect(await join({ enforceClaims: true, presentedToken: otherToken.guestToken })).toEqual({
      ok: false,
      error: "nickname_taken",
    });
  });

  it("still admits a claimed nickname before enforcement, but never mints it a token", async () => {
    const first = await join();
    const second = await join({ avatarSeed: "seed-b" });
    if (!first.ok || !second.ok) throw new Error("join failed");
    expect(second.participant.id).toBe(first.participant.id);
    expect(second.participant.avatar_seed).toBe("seed-a");
    expect(second.guestToken).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM guest_sessions")).toBe(1);
    // The first claimant's token still works and stays the only one.
    expect((await resolveGuestSession(sqlite.db, "event-1", first.guestToken))?.participant.id).toBe(first.participant.id);
  });

  it("issues a fresh token when a token holder joins under another nickname", async () => {
    const sara = await join();
    if (!sara.ok) throw new Error("join failed");
    const omar = await join({ nickname: "Omar", presentedToken: sara.guestToken });
    if (!omar.ok) throw new Error("join failed");
    expect(omar.participant.nickname).toBe("Omar");
    expect(omar.guestToken).toMatch(/^gt_/);
    expect(omar.guestToken).not.toBe(sara.guestToken);
  });

  it("lets exactly one of two racing joins claim a legacy nickname", async () => {
    sqlite.raw
      .prepare("INSERT INTO participants (id, event_id, nickname) VALUES ('p-legacy', 'event-1', 'Sara')")
      .run();
    const results = await Promise.all([join({ enforceClaims: true }), join({ enforceClaims: true })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "nickname_taken" }]);
    expect(count("SELECT COUNT(*) AS n FROM guest_sessions")).toBe(1);
  });

  it("scopes tokens to their event", async () => {
    const first = await join();
    if (!first.ok) throw new Error("join failed");
    expect(await resolveGuestSession(sqlite.db, "event-2", first.guestToken)).toBeNull();
    expect((await resolveGuestSession(sqlite.db, "event-1", first.guestToken))?.participant.id).toBe(first.participant.id);
  });

  it("ignores malformed and unknown tokens", async () => {
    expect(await resolveGuestSession(sqlite.db, "event-1", "garbage")).toBeNull();
    expect(await resolveGuestSession(sqlite.db, "event-1", generateGuestToken())).toBeNull();
    expect(await resolveGuestSession(sqlite.db, "event-1", null)).toBeNull();
  });

  it("deletes sessions when the participant is deleted", async () => {
    await join();
    sqlite.raw.prepare("DELETE FROM participants").run();
    expect(count("SELECT COUNT(*) AS n FROM guest_sessions")).toBe(0);
  });
});

describe("POST /api/events/:slug/participants", () => {
  function env(overrides: Partial<Env> = {}): Env {
    return {
      DB: sqlite.db,
      BUCKET: {} as R2Bucket,
      ASSETS: {} as Fetcher,
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "secret",
      ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ...overrides,
    };
  }

  function postJoin(target: Env, nickname: string, token?: string) {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const headers: Record<string, string> = { "CF-Connecting-IP": "203.0.113.9", ...(token ? { "X-Guest-Token": token } : {}) };
    return worker.fetch(
      new Request("https://moments.test/api/events/party/participants", {
        method: "POST",
        headers,
        body: new URLSearchParams({ nickname, avatar_seed: "seed-a" }),
      }),
      target,
      ctx
    );
  }

  it("rate limits joins per event and IP before creating anyone", async () => {
    const limit = vi.fn().mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true });
    const target = env({ JOIN_LIMITER: { limit } as unknown as RateLimit });
    const refused = await postJoin(target, "Sara");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    const first = await postJoin(target, "Sara");
    expect(first.status).toBe(200);
    const token = ((await first.json()) as { guest_token?: string }).guest_token ?? "";
    expect(token).toMatch(/^gt_/);
    limit.mockClear();
    limit.mockResolvedValue({ success: false });
    expect((await postJoin(target, "Sara", token)).status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
    expect((await postJoin(target, "Sam", token)).status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "event-1:ip:203.0.113.9" });
  });

  it("returns a guest token on first join and none when re-joining with it", async () => {
    const first = await postJoin(env(), "Sara");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { participant: { nickname: string }; guest_token: string };
    expect(body.participant.nickname).toBe("Sara");
    expect(body.guest_token).toMatch(/^gt_/);

    expect(body.participant).not.toHaveProperty("claimed_at");

    const again = (await (await postJoin(env(), "Sara", body.guest_token)).json()) as Record<string, unknown>;
    expect(again).not.toHaveProperty("guest_token");
    expect(again.participant).not.toHaveProperty("claimed_at");
  });

  it("answers 409 nickname_taken only when enforcement is on", async () => {
    await postJoin(env(), "Sara");
    expect((await postJoin(env(), "Sara")).status).toBe(200);
    const enforced = await postJoin(env({ GUEST_TOKENS_ENFORCED: "true" }), "Sara");
    expect(enforced.status).toBe(409);
    expect(await enforced.json()).toMatchObject({ code: "nickname_taken" });
  });

  it("rejects empty and oversized nicknames", async () => {
    expect((await postJoin(env(), "   ")).status).toBe(400);
    expect((await postJoin(env(), "x".repeat(61))).status).toBe(400);
  });
});
