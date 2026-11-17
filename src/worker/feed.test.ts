import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { clampLimit, getFeedChanges, getFeedPage, parseCursor } from "./feed";
import { cleanupEvent } from "./lifecycle";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;

function seedEvent(id: string, slug: string, accessMode = "public") {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, access_mode) VALUES (?, ?, ?, 'Party', ?)")
    .run(id, slug, `Event ${slug}`, accessMode);
}

function addMoment(id: string, eventId = "event-1") {
  sqlite.raw
    .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES (?, ?, 'Sara', ?)")
    .run(id, eventId, `/media/${id}.jpg`);
}

function run(sql: string, ...args: string[]) {
  sqlite.raw.prepare(sql).run(...args);
}

const page = (before: number | null = null, limit = 2) =>
  getFeedPage(sqlite.db, { eventId: "event-1", before, limit, reactorId: "" });
const changes = (since: number, limit = 200) =>
  getFeedChanges(sqlite.db, { eventId: "event-1", since, limit, reactorId: "" });

beforeEach(() => {
  sqlite = createSqliteD1();
  seedEvent("event-1", "party");
  seedEvent("event-2", "other");
});

describe("seq triggers", () => {
  it("numbers each event's moments independently, one counter step per insert", () => {
    addMoment("m1");
    addMoment("x1", "event-2");
    addMoment("m2");
    const rows = sqlite.raw.prepare("SELECT id, seq, change_seq FROM moments ORDER BY event_id, seq").all();
    expect(rows).toEqual([
      { id: "m1", seq: 1, change_seq: 1 },
      { id: "m2", seq: 2, change_seq: 2 },
      { id: "x1", seq: 1, change_seq: 1 },
    ]);
    expect(sqlite.raw.prepare("SELECT event_id, value FROM event_feed_counters ORDER BY event_id").all()).toEqual([
      { event_id: "event-1", value: 2 },
      { event_id: "event-2", value: 1 },
    ]);
  });

  it("bumps change_seq on hide and caption edits, but not on unrelated updates", () => {
    addMoment("m1");
    run("UPDATE moments SET points_awarded = 50 WHERE id = 'm1'");
    expect(sqlite.raw.prepare("SELECT change_seq FROM moments").get()).toEqual({ change_seq: 1 });
    run("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm1'");
    run("UPDATE moments SET caption = 'hello' WHERE id = 'm1'");
    expect(sqlite.raw.prepare("SELECT seq, change_seq FROM moments").get()).toEqual({ seq: 1, change_seq: 3 });
  });

  it("tombstones deleted moments", () => {
    addMoment("m1");
    run("DELETE FROM moments WHERE id = 'm1'");
    expect(sqlite.raw.prepare("SELECT * FROM moment_tombstones").all()).toEqual([
      { moment_id: "m1", event_id: "event-1", change_seq: 2 },
    ]);
  });
});

describe("migrations 0011-0012 backfill", () => {
  it("numbers existing moments per event in upload order and continues each counter", () => {
    sqlite = createSqliteD1({ stopBefore: "0011" });
    seedEvent("event-1", "party");
    seedEvent("event-2", "other");
    const insert = sqlite.raw.prepare(
      "INSERT INTO moments (id, event_id, uploader_name, media_url, created_at) VALUES (?, ?, 'Sara', '/x', ?)"
    );
    // Same-second uploads keep insertion order (rowid), not random UUID order.
    insert.run("zz-first", "event-1", "2026-11-01 10:00:00");
    insert.run("aa-second", "event-1", "2026-11-01 10:00:00");
    insert.run("late", "event-1", "2026-11-02 10:00:00");
    insert.run("other", "event-2", "2026-11-01 09:00:00");
    sqlite.applyRemainingMigrations();
    addMoment("new");
    expect(sqlite.raw.prepare("SELECT id, seq, change_seq FROM moments ORDER BY event_id, seq").all()).toEqual([
      { id: "zz-first", seq: 1, change_seq: 1 },
      { id: "aa-second", seq: 2, change_seq: 2 },
      { id: "late", seq: 3, change_seq: 3 },
      { id: "new", seq: 4, change_seq: 4 },
      { id: "other", seq: 1, change_seq: 1 },
    ]);
  });
});

describe("migration safety", () => {
  it("numbers uploads that land between the schema and backfill migrations", () => {
    sqlite = createSqliteD1({ stopBefore: "0012" });
    seedEvent("event-1", "party");
    addMoment("during-deploy");
    sqlite.applyRemainingMigrations();
    addMoment("after");
    expect(sqlite.raw.prepare("SELECT id, seq FROM moments ORDER BY seq").all()).toEqual([
      { id: "during-deploy", seq: 1 },
      { id: "after", seq: 2 },
    ]);
  });

  it("still deletes and moderates when an event's counter row is missing", () => {
    addMoment("m1");
    addMoment("m2");
    run("DELETE FROM event_feed_counters");
    run("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm1'");
    run("DELETE FROM moments WHERE id = 'm2'");
    expect(sqlite.raw.prepare("SELECT change_seq FROM moments WHERE id = 'm1'").get()).toEqual({ change_seq: 1 });
    expect(sqlite.raw.prepare("SELECT moment_id, change_seq FROM moment_tombstones").all()).toEqual([
      { moment_id: "m2", change_seq: 2 },
    ]);
  });
});

