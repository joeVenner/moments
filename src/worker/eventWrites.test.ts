import { beforeEach, describe, expect, it } from "vitest";
import { insertEvent, normalizeDate, updateEventDetails } from "./eventWrites";
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
