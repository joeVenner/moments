import { beforeEach, describe, expect, it } from "vitest";
import { getEventStats } from "./eventStats";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

let sqlite: SqliteD1;

function run(sql: string, ...args: string[]) {
  sqlite.raw.prepare(sql).run(...args);
}

function addMoment(id: string, eventId = "event-1", status = "approved") {
  run(
    "INSERT INTO moments (id, event_id, uploader_name, media_url, moderation_status) VALUES (?, ?, 'Sara', ?, ?)",
    id, eventId, `/media/${id}.jpg`, status,
  );
}

function addGuest(id: string, eventId = "event-1") {
  run("INSERT INTO participants (id, event_id, nickname) VALUES (?, ?, ?)", id, eventId, `guest-${id}`);
}

beforeEach(() => {
  sqlite = createSqliteD1();
  for (const [id, slug] of [["event-1", "party"], ["event-2", "other"]]) {
    run("INSERT INTO events (id, slug, title, type) VALUES (?, ?, 'E', 'Party')", id, slug);
  }
});

describe("getEventStats", () => {
  it("counts only moments guests can see and only this event's guests", async () => {
    addMoment("m1");
    addMoment("m2");
    addMoment("gone", "event-1", "hidden");
    addMoment("x1", "event-2");
    addGuest("g1");
    addGuest("g2");
    addGuest("g3", "event-2");
    expect(await getEventStats(sqlite.db, "event-1")).toEqual({ moment_count: 2, guest_count: 2 });
  });

  it("is zero for an empty event", async () => {
    expect(await getEventStats(sqlite.db, "event-2")).toEqual({ moment_count: 0, guest_count: 0 });
  });
});
