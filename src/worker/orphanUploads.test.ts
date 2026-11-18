import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupEvent } from "./lifecycle";
import { cleanupExpiredEvents } from "./lifecycle";
import {
  abortEventUploads,
  abortOrphanUploads,
  EVENT_ABORT_BATCH,
  findOrphanUploads,
  ORPHAN_ABORT_BATCH,
} from "./orphanUploads";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;
let r2Configured: boolean;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...(r2Configured
      ? {
          R2_ACCESS_KEY_ID: "test-key",
          R2_SECRET_ACCESS_KEY: "test-secret",
          R2_S3_ENDPOINT: "https://r2.example.com",
          R2_BUCKET_NAME: "moments-media",
        }
      : {}),
  };
}

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

function seedEvent(id: string, dates: { uploads_close_at?: string } = {}) {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, uploads_close_at) VALUES (?, ?, 'E', 'Party', ?)")
    .run(id, id, dates.uploads_close_at ?? null);
}

function seedUpload(
  id: string,
  eventId: string,
  createdHoursAgo: number,
  status = "open",
  key = `events/${eventId}/moments/${id}-a.jpg`,
  uploadId = `mpu-${id}`
) {
  sqlite.raw
    .prepare(
      "INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, created_at) VALUES (?, ?, 'Sara', ?, ?, 10, ?, ?)"
    )
    .run(id, eventId, key, uploadId, status, ago(createdHoursAgo));
}

const status = (id: string) =>
  (sqlite.raw.prepare("SELECT status FROM uploads WHERE id = ?").get(id) as { status: string } | undefined)?.status;

