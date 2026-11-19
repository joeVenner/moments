import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest } from "./guestIdentity";
import worker from "./index";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import { thumbnailKey, thumbnailUploadKey } from "./thumbnails";
import type { Env } from "./types";

/** The web (legacy /api) upload flow's optional grid thumbnail. */

const KEY = "events/ev1/moments/a.jpg";
const FILE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9, 9, 0xff, 0xd9]);

let sqlite: SqliteD1;
let objects: Map<string, { bytes: Uint8Array; contentType: string }>;

/** Enough of R2 for complete: head, get, put, delete. */
function bucket(): R2Bucket {
  const meta = (key: string) => {
    const object = objects.get(key);
    return object ? { size: object.bytes.length, httpMetadata: { contentType: object.contentType } } : null;
  };
  return {
    head: vi.fn(async (key: string) => {
      if (key === failingKey) throw new Error("R2 unavailable");
      return meta(key);
    }),
    get: vi.fn(async (key: string, options?: { range?: { offset: number; length: number } }) => {
      if (key === failingKey) throw new Error("R2 unavailable");
      const object = objects.get(key);
      if (!object) return null;
      const bytes = options?.range ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length) : object.bytes;
      return { ...meta(key), arrayBuffer: async () => bytes.slice().buffer };
    }),
    put: vi.fn(async (key: string, bytes: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType ?? "" });
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    }),
  } as unknown as R2Bucket;
}

/** Set to make every R2 read of this key fail (a storage error). */
let failingKey: string | null = null;

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: sqlite.db,
    BUCKET: bucket(),
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_S3_ENDPOINT: "https://r2.example.com",
    R2_BUCKET_NAME: "moments-media",
    ...overrides,
  };
}

function call(path: string, body: unknown, token?: string, overrides: Partial<Env> = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Guest-Token": token } : {}) },
    body: JSON.stringify(body),
  };
  return worker.fetch(new Request(`https://moments.test${path}`, init), env(overrides), ctx);
}

async function join(nickname: string): Promise<string> {
  const result = await joinEventAsGuest(sqlite.db, {
    eventId: "ev1", nickname, avatarSeed: null, presentedToken: null, enforceClaims: true,
  });
  if (!result.ok || !result.guestToken) throw new Error("join failed");
  return result.guestToken;
}

async function openUpload(token: string): Promise<void> {
  const participant = sqlite.raw.prepare("SELECT id FROM participants").get() as { id: string };
  sqlite.raw
    .prepare(
      `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status, participant_id)
       VALUES ('row1', 'ev1', 'Sara', ?, 'mp-1', 'image/jpeg', ?, 'open', ?)`
    )
    .run(KEY, FILE.length, participant.id);
  void token;
}

const thumbnailURL = (body: unknown, token?: string, overrides?: Partial<Env>) =>
  call("/api/events/party/moments/multipart/thumbnail-url", body, token, overrides);

/** Storage now holds the assembled file, as after R2's CompleteMultipartUpload. */
function complete(token: string) {
  objects.set(KEY, { bytes: FILE, contentType: "image/jpeg" });
  return call("/api/events/party/moments/multipart/complete", {
    upload_id: "mp-1", key: KEY, uploader_name: "Sara", parts: [{ partNumber: 1, etag: "\"e\"" }],
  }, token);
}