describe("getFeedPage", () => {
  it("pages newest first with a before cursor and stops at the oldest", async () => {
    ["m1", "m2", "m3"].forEach((id) => addMoment(id));
    const first = await page();
    expect(first.moments.map((m) => m.id)).toEqual(["m3", "m2"]);
    expect(first.next_before).toBe(2);
    expect(first.cursor).toBe(3);
    const second = await page(first.next_before);
    expect(second.moments.map((m) => m.id)).toEqual(["m1"]);
    expect(second.next_before).toBeNull();
  });

  it("attaches a media object and hides internal R2 keys", async () => {
    addMoment("m1");
    run("UPDATE moments SET width = 800, height = 600, thumb_key = 'events/event-1/thumbs/m1.jpg' WHERE id = 'm1'");
    const [moment] = (await page()).moments;
    expect(moment.media).toMatchObject({
      kind: "image",
      url: "/media/m1.jpg",
      thumb_url: "/media/events/event-1/thumbs/m1.jpg",
      width: 800,
      height: 600,
    });
    for (const raw of ["width", "height", "duration_ms", "blurhash", "thumb_key", "display_key", "poster_key"]) {
      expect(moment).not.toHaveProperty(raw);
    }
    const [upserted] = (await changes(0)).upserts;
    expect(upserted.media.thumb_url).toBe("/media/events/event-1/thumbs/m1.jpg");
    expect(upserted).not.toHaveProperty("thumb_key");
  });

  it("derives Stream playback URLs in the feed", async () => {
    const uid = "0123456789abcdef0123456789abcdef";
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type) VALUES ('v1', 'event-1', 'Sara', ?, 'video/mp4')")
      .run(`https://customer-abc.cloudflarestream.com/${uid}/iframe`);
    const [video] = (await page()).moments;
    expect(video.media).toMatchObject({
      kind: "video",
      hls_url: `https://customer-abc.cloudflarestream.com/${uid}/manifest/video.m3u8`,
    });
  });

  it("re-sends a synced moment when its thumbnail arrives", async () => {
    addMoment("m1");
    const { cursor } = await page();
    run("UPDATE moments SET thumb_key = 'events/event-1/thumbs/m1.jpg', width = 10, height = 10 WHERE id = 'm1'");
    const result = await changes(cursor);
    expect(result.upserts.map((m) => m.media.thumb_url)).toEqual(["/media/events/event-1/thumbs/m1.jpg"]);
    expect(await changes(result.cursor)).toMatchObject({ upserts: [], removed: [] });
  });

  it("treats before=0 as empty and a huge before as the newest page", async () => {
    addMoment("m1");
    expect((await page(0)).moments).toEqual([]);
    expect((await page(999_999)).moments.map((m) => m.id)).toEqual(["m1"]);
  });

  it("excludes hidden moments and other events, and never exposes moderation_status", async () => {
    addMoment("m1");
    addMoment("m2");
    addMoment("x1", "event-2");
    run("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm2'");
    const result = await page(null, 10);
    expect(result.moments.map((m) => m.id)).toEqual(["m1"]);
    expect(result.moments[0]).not.toHaveProperty("moderation_status");
  });
});