beforeEach(() => {
  sqlite = createSqliteD1();
  r2Configured = true;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("findOrphanUploads", () => {
  it("picks abandoned and closed-event sessions only", async () => {
    seedEvent("live");
    seedEvent("closed", { uploads_close_at: ago(1) });
    seedEvent("closing", { uploads_close_at: ago(0.25) });
    seedUpload("fresh", "live", 1);
    seedUpload("paused-2-days", "live", 48);
    seedUpload("stale", "live", 7 * 24 + 1);
    seedUpload("done", "live", 400, "completed");
    seedUpload("on-closed", "closed", 2);
    seedUpload("in-grace", "closing", 1);

    const ids = (await findOrphanUploads(sqlite.db, 10)).map((row) => row.id).sort();
    expect(ids).toEqual(["on-closed", "stale"]);
  });

  it("does not let permanently failing rows starve the rest", async () => {
    seedEvent("live");
    for (let index = 0; index < 6; index++) seedUpload(`u${index}`, "live", 200);
    const seen = new Set<string>();
    for (let run = 0; run < 20; run++) {
      for (const row of await findOrphanUploads(sqlite.db, 2)) seen.add(row.id);
    }
    expect(seen.size).toBe(6);
  });

  it("never picks Stream rows, foreign keys or empty upload ids", async () => {
    seedEvent("live");
    seedEvent("other");
    seedUpload("stream-session", "live", 200, "open", "stream-session/abc");
    seedUpload("stream", "live", 200, "open", "stream/0123456789abcdef0123456789abcdef");
    seedUpload("foreign", "live", 200, "open", "events/other/moments/x-a.jpg");
    seedUpload("cover", "live", 200, "open", "events/live/cover");
    seedUpload("no-id", "live", 200, "open", undefined, "");
    seedUpload("real", "live", 200);
    expect((await findOrphanUploads(sqlite.db, 10)).map((row) => row.id)).toEqual(["real"]);
    const abort = vi.fn(async () => undefined);
    expect(await abortEventUploads(env(), "live", abort)).toEqual({ aborted: 1, failed: 0 });
  });

  it("respects the batch limit", async () => {
    seedEvent("live");
    for (let index = 0; index < 3; index++) seedUpload(`u${index}`, "live", 200 + index);
    expect(await findOrphanUploads(sqlite.db, 2)).toHaveLength(2);
    expect(ORPHAN_ABORT_BATCH).toBeLessThanOrEqual(50);
  });
});

describe("abortOrphanUploads", () => {
  beforeEach(() => {
    seedEvent("live");
    seedUpload("a", "live", 200);
    seedUpload("b", "live", 201);
    seedUpload("keep", "live", 1);
  });

  it("aborts in R2 and marks the rows aborted", async () => {
    const abort = vi.fn(async () => undefined);
    expect(await abortOrphanUploads(env(), abort)).toEqual({ aborted: 2, failed: 0 });
    expect(abort).toHaveBeenCalledWith(expect.anything(), "events/live/moments/a-a.jpg", "mpu-a");
    expect([status("a"), status("b"), status("keep")]).toEqual(["aborted", "aborted", "open"]);
  });

  it("leaves failed aborts open for the next run and logs no keys", async () => {
    const abort = vi.fn(async (_env: Env, key: string) => {
      if (key.includes("/a-")) throw new Error("R2 500 for events/live/moments/a-a.jpg");
    });
    expect(await abortOrphanUploads(env(), abort)).toEqual({ aborted: 1, failed: 1 });
    expect([status("a"), status("b")]).toEqual(["open", "aborted"]);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("orphan_abort_failed");
    expect(logged).not.toContain("a-a.jpg");
  });

  it("does nothing when R2 is not configured", async () => {
    r2Configured = false;
    const abort = vi.fn(async () => undefined);
    expect(await abortOrphanUploads(env(), abort)).toEqual({ aborted: 0, failed: 0 });
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("event cleanup", () => {
  it("aborts the event's open sessions before deleting its rows", async () => {
    seedEvent("ev");
    seedEvent("other");
    seedUpload("open", "ev", 1);
    seedUpload("done", "ev", 1, "completed");
    seedUpload("elsewhere", "other", 1);
    const abort = vi.fn(async () => undefined);

    await cleanupEvent(env(), { id: "ev" }, abort);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(expect.anything(), "events/ev/moments/open-a.jpg", "mpu-open");
    expect(status("open")).toBeUndefined();
    expect(status("elsewhere")).toBe("open");
  });

  it("still purges when an abort fails, keeping the session (without guest data) for the sweeper", async () => {
    seedEvent("ev", { uploads_close_at: ago(48) });
    seedUpload("open", "ev", 1);
    sqlite.raw.prepare("UPDATE uploads SET caption = 'Cake', participant_id = 'p1' WHERE id = 'open'").run();
    await cleanupEvent(env(), { id: "ev" }, vi.fn(async () => Promise.reject(new Error("down"))));
    expect(sqlite.raw.prepare("SELECT archived_at IS NOT NULL AS gone FROM events WHERE id = 'ev'").get()).toEqual({ gone: 1 });
    expect(sqlite.raw.prepare("SELECT status, uploader_name, caption, participant_id FROM uploads WHERE id = 'open'").get()).toEqual({
      status: "open",
      uploader_name: "",
      caption: null,
      participant_id: null,
    });

    // The next sweep aborts it and drops the row.
    sqlite.raw.prepare("UPDATE events SET purge_after = ? WHERE id = 'ev'").run(ago(1));
    const abort = vi.fn(async () => undefined);
    await abortOrphanUploads(env(), abort);
    expect(abort).toHaveBeenCalledWith(expect.anything(), "events/ev/moments/open-a.jpg", "mpu-open");
    expect(status("open")).toBeUndefined();
  });

  it("keeps aborted rows of events that are only archived, not purged", async () => {
    seedEvent("ev");
    seedUpload("old", "ev", 1, "aborted");
    sqlite.raw.prepare("UPDATE events SET archived_at = datetime('now'), purge_after = datetime('now', '+30 days') WHERE id = 'ev'").run();
    await abortOrphanUploads(env(), vi.fn(async () => undefined));
    expect(status("old")).toBe("aborted");
  });

  it("caps the aborts per event", async () => {
    seedEvent("ev");
    for (let index = 0; index < EVENT_ABORT_BATCH + 5; index++) seedUpload(`u${index}`, "ev", 1);
    const abort = vi.fn(async () => undefined);
    await cleanupEvent(env(), { id: "ev" }, abort);
    expect(abort).toHaveBeenCalledTimes(EVENT_ABORT_BATCH);
  });

  it("still purges when the abort step itself throws", async () => {
    seedEvent("ev");
    seedUpload("open", "ev", 1);
    const broken = env();
    broken.DB = new Proxy(sqlite.db, {
      get(target, property, receiver) {
        // The abort step's SELECT fails; the purge's own queries still work.
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("u.upload_id <> ''")) throw new Error("D1 overloaded");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const abort = vi.fn(async () => {
      throw new Error("Too many subrequests");
    });
    await cleanupEvent(broken, { id: "ev" }, abort);
    expect(sqlite.raw.prepare("SELECT archived_at IS NOT NULL AS gone FROM events WHERE id = 'ev'").get()).toEqual({ gone: 1 });
    expect(status("open")).toBe("open");
  });

  it("keeps purging other expired events when one fails", async () => {
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, expires_at) VALUES ('a', 'a', 'A', 'Party', ?), ('b', 'b', 'B', 'Party', ?)").run(ago(2), ago(1));
    const failing = env();
    let calls = 0;
    failing.BUCKET = {
      list: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("R2 down");
        return { objects: [], truncated: false };
      }),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket;
    expect(await cleanupExpiredEvents(failing)).toBe(1);
    const archived = sqlite.raw.prepare("SELECT id FROM events WHERE archived_at IS NOT NULL").all() as { id: string }[];
    expect(archived).toHaveLength(1);
  });

  it("aborts only open sessions of that event", async () => {
    seedEvent("ev");
    seedUpload("open", "ev", 1);
    seedUpload("aborted", "ev", 1, "aborted");
    const abort = vi.fn(async () => undefined);
    expect(await abortEventUploads(env(), "ev", abort)).toEqual({ aborted: 1, failed: 0 });
  });
});