const thumbKeyOfMoment = () => (sqlite.raw.prepare("SELECT thumb_key FROM moments").get() as { thumb_key: string | null }).thumb_key;

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev1', 'party', 'Party', 'party')").run();
  objects = new Map();
  failingKey = null;
  // S3 CompleteMultipartUpload / AbortMultipartUpload: the only outbound calls.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<CompleteMultipartUploadResult/>")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web thumbnail URL", () => {
  it("presigns a PUT bound to image/jpeg and the size, for the unserved slot", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    const res = await thumbnailURL({ upload_id: "mp-1", key: KEY, size: 1234 }, sara);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expires_in: number };
    const url = new URL(body.url);
    expect(url.pathname).toBe(`/moments-media/${thumbnailUploadKey(KEY)}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(body.expires_in).toBe(6 * 60 * 60);
    // Signing is local: nothing went to storage.
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 204801, 1.5, "100", null])("refuses an impossible size (%s)", async (size) => {
    const sara = await join("Sara");
    await openUpload(sara);
    expect((await thumbnailURL({ upload_id: "mp-1", key: KEY, size }, sara)).status).toBe(400);
  });

  it("refuses another event's key, an unknown or finished upload, and app sessions", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    expect((await thumbnailURL({ upload_id: "mp-1", key: "events/ev2/moments/a.jpg", size: 10 }, sara)).status).toBe(400);
    expect((await thumbnailURL({ upload_id: "mp-2", key: KEY, size: 10 }, sara)).status).toBe(404);
    sqlite.raw.prepare("UPDATE uploads SET client_upload_id = 'c1'").run();
    expect((await thumbnailURL({ upload_id: "mp-1", key: KEY, size: 10 }, sara)).status).toBe(409);
    sqlite.raw.prepare("UPDATE uploads SET client_upload_id = NULL, status = 'completed'").run();
    expect((await thumbnailURL({ upload_id: "mp-1", key: KEY, size: 10 }, sara)).status).toBe(404);
  });

  it("is refused once uploads have closed", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    sqlite.raw.prepare("UPDATE events SET uploads_close_at = '2000-01-01 00:00:00', purge_after = '2999-01-01 00:00:00'").run();
    expect((await thumbnailURL({ upload_id: "mp-1", key: KEY, size: 10 }, sara)).status).toBe(403);
  });
});

describe("web complete with a thumbnail", () => {
  it("keeps a whole JPEG as the moment's thumbnail and removes the slot", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    expect((await complete(sara)).status).toBe(201);
    expect(thumbKeyOfMoment()).toBe(thumbnailKey(KEY));
    expect(objects.get(thumbnailKey(KEY))?.bytes).toEqual(JPEG);
    expect(objects.has(thumbnailUploadKey(KEY))).toBe(false);
  });

  it("completes without one when none was sent (older clients)", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    expect((await complete(sara)).status).toBe(201);
    expect(thumbKeyOfMoment()).toBeNull();
  });

  it("drops a thumbnail that isn't a whole JPEG, and still completes", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67]), contentType: "image/jpeg" });
    expect((await complete(sara)).status).toBe(201);
    expect(thumbKeyOfMoment()).toBeNull();
    expect(objects.has(thumbnailUploadKey(KEY))).toBe(false);
    expect(objects.has(thumbnailKey(KEY))).toBe(false);
  });

  it("removes the uploaded thumbnail when the upload is cancelled", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    const res = await call("/api/events/party/moments/multipart/abort", { upload_id: "mp-1", key: KEY }, sara);
    expect(res.status).toBe(200);
    expect(objects.has(thumbnailUploadKey(KEY))).toBe(false);
  });

  it("a cancel never removes a served thumbnail (a moment may hold it)", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    await call("/api/events/party/moments/multipart/abort", { upload_id: "mp-1", key: KEY }, sara);
    expect(objects.has(thumbnailKey(KEY))).toBe(true);
  });

  it("a replayed complete keeps the moment's thumbnail and accepts nothing new", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    expect((await complete(sara)).status).toBe(201);
    // A late re-PUT of the slot (its URL lives 6 h) is never picked up.
    objects.set(thumbnailUploadKey(KEY), { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 0xff, 0xd9]), contentType: "image/jpeg" });
    expect((await complete(sara)).status).toBe(200);
    expect(thumbKeyOfMoment()).toBe(thumbnailKey(KEY));
    expect(objects.get(thumbnailKey(KEY))?.bytes).toEqual(JPEG);
  });

  it("a storage error while checking the thumbnail still completes, without one", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    failingKey = thumbnailUploadKey(KEY);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await complete(sara)).status).toBe(201);
    expect(thumbKeyOfMoment()).toBeNull();
  });

  it("a file that fails validation takes its thumbnails with it", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    objects.set(KEY, { bytes: new Uint8Array(3), contentType: "image/jpeg" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call("/api/events/party/moments/multipart/complete", {
      upload_id: "mp-1", key: KEY, uploader_name: "Sara", parts: [{ partNumber: 1, etag: "\"e\"" }],
    }, sara);
    expect(res.status).toBe(400);
    expect(objects.has(thumbnailUploadKey(KEY))).toBe(false);
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moments").get()).toEqual({ n: 0 });
  });

  it("never touches a finished moment's thumbnail on a late cancel", async () => {
    const sara = await join("Sara");
    await openUpload(sara);
    objects.set(thumbnailUploadKey(KEY), { bytes: JPEG, contentType: "image/jpeg" });
    expect((await complete(sara)).status).toBe(201);
    await call("/api/events/party/moments/multipart/abort", { upload_id: "mp-1", key: KEY }, sara);
    expect(objects.get(thumbnailKey(KEY))?.bytes).toEqual(JPEG);
  });
});
