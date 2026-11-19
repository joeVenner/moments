import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { AdminMomentListSchema, AdminMomentSchema, ErrorSchema, HostSignInResponseSchema } from "./schemas";

let sqlite: SqliteD1;
let deletedKeys: string[];
let bucketFails: boolean;
let overrides: Partial<Env>;
let jwkBase64: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwkBase64 = btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

function env(): Env {
  const bucket = {
    delete: vi.fn(async (keys: string | string[]) => {
      if (bucketFails) throw new Error("R2 unavailable");
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    }),
  } as unknown as R2Bucket;
  return {
    DB: sqlite.db,
    BUCKET: bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret-password",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } as unknown as RateLimit,
    EVENT_ACCESS_SECRET: "test-access-secret-123",
    ...overrides,
  };
}

function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, init), env(), ctx);
}

async function auth(): Promise<Record<string, string>> {
  const response = await call("/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ username: "admin", password: "secret-password" }),
  });
  return { Authorization: `Bearer ${HostSignInResponseSchema.parse(await response.json()).token}` };
}

function insertMoment(id: string, status = "approved", createdAt = "2026-11-10 10:00:00") {
  sqlite.raw
    .prepare(
      `INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type, moderation_status, created_at, thumb_key)
       VALUES (?, 'e', 'Sara', ?, 'image/jpeg', ?, ?, ?)`
    )
    .run(id, `/media/events/e/${id}.jpg`, status, createdAt, `events/e/${id}-thumb.jpg`);
}

