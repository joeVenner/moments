import { beforeEach, describe, expect, it } from "vitest";
import { insertEvent, insertPlanEvent, normalizeDate, updateEventDetails } from "./eventWrites";
import { addDays, startPlan } from "./plans";
import { insertPlan } from "./plansRepo";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import { OPERATOR_USER_ID } from "./hostSessions";

let sqlite: SqliteD1;
beforeEach(() => {
  sqlite = createSqliteD1();
});

const newEvent = {
  title: "Party",
  type: "Party",
  mainCharacters: null,
  description: null,
  coverImageUrl: null,
  startsAt: null,
  expiresAt: null,
  ownerUserId: OPERATOR_USER_ID,
};

describe("event writes", () => {
  it("creates a public event with no PIN or invite", async () => {
    const id = await insertEvent(sqlite.db, newEvent);
    expect(sqlite.raw.prepare("SELECT slug, access_mode, access_pin_hash, invite_token FROM events WHERE id = ?").get(id)).toEqual({
      slug: "party", access_mode: "public", access_pin_hash: null, invite_token: null,
    });
  });

  it("takes another slug when a concurrent create won the first one", async () => {
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('other', 'party', 'Party', 'Party')").run();
    // The slug check runs before the other create's insert lands: it sees nothing.
    const blindDb = {
      prepare: (sql: string) =>
        sql.startsWith("SELECT id FROM events WHERE slug")
          ? { bind: (slug: string) => ({ first: async () => (slug === "party" ? null : sqlite.db.prepare(sql).bind(slug).first()) }) }
          : sqlite.db.prepare(sql),
    } as unknown as D1Database;
    const id = await insertEvent(blindDb, newEvent);
    const row = sqlite.raw.prepare("SELECT slug FROM events WHERE id = ?").get(id) as { slug: string };
    expect(row.slug).toMatch(/^party-/);
  });

  it("retries a plan event on a taken slug without spending a second allowance", async () => {
    const host = "aaaaaaaa-0000-4000-8000-000000000001";
    sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(host);
    const { id: planId } = await insertPlan(sqlite.db, host, startPlan("host_50", new Date(), addDays(new Date(), 30)));
    sqlite.raw
      .prepare("INSERT INTO event_allowances (id, plan_id, kind, source, transaction_id) VALUES ('x1', ?, 'main', 'addon', 'txn-1')")
      .run(planId);
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('other', 'party', 'Party', 'Party')").run();
    const blindDb = {
      prepare: (sql: string) =>
        sql.startsWith("SELECT id FROM events WHERE slug")
          ? { bind: (slug: string) => ({ first: async () => (slug === "party" ? null : sqlite.db.prepare(sql).bind(slug).first()) }) }
          : sqlite.db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => sqlite.db.batch(statements),
    } as unknown as D1Database;
    const id = await insertPlanEvent(blindDb, { ...newEvent, ownerUserId: host }, planId);
    expect(id).not.toBeNull();
    expect(sqlite.raw.prepare("SELECT slug FROM events WHERE id = ?").get(id)).toEqual({ slug: expect.stringMatching(/^party-/) });
    // The failed first try rolled back: exactly one allowance used, the included one.
    expect(sqlite.raw.prepare("SELECT id, source FROM event_allowances WHERE consumed_event_id IS NOT NULL").all()).toEqual([
      { id: expect.any(String), source: "included" },
    ]);
  });

  it("updates only the given fields and reports a missing event", async () => {
    const id = await insertEvent(sqlite.db, { ...newEvent, description: "Keep" });
    expect(await updateEventDetails(sqlite.db, id, { title: "Renamed", mainCharacters: null })).toBe(true);
    expect(sqlite.raw.prepare("SELECT title, slug, description FROM events WHERE id = ?").get(id)).toEqual({
      title: "Renamed", slug: "party", description: "Keep",
    });
    expect(await updateEventDetails(sqlite.db, id, {})).toBe(true);
    expect(await updateEventDetails(sqlite.db, "missing", { title: "x" })).toBe(false);
    expect(await updateEventDetails(sqlite.db, "missing", {})).toBe(false);
  });

  it("normalizes dates to UTC and refuses ones outside 2000-2100", () => {
    expect(normalizeDate("2026-12-05T18:00:00+01:00")).toBe("2026-12-05 17:00:00");
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("1999-12-31T23:00:00Z")).toBeUndefined();
    expect(normalizeDate(42)).toBeUndefined();
  });
});
