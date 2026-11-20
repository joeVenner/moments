import { beforeEach, describe, expect, it } from "vitest";
import {
  bearerToken,
  createHostSession,
  deleteHostSession,
  HOST_SESSION_TTL_DAYS,
  OPERATOR_USER_ID,
  resolveHostSession,
} from "./hostSessions";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

const ENV = { ADMIN_USER: "admin", ADMIN_PASSWORD: "correct horse", EVENT_ACCESS_SECRET: "test-secret-123" };
let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = createSqliteD1();
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

  it("belongs to the seeded operator user", async () => {
    const { session } = await createHostSession(sqlite.db, ENV, now);
    expect(session.userId).toBe(OPERATOR_USER_ID);
    expect(sqlite.raw.prepare("SELECT user_id FROM host_sessions").get()).toEqual({ user_id: OPERATOR_USER_ID });
    expect(sqlite.raw.prepare("SELECT role, status FROM users WHERE id = ?").get(OPERATOR_USER_ID)).toEqual({
      role: "operator",
      status: "active",
    });
  });

  it("stops working once its account is deleted", async () => {
    const { token } = await createHostSession(sqlite.db, ENV, now);
    sqlite.raw.prepare("UPDATE users SET status = 'deleted', deleted_at = '2026-11-20 00:00:00' WHERE id = ?").run(OPERATOR_USER_ID);
    expect(await resolveHostSession(sqlite.db, ENV, token, now)).toBeNull();
  });

  it("returns the session's own user, not the operator", async () => {
    const hostId = "6f1c2a0e-1b2c-4d3e-8f90-123456789abc";
    sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(hostId);
    const { token, session } = await createHostSession(sqlite.db, ENV, now);
    sqlite.raw.prepare("UPDATE host_sessions SET user_id = ?").run(hostId);
    expect(await resolveHostSession(sqlite.db, ENV, token, now)).toEqual({ ...session, userId: hostId, role: "host" });
  });

  it("refuses a session that belongs to no user (opened by code older than 0023)", async () => {
    const { token } = await createHostSession(sqlite.db, ENV, now);
    sqlite.raw.prepare("UPDATE host_sessions SET user_id = NULL").run();
    expect(await resolveHostSession(sqlite.db, ENV, token, now)).toBeNull();
  });

  it("refuses a session linked to a user that doesn't exist", async () => {
    await createHostSession(sqlite.db, ENV, now);
    expect(() => sqlite.raw.prepare("UPDATE host_sessions SET user_id = 'nobody'").run()).toThrow(/FOREIGN KEY/);
  });

  it("refuses an unknown role and a deletion without a date", () => {
    expect(() => sqlite.raw.prepare("INSERT INTO users (id, role) VALUES ('x', 'admin')").run()).toThrow(/CHECK/);
    expect(() =>
      sqlite.raw.prepare("UPDATE users SET status = 'deleted' WHERE id = ?").run(OPERATOR_USER_ID)
    ).toThrow(/CHECK/);
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