const moderate = async (id: string, status: unknown) =>
  call(`/admin/moments/${id}`, {
    method: "PATCH",
    headers: { ...(await auth()), "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });

beforeEach(() => {
  sqlite = createSqliteD1();
  deletedKeys = [];
  bucketFails = false;
  overrides = {};
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_mode) VALUES ('e', 'party', 'Party', 'Party', 'public')").run();
});

describe("host moderation API", () => {
  it("needs a host session for every route", async () => {
    insertMoment("m1");
    for (const [path, method] of [["/admin/events/e/moments", "GET"], ["/admin/moments/m1", "PATCH"], ["/admin/moments/m1", "DELETE"]]) {
      const response = await call(path, { method, headers: { "Content-Type": "application/json" }, body: method === "PATCH" ? "{}" : undefined });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(ErrorSchema.parse(await response.json()).code).toBe("host_auth_required");
    }
    expect(sqlite.raw.prepare("SELECT moderation_status FROM moments WHERE id = 'm1'").get()).toEqual({ moderation_status: "approved" });
  });

  it("lists hidden moments too, newest first, with signed thumbnails and heart counts", async () => {
    insertMoment("old", "hidden", "2026-11-09 10:00:00");
    insertMoment("new", "approved", "2026-11-10 10:00:00");
    sqlite.raw.prepare("INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES ('r1', 'old', 'e', 'p1')").run();
    const response = await call("/admin/events/e/moments", { headers: await auth() });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const list = AdminMomentListSchema.parse(await response.json());
    expect(list.truncated).toBe(false);
    expect(list.moments.map((moment) => [moment.id, moment.moderation_status, moment.reaction_count])).toEqual([
      ["new", "approved", 0],
      ["old", "hidden", 1],
    ]);
    expect(list.moments[1]?.media.thumb_url).toMatch(/^\/media\/events\/e\/old-thumb\.jpg\?mv=\d{10}\.[A-Za-z0-9_-]{43}$/);
    expect(list.moments[1]?.media.url).toMatch(/\?mv=/);
  });

  it("says when the 500 cap left older moments out", async () => {
    const insert = sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES (?, 'e', 'Sara', '/media/x')");
    for (let index = 0; index < 501; index++) insert.run(`m${index}`);
    const list = AdminMomentListSchema.parse(await (await call("/admin/events/e/moments", { headers: await auth() })).json());
    expect(list.moments).toHaveLength(500);
    expect(list.truncated).toBe(true);
  });

  it("gives a private event's Stream video a playback token", async () => {
    overrides = {
      STREAM_ACCOUNT_ID: "acct-test",
      STREAM_API_TOKEN: "stream-token-test",
      STREAM_CUSTOMER_CODE: "abc123",
      STREAM_SIGNING_KEY_ID: "key-test-1",
      STREAM_SIGNING_JWK: jwkBase64,
    } as Partial<Env>;
    sqlite.raw.prepare("UPDATE events SET access_mode = 'private' WHERE id = 'e'").run();
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type) VALUES ('v', 'e', 'Sara', 'https://customer-abc123.cloudflarestream.com/0123456789abcdef0123456789abcdef/iframe', 'video/mp4')")
      .run();
    const list = AdminMomentListSchema.parse(await (await call("/admin/events/e/moments", { headers: await auth() })).json());
    const media = list.moments[0]?.media;
    expect(media?.url).not.toContain("/0123456789abcdef0123456789abcdef/");
    expect(media?.hls_url).toMatch(/^https:\/\/customer-abc123\.cloudflarestream\.com\/[^/]+\/manifest\/video\.m3u8$/);
    expect(media?.hls_url).not.toContain("/0123456789abcdef0123456789abcdef/");
  });

  it("refuses an id longer than 100 characters", async () => {
    const response = await call(`/admin/moments/${"x".repeat(101)}`, { method: "DELETE", headers: await auth() });
    expect(response.status).toBe(400);
  });

  it("answers event_not_found for an unknown event", async () => {
    const response = await call("/admin/events/nope/moments", { headers: await auth() });
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).code).toBe("event_not_found");
  });

  it("hides and shows a moment, and guests see the change in the feed", async () => {
    insertMoment("m1");
    const before = sqlite.raw.prepare("SELECT change_seq FROM moments WHERE id = 'm1'").get() as { change_seq: number };
    const hidden = await moderate("m1", "hidden");
    expect(hidden.status).toBe(200);
    expect(AdminMomentSchema.parse(((await hidden.json()) as { moment: unknown }).moment).moderation_status).toBe("hidden");
    const after = sqlite.raw.prepare("SELECT change_seq FROM moments WHERE id = 'm1'").get() as { change_seq: number };
    expect(after.change_seq).toBeGreaterThan(before.change_seq);
    const shown = await moderate("m1", "approved");
    expect(AdminMomentSchema.parse(((await shown.json()) as { moment: unknown }).moment).moderation_status).toBe("approved");
  });

  it("refuses an unknown status and answers moment_not_found for an unknown moment", async () => {
    insertMoment("m1");
    expect((await moderate("m1", "deleted")).status).toBe(400);
    const missing = await moderate("nope", "hidden");
    expect(missing.status).toBe(404);
    expect(ErrorSchema.parse(await missing.json()).code).toBe("moment_not_found");
  });

  it("deletes the files, then the moment, and leaves a tombstone for guests", async () => {
    insertMoment("m1");
    const response = await call("/admin/moments/m1", { method: "DELETE", headers: await auth() });
    expect(response.status).toBe(204);
    expect(deletedKeys.sort()).toEqual(["events/e/m1-thumb.jpg", "events/e/m1.jpg"]);
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moments").get()).toEqual({ n: 0 });
    expect(sqlite.raw.prepare("SELECT moment_id FROM moment_tombstones").all()).toEqual([{ moment_id: "m1" }]);
  });

  it("keeps the moment when its files can't be deleted", async () => {
    insertMoment("m1");
    bucketFails = true;
    const response = await call("/admin/moments/m1", { method: "DELETE", headers: await auth() });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(ErrorSchema.parse(body).code).toBe("media_delete_failed");
    expect(JSON.stringify(body)).not.toContain("R2 unavailable");
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM moments").get()).toEqual({ n: 1 });
  });

  it("answers moment_not_found when deleting an unknown moment", async () => {
    const response = await call("/admin/moments/nope", { method: "DELETE", headers: await auth() });
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).code).toBe("moment_not_found");
  });
});