describe("getFeedChanges", () => {
  it("returns nothing new at the current cursor", async () => {
    addMoment("m1");
    const { cursor } = await page();
    expect(await changes(cursor)).toEqual({ upserts: [], removed: [], cursor, has_more: false });
  });

  it("reports new, hidden, re-shown and deleted moments after a cursor", async () => {
    addMoment("m1");
    addMoment("m2");
    const { cursor } = await page();
    addMoment("m3");
    run("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm1'");
    run("DELETE FROM moments WHERE id = 'm2'");
    const result = await changes(cursor);
    expect(result.upserts.map((m) => m.id)).toEqual(["m3"]);
    expect(result.removed).toEqual(["m1", "m2"]);
    expect(result.upserts[0]).not.toHaveProperty("moderation_status");

    run("UPDATE moments SET moderation_status = 'approved' WHERE id = 'm1'");
    const after = await changes(result.cursor);
    expect(after.upserts.map((m) => m.id)).toEqual(["m1"]);
    expect(after.removed).toEqual([]);
  });

  it("pages through changes across moments and tombstones without skipping any", async () => {
    ["m1", "m2", "m3", "m4"].forEach((id) => addMoment(id));
    run("DELETE FROM moments WHERE id = 'm2'");
    const seen: string[] = [];
    let since = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = await changes(since, 2);
      seen.push(...result.upserts.map((m) => `+${m.id}`), ...result.removed.map((id) => `-${id}`));
      since = result.cursor;
      if (!result.has_more) break;
    }
    expect(seen.sort()).toEqual(["+m1", "+m3", "+m4", "-m2"].sort());
  });

  it("returns has_more with the last returned change_seq as the cursor", async () => {
    ["m1", "m2", "m3"].forEach((id) => addMoment(id));
    const first = await changes(0, 2);
    expect(first).toMatchObject({ has_more: true, cursor: 2 });
    expect(first.upserts.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await changes(first.cursor, 2)).toMatchObject({ has_more: false, cursor: 3 });
  });

  it("coalesces several changes to one moment into its latest state", async () => {
    addMoment("m1");
    const { cursor } = await page();
    run("UPDATE moments SET moderation_status = 'hidden' WHERE id = 'm1'");
    run("UPDATE moments SET moderation_status = 'approved' WHERE id = 'm1'");
    run("UPDATE moments SET caption = 'new' WHERE id = 'm1'");
    const result = await changes(cursor);
    expect(result.removed).toEqual([]);
    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]).toMatchObject({ id: "m1", caption: "new" });
  });

  it("resyncs a cursor that is ahead of the event's counter", async () => {
    addMoment("m1");
    expect(await changes(999)).toEqual({ upserts: [], removed: [], cursor: 1, has_more: false });
  });

  it("ignores other events' changes", async () => {
    addMoment("m1");
    addMoment("x1", "event-2");
    const result = await changes(0);
    expect(result.upserts.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("lifecycle cleanup", () => {
  it("removes the event's moments and their tombstones but not other events'", async () => {
    addMoment("m1");
    addMoment("x1", "event-2");
    sqlite.raw.prepare("DELETE FROM moments WHERE id = 'x1'").run();
    const env = {
      DB: sqlite.db,
      BUCKET: { list: vi.fn().mockResolvedValue({ objects: [], truncated: false }), delete: vi.fn() },
    } as unknown as Env;
    await cleanupEvent(env, { id: "event-1" });
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moments WHERE event_id = 'event-1'").get()).toEqual({ n: 0 });
    expect(sqlite.raw.prepare("SELECT moment_id FROM moment_tombstones").all()).toEqual([{ moment_id: "x1" }]);
  });
});

describe("cursor parsing", () => {
  it.each([
    ["12", 12],
    ["0", 0],
    [undefined, null],
    ["-1", null],
    ["1.5", null],
    ["abc", null],
    ["9".repeat(16), null],
  ])("parseCursor(%j) = %j", (raw, expected) => {
    expect(parseCursor(raw)).toBe(expected);
  });

  it("clamps limits", () => {
    expect(clampLimit(undefined, 30, 100)).toBe(30);
    expect(clampLimit("0", 30, 100)).toBe(1);
    expect(clampLimit("5000", 30, 100)).toBe(100);
    expect(clampLimit("nope", 30, 100)).toBe(30);
  });
});

describe("web moment endpoints", () => {
  it("do not expose internal media columns", async () => {
    addMoment("m1");
    run("UPDATE moments SET thumb_key = 'events/event-1/thumbs/m1.jpg', blurhash = 'x' WHERE id = 'm1'");
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const env = {
      DB: sqlite.db,
      ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    } as unknown as Env;
    for (const path of ["/api/events/party/moments", "/api/events/party/highlights"]) {
      const res = await worker.fetch(new Request(`https://moments.test${path}`), env, ctx);
      const body = JSON.stringify(await res.json());
      expect(res.status).toBe(200);
      expect(body).toContain('"id":"m1"');
      expect(body).not.toContain("thumb_key");
      expect(body).not.toContain("blurhash");
    }
  });
});

describe("feed routes", () => {
  function env(): Env {
    return {
      DB: sqlite.db,
      BUCKET: {} as R2Bucket,
      ASSETS: {} as Fetcher,
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "secret",
      ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      EVENT_ACCESS_SECRET: "test-access-secret-123",
    };
  }

  function get(path: string) {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    return worker.fetch(new Request(`https://moments.test${path}`), env(), ctx);
  }

  it("serves the feed and changes with no-store caching", async () => {
    addMoment("m1");
    const feed = await get("/api/events/party/feed");
    expect(feed.status).toBe(200);
    expect(feed.headers.get("Cache-Control")).toBe("no-store");
    expect(((await feed.json()) as { moments: unknown[] }).moments).toHaveLength(1);
    expect((await get("/api/events/party/feed/changes?since=0")).status).toBe(200);
  });

  it("requires a valid since cursor", async () => {
    expect((await get("/api/events/party/feed/changes")).status).toBe(400);
    expect((await get("/api/events/party/feed/changes?since=-3")).status).toBe(400);
  });

  it("keeps private events behind the access gate", async () => {
    seedEvent("event-3", "secret", "private");
    expect((await get("/api/events/secret/feed")).status).toBe(401);
    expect((await get("/api/events/secret/feed/changes?since=0")).status).toBe(401);
  });

  it("returns 404 for unknown events", async () => {
    expect((await get("/api/events/nope/feed")).status).toBe(404);
  });
});
