import { beforeEach, describe, expect, it } from "vitest";
import {
  adminCredentialsMatch,
  attemptAdminLogin,
  MAX_ADMIN_FAILURES_PER_CLIENT,
  pruneAdminLoginFailures,
  MAX_ADMIN_FAILURES_TOTAL,
} from "./adminLogin";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

const ENV = { ADMIN_USER: "admin", ADMIN_PASSWORD: "correct horse", EVENT_ACCESS_SECRET: "test-secret-123" };
let sqlite: SqliteD1;

function attempt(password: string, clientIp = "198.51.100.4", env: typeof ENV | Record<string, string | undefined> = ENV) {
  return attemptAdminLogin(sqlite.db, env, { username: "admin", password, clientIp });
}

const rows = () => sqlite.raw.prepare("SELECT ip_hash, created_at FROM admin_login_failures").all() as { ip_hash: string }[];

beforeEach(() => {
  sqlite = createSqliteD1();
});

describe("adminCredentialsMatch", () => {
  it("accepts only the configured pair", async () => {
    expect(await adminCredentialsMatch(ENV, "admin", "correct horse")).toBe(true);
    expect(await adminCredentialsMatch(ENV, "admin", "correct horsE")).toBe(false);
    expect(await adminCredentialsMatch(ENV, "Admin", "correct horse")).toBe(false);
  });

  it("can't be fooled by moving the separator between username and password", async () => {
    const env = { ADMIN_USER: "ad", ADMIN_PASSWORD: "min\0x" };
    expect(await adminCredentialsMatch(env, "ad", "min\0x")).toBe(true);
    expect(await adminCredentialsMatch(env, "ad\0min", "x")).toBe(false);
  });

  it("never matches when the credentials aren't set", async () => {
    expect(await adminCredentialsMatch({ ADMIN_USER: "", ADMIN_PASSWORD: "" }, "", "")).toBe(false);
    expect(await adminCredentialsMatch({ ADMIN_USER: "admin" }, "admin", "")).toBe(false);
  });
});

describe("attemptAdminLogin", () => {
  it("records failures by a hash of the client, never the address", async () => {
    expect(await attempt("wrong", "198.51.100.4")).toBe("invalid");
    const [row] = rows();
    expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rows())).not.toContain("198.51.100.4");
  });

  it("also works without the secret (web dashboard before it is set)", async () => {
    const env = { ADMIN_USER: "admin", ADMIN_PASSWORD: "correct horse" };
    expect(await attempt("correct horse", "198.51.100.4", env)).toBe("ok");
    expect(await attempt("wrong", "198.51.100.4", env)).toBe("invalid");
    expect(rows()).toHaveLength(1);
  });

  it("locks one client at exactly its limit, for right and wrong alike", async () => {
    for (let index = 0; index < MAX_ADMIN_FAILURES_PER_CLIENT - 1; index++) {
      expect(await attempt(`guess-${index}`)).toBe("invalid");
    }
    // Nine failures: the tenth guess is still answered normally.
    expect(await attempt("correct horse")).toBe("ok");
    expect(await attempt("guess-9")).toBe("invalid");
    expect(await attempt("correct horse")).toBe("locked");
    expect(await attempt("still wrong")).toBe("locked");
    expect(await attempt("correct horse", "203.0.113.9")).toBe("ok");
  });

  it("writes nothing for a right password, locked or not", async () => {
    expect(await attempt("correct horse")).toBe("ok");
    expect(rows()).toHaveLength(0);
    for (let index = 0; index < MAX_ADMIN_FAILURES_PER_CLIENT; index++) await attempt(`guess-${index}`);
    expect(await attempt("correct horse")).toBe("locked");
    expect(rows()).toHaveLength(MAX_ADMIN_FAILURES_PER_CLIENT);
  });

  it("never lets one client add more than its own limit, so it can't lock everyone out", async () => {
    for (let index = 0; index < MAX_ADMIN_FAILURES_TOTAL + 5; index++) await attempt(`guess-${index}`);
    expect(rows()).toHaveLength(MAX_ADMIN_FAILURES_PER_CLIENT);
    expect(await attempt("correct horse", "203.0.113.9")).toBe("ok");
  });

  it("doesn't lock the host out when their own requests arrive together", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => attempt("correct horse")));
    expect(results.every((result) => result === "ok")).toBe(true);
  });

  it("counts a burst of wrong guesses against each other", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => attempt(`burst-${index}`)));
    expect(rows()).toHaveLength(MAX_ADMIN_FAILURES_PER_CLIENT);
    expect(results.filter((result) => result === "locked").length).toBeGreaterThanOrEqual(30 - MAX_ADMIN_FAILURES_PER_CLIENT);
  });

  it("locks everyone after too many failures in all", async () => {
    const insert = sqlite.raw.prepare("INSERT INTO admin_login_failures (id, ip_hash) VALUES (?, ?)");
    for (let index = 0; index < MAX_ADMIN_FAILURES_TOTAL; index++) insert.run(`f${index}`, `client-${index}`);
    expect(await attempt("correct horse", "203.0.113.9")).toBe("locked");
  });

  it("writes nothing while everyone is locked, so a wrong guess looks like a right one", async () => {
    const insert = sqlite.raw.prepare("INSERT INTO admin_login_failures (id, ip_hash) VALUES (?, ?)");
    for (let index = 0; index < MAX_ADMIN_FAILURES_TOTAL; index++) insert.run(`f${index}`, `client-${index}`);
    expect(await attempt("wrong", "203.0.113.9")).toBe("locked");
    expect(rows()).toHaveLength(MAX_ADMIN_FAILURES_TOTAL);
  });

  it("still answers when neither secret nor password is set", async () => {
    expect(await attempt("x", "198.51.100.4", { ADMIN_USER: "admin" })).toBe("invalid");
  });

  it("ignores failures older than the window, and the hourly job removes them", async () => {
    const insert = sqlite.raw.prepare(
      "INSERT INTO admin_login_failures (id, ip_hash, created_at) VALUES (?, ?, datetime('now', '-16 minutes'))"
    );
    for (let index = 0; index < MAX_ADMIN_FAILURES_TOTAL; index++) insert.run(`old${index}`, "client");
    expect(await attempt("correct horse")).toBe("ok");
    await pruneAdminLoginFailures(sqlite.db);
    expect(rows()).toHaveLength(0);
  });
});
