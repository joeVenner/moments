import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./sqliteD1";

let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('event-1', 'party', 'Party', 'Party')").run();
});

function count(sql: string): number {
  return Number((sqlite.raw.prepare(sql).get() as { n: number }).n);
}

describe("sqlite D1 test adapter", () => {
  it("rolls back a whole batch when one statement fails, like D1", async () => {
    const insert = (id: string) =>
      sqlite.db.prepare("INSERT INTO participants (id, event_id, nickname) VALUES (?, 'event-1', ?)").bind(id, id);
    await expect(sqlite.db.batch([insert("a"), insert("a")])).rejects.toThrow();
    expect(count("SELECT COUNT(*) AS n FROM participants")).toBe(0);
  });

  it("rejects undefined bindings, like D1", () => {
    expect(() => sqlite.db.prepare("SELECT ?").bind(undefined)).toThrow(/D1_TYPE_ERROR/);
  });
});
