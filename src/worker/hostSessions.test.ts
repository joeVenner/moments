import { beforeEach, describe, expect, it } from "vitest";
import {
  bearerToken,
  createHostSession,
  deleteHostSession,
  HOST_SESSION_TTL_DAYS,
  resolveHostSession,
  verifyHostCredentials,
} from "./hostSessions";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

const ENV = { ADMIN_USER: "admin", ADMIN_PASSWORD: "correct horse", EVENT_ACCESS_SECRET: "test-secret-123" };
let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = createSqliteD1();
});

describe("verifyHostCredentials", () => {
  it("accepts only the configured pair", async () => {
    expect(await verifyHostCredentials(ENV, "admin", "correct horse")).toBe(true);
    expect(await verifyHostCredentials(ENV, "admin", "correct horsE")).toBe(false);
    expect(await verifyHostCredentials(ENV, "Admin", "correct horse")).toBe(false);
    expect(await verifyHostCredentials(ENV, "", "")).toBe(false);
  });

  it("can't be fooled by moving the separator between username and password", async () => {
    const env = { ...ENV, ADMIN_USER: "ad", ADMIN_PASSWORD: "min\0x" };
    expect(await verifyHostCredentials(env, "ad", "min\0x")).toBe(true);
    expect(await verifyHostCredentials(env, "ad\0min", "x")).toBe(false);
  });

  it.each([
    ["no secret", { ...ENV, EVENT_ACCESS_SECRET: undefined }],
    ["no password", { ...ENV, ADMIN_PASSWORD: "" }],
    ["no user", { ...ENV, ADMIN_USER: "" }],
  ])("refuses everything with %s", async (_, env) => {
    expect(await verifyHostCredentials(env, env.ADMIN_USER ?? "", env.ADMIN_PASSWORD ?? "")).toBe(false);
  });
});

describe("host sessions", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  it("stores only a hash of the token and resolves it until expiry", async () => {
    const { token, session } = await createHostSession(sqlite.db, ENV, now);
    expect(token).toMatch(/^hs_[A-Za-z0-9_-]{43}$/);
    const row = sqlite.raw.prepare("SELECT * FROM host_sessions").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(token.slice(3));
    expect(row.subject).toBe("operator");
    expect(session.expiresAt).toBe("2026-12-19 12:00:00");

    expect(await resolveHostSession(sqlite.db, ENV, token, now)).toEqual(session);
    const justBefore = new Date(now.getTime() + HOST_SESSION_TTL_DAYS * 86_400_000 - 1000);
    expect(await resolveHostSession(sqlite.db, ENV, token, justBefore)).not.toBeNull();
    const atExpiry = new Date(now.getTime() + HOST_SESSION_TTL_DAYS * 86_400_000);
    expect(await resolveHostSession(sqlite.db, ENV, token, atExpiry)).toBeNull();
  });

  it("ends every session when the admin password or the secret changes", async () => {
    const { token } = await createHostSession(sqlite.db, ENV, now);
    expect(await resolveHostSession(sqlite.db, { ...ENV, ADMIN_PASSWORD: "new password" }, token, now)).toBeNull();
    expect(await resolveHostSession(sqlite.db, { ...ENV, ADMIN_USER: "root" }, token, now)).toBeNull();
    expect(await resolveHostSession(sqlite.db, { ...ENV, EVENT_ACCESS_SECRET: "rotated-secret" }, token, now)).toBeNull();
    expect(await resolveHostSession(sqlite.db, ENV, token, now)).not.toBeNull();
  });

  it("refuses unknown, malformed and signed-out tokens", async () => {
    const { token, session } = await createHostSession(sqlite.db, ENV, now);
    expect(await resolveHostSession(sqlite.db, ENV, `hs_${"A".repeat(43)}`, now)).toBeNull();
    expect(await resolveHostSession(sqlite.db, ENV, token.slice(0, -1), now)).toBeNull();
    expect(await resolveHostSession(sqlite.db, ENV, `${token} `, now)).toBeNull();
    await deleteHostSession(sqlite.db, session.id);
    expect(await resolveHostSession(sqlite.db, ENV, token, now)).toBeNull();
  });

  it("clears expired sessions on the next sign-in", async () => {
    await createHostSession(sqlite.db, ENV, now);
    const later = new Date(now.getTime() + (HOST_SESSION_TTL_DAYS + 1) * 86_400_000);
    await createHostSession(sqlite.db, ENV, later);
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM host_sessions").get()).toEqual({ n: 1 });
  });

  it("refuses to open a session when sign-in isn't configured", async () => {
    await expect(createHostSession(sqlite.db, { ...ENV, EVENT_ACCESS_SECRET: undefined }, now)).rejects.toThrow();
  });
});

describe("bearerToken", () => {
  it.each([
    ["Bearer hs_abc", "hs_abc"],
    ["bearer hs_abc", null],
    ["Bearer", null],
    ["Bearer  hs_abc", null],
    ["Basic YWRtaW46c2VjcmV0", null],
    [undefined, null],
  ])("%j -> %j", (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });
});
