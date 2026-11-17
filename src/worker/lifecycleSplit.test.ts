import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { areUploadsOpen, canFinishUploads } from "./events";
import { cleanupExpiredEvents } from "./lifecycle";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;
const PAST = "2020-01-01 00:00:00";
const FUTURE = "2999-01-01 00:00:00";

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
    EVENT_ACCESS_SECRET: "test-access-secret-123",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_S3_ENDPOINT: "https://r2.example.com",
    R2_BUCKET_NAME: "moments-media",
    STREAM_ACCOUNT_ID: "acct",
    STREAM_API_TOKEN: "token",
    STREAM_CUSTOMER_CODE: "abc",
  };
}

function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test${path}`, init), env(), ctx);
}

const json = (body: unknown, method = "POST", headers: Record<string, string> = {}) => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const admin = { Authorization: `Basic ${btoa("admin:secret")}` };

function seed(dates: { expires_at?: string | null; uploads_close_at?: string | null; purge_after?: string | null }) {
  sqlite.raw
    .prepare(
      "INSERT INTO events (id, slug, title, type, expires_at, uploads_close_at, purge_after) VALUES ('ev', 'party', 'P', 'Party', ?, ?, ?)"
    )
    .run(dates.expires_at ?? null, dates.uploads_close_at ?? null, dates.purge_after ?? null);
}

const archived = () =>
  (sqlite.raw.prepare("SELECT archived_at FROM events WHERE id = 'ev'").get() as { archived_at: string | null }).archived_at;

beforeEach(() => {
  sqlite = createSqliteD1();
});

describe("areUploadsOpen", () => {
  it("falls back to expires_at and treats null as open", () => {
    const now = "2026-11-17 12:00:00";
    expect(areUploadsOpen({ uploads_close_at: null, expires_at: null }, now)).toBe(true);
    expect(areUploadsOpen({ uploads_close_at: null, expires_at: "2026-11-17 11:59:59" }, now)).toBe(false);
    expect(areUploadsOpen({ uploads_close_at: "2026-11-18 00:00:00", expires_at: PAST }, now)).toBe(true);
    expect(areUploadsOpen({ uploads_close_at: "2026-11-17 12:00:00", expires_at: null }, now)).toBe(false);
  });
});

describe("canFinishUploads", () => {
  it("allows a 30 minute grace after the close", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(canFinishUploads({ uploads_close_at: "2026-11-17 11:40:00", expires_at: null }, now)).toBe(true);
    expect(canFinishUploads({ uploads_close_at: "2026-11-17 11:20:00", expires_at: null }, now)).toBe(false);
    expect(canFinishUploads({ uploads_close_at: null, expires_at: null }, now)).toBe(true);
  });
});

describe("in-flight uploads after the close", () => {
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const routes = [
    "/api/events/party/moments/multipart/part-url",
    "/api/events/party/moments/multipart/complete",
    "/api/events/party/moments/stream/tus",
    "/api/events/party/moments/stream/complete",
  ];

  it.each(routes)("%s is closed once the grace has passed", async (path) => {
    seed({ uploads_close_at: minutesAgo(31), purge_after: FUTURE });
    const res = await call(path, json({ upload_id: "u1", part_number: 1, uid: "abc" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "uploads_closed" });
  });

  it.each(routes)("%s may still finish within the grace", async (path) => {
    seed({ uploads_close_at: minutesAgo(5), purge_after: FUTURE });
    const res = await call(path, json({ upload_id: "u1", part_number: 1, uid: "abc" }));
    // Past the close gate: the route rejects the dummy body instead.
    expect([400, 412]).toContain(res.status);
  });
});

describe("legacy events (expires_at only)", () => {
  it("disappear and are purged at expires_at, as before", async () => {
    seed({ expires_at: PAST });
    expect((await call("/api/events/party")).status).toBe(404);
    expect(await cleanupExpiredEvents(env())).toBe(1);
    expect(archived()).not.toBeNull();
  });

  it("take uploads and stay up before expires_at", async () => {
    seed({ expires_at: FUTURE });
    const res = await call("/api/events/party");
    expect(await res.json()).toMatchObject({ event: { uploads_open: true } });
    expect(await cleanupExpiredEvents(env())).toBe(0);
  });
});

describe("closed for uploads, not yet purged", () => {
  beforeEach(() => seed({ uploads_close_at: PAST, purge_after: FUTURE }));

  it("stays viewable and says uploads are closed", async () => {
    const res = await call("/api/events/party");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ event: { uploads_open: false, purge_after: FUTURE } });
    expect((await call("/api/events/party/moments")).status).toBe(200);
    expect(await (await call("/api/v1/events/party")).json()).toMatchObject({ event: { uploads_open: false } });
  });

  it.each([
    ["/api/events/party/moments/multipart/init", { filename: "a.jpg", content_type: "image/jpeg", size: 10, uploader_name: "Sara" }],
    ["/api/events/party/moments/stream/session", { uploader_name: "Sara", content_type: "video/mp4", size: 10 }],
  ])("rejects new uploads at %s", async (path, body) => {
    const res = await call(path, json(body));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Uploads are closed for this event.", code: "uploads_closed" });
  });

  it("rejects direct uploads", async () => {
    const form = new FormData();
    form.set("uploader_name", "Sara");
    form.set("file", new File(["x"], "a.jpg", { type: "image/jpeg" }));
    const res = await call("/api/events/party/moments", { method: "POST", body: form });
    expect(res.status).toBe(403);
  });

  it("still lets guests join", async () => {
    const form = new FormData();
    form.set("nickname", "Sara");
    expect((await call("/api/events/party/participants", { method: "POST", body: form })).status).toBe(200);
  });

  it("is not purged by the cron yet", async () => {
    expect(await cleanupExpiredEvents(env())).toBe(0);
    expect(archived()).toBeNull();
  });
});

describe("purge_after", () => {
  it("purges once passed, even if expires_at is in the future", async () => {
    seed({ expires_at: FUTURE, purge_after: PAST });
    expect((await call("/api/events/party")).status).toBe(404);
    expect(await cleanupExpiredEvents(env())).toBe(1);
  });

  it("keeps an event whose expires_at passed but purge_after has not", async () => {
    seed({ expires_at: PAST, purge_after: FUTURE });
    const res = await call("/api/events/party");
    expect(res.status).toBe(200);
    // uploads_close_at falls back to the (past) expires_at.
    expect(await res.json()).toMatchObject({ event: { uploads_open: false } });
    expect(await cleanupExpiredEvents(env())).toBe(0);
  });
});

describe("PATCH /api/admin/events/:id/lifecycle", () => {
  beforeEach(() => seed({ uploads_close_at: "2030-01-01 00:00:00", purge_after: "2030-02-01 00:00:00" }));

  const patch = (body: unknown) => call("/api/admin/events/ev/lifecycle", json(body, "PATCH", admin));
  const row = () =>
    sqlite.raw.prepare("SELECT expires_at, uploads_close_at, purge_after FROM events WHERE id = 'ev'").get();

  it("makes expires_at the single end date when it is all that is sent (web admin)", async () => {
    expect((await patch({ expires_at: "2029-03-01T00:00:00.000Z" })).status).toBe(200);
    expect(row()).toEqual({ expires_at: "2029-03-01 00:00:00", uploads_close_at: null, purge_after: null });
  });

  it("keeps expires_at and the other split date when one split date is sent", async () => {
    sqlite.raw.prepare("UPDATE events SET expires_at = '2029-01-01 00:00:00' WHERE id = 'ev'").run();
    expect((await patch({ purge_after: "2030-06-01T00:00:00Z" })).status).toBe(200);
    expect(row()).toEqual({
      expires_at: "2029-01-01 00:00:00",
      uploads_close_at: "2030-01-01 00:00:00",
      purge_after: "2030-06-01 00:00:00",
    });
  });

  it("rejects an empty body", async () => {
    expect((await patch({})).status).toBe(400);
  });

  it("sets and clears the split dates", async () => {
    await patch({ expires_at: null, uploads_close_at: "2031-01-01T00:00:00Z", purge_after: "2031-02-01T00:00:00Z" });
    expect(row()).toEqual({ expires_at: null, uploads_close_at: "2031-01-01 00:00:00", purge_after: "2031-02-01 00:00:00" });
    await patch({ expires_at: null, uploads_close_at: null, purge_after: null });
    expect(row()).toEqual({ expires_at: null, uploads_close_at: null, purge_after: null });
  });

  it.each([
    [{ expires_at: null, uploads_close_at: "2031-03-01T00:00:00Z", purge_after: "2031-02-01T00:00:00Z" }, "before"],
    [{ expires_at: "2031-01-01T00:00:00Z", uploads_close_at: "2031-06-01T00:00:00Z" }, "before"],
    [{ expires_at: null, uploads_close_at: "soon" }, "uploads_close_at is invalid"],
    [{ expires_at: null, purge_after: 5 }, "purge_after is invalid"],
    [{ expires_at: "+275760-09-13T00:00:00.000Z" }, "expires_at is invalid"],
    [{ expires_at: "1970-01-01T00:00:00Z" }, "expires_at is invalid"],
  ])("rejects %j", async (body, message) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(message);
  });
});
