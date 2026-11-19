import { beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleChangeFrom, updateEventAccess, updateEventLifecycle } from "./eventSettings";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;
beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('e', 'party', 'Party', 'Party')").run();
});

const env = () => ({ DB: sqlite.db }) as unknown as Env;
const row = () =>
  sqlite.raw
    .prepare("SELECT access_mode, access_pin_hash, invite_token, access_version, expires_at, uploads_close_at, purge_after FROM events WHERE id = 'e'")
    .get() as Record<string, string | number | null>;

describe("updateEventAccess", () => {
  it("answers not_found for an unknown event", async () => {
    expect(await updateEventAccess(env(), "missing", { mode: "public" }, vi.fn())).toEqual({ kind: "not_found" });
  });

  it("refuses a PIN of the wrong length and private with no PIN", async () => {
    expect(await updateEventAccess(env(), "e", { mode: "private", pin: "12345" }, vi.fn())).toMatchObject({ kind: "invalid", field: "pin" });
    expect(await updateEventAccess(env(), "e", { mode: "private" }, vi.fn())).toEqual({
      kind: "invalid", field: "pin", error: "a PIN is required for private events",
    });
    expect(row().access_mode).toBe("public");
  });

  it("bumps the access version once per new PIN, even for saves at the same time", async () => {
    const before = row().access_version as number;
    await Promise.all([
      updateEventAccess(env(), "e", { mode: "private", pin: "111111" }, vi.fn()),
      updateEventAccess(env(), "e", { mode: "private", pin: "222222" }, vi.fn()),
    ]);
    expect(row().access_version).toBe(before + 2);
  });

  it("leaves Stream alone when it isn't configured", async () => {
    const waitUntil = vi.fn();
    await updateEventAccess(env(), "e", { mode: "private", pin: "111111" }, waitUntil);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("lifecycle dates", () => {
  it("parses only the fields sent and names the first bad one", () => {
    expect(lifecycleChangeFrom({ purge_after: null })).toEqual({ kind: "ok", change: { purgeAfter: null } });
    expect(lifecycleChangeFrom({ expires_at: "nope", purge_after: "nope" })).toEqual({ kind: "invalid", field: "expires_at" });
  });

  it("makes expires_at alone the single end date and keeps the other split date otherwise", async () => {
    sqlite.raw.prepare("UPDATE events SET uploads_close_at = '2099-01-01 00:00:00', purge_after = '2099-02-01 00:00:00' WHERE id = 'e'").run();
    await updateEventLifecycle(sqlite.db, "e", { expiresAt: "2099-03-01 00:00:00", purgeAfter: "2099-04-01 00:00:00" });
    expect(row()).toMatchObject({ uploads_close_at: "2099-01-01 00:00:00", purge_after: "2099-04-01 00:00:00" });
    await updateEventLifecycle(sqlite.db, "e", { expiresAt: "2099-03-01 00:00:00" });
    expect(row()).toMatchObject({ expires_at: "2099-03-01 00:00:00", uploads_close_at: null, purge_after: null });
  });

  it("refuses uploads closing after deletion and an unknown event", async () => {
    expect(await updateEventLifecycle(sqlite.db, "e", { uploadsCloseAt: "2099-02-01 00:00:00", purgeAfter: "2099-01-01 00:00:00" })).toMatchObject({
      kind: "invalid",
    });
    expect(await updateEventLifecycle(sqlite.db, "missing", { purgeAfter: null })).toEqual({ kind: "not_found" });
  });
});
