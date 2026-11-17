import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { signAccessGrant } from "./eventAccess";
import { mediaViewExpiry, signMediaView, verifyMediaView, withAdminViewUrls } from "./mediaAccess";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

const SECRET = "test-access-secret-123";
const NOW = 1_800_000_000;
let sqlite: SqliteD1;

describe("media view tokens", () => {
  it("verify only for the same key, secret and a live expiry", async () => {
    const token = await signMediaView(SECRET, "events/e1/a.jpg", NOW);
    expect(await verifyMediaView(SECRET, "events/e1/a.jpg", token, NOW)).toBe(true);
    expect(await verifyMediaView(SECRET, "events/e1/b.jpg", token, NOW)).toBe(false);
    expect(await verifyMediaView("other-secret-456", "events/e1/a.jpg", token, NOW)).toBe(false);
    expect(await verifyMediaView(SECRET, "events/e1/a.jpg", token, mediaViewExpiry(NOW))).toBe(false);
    expect(await verifyMediaView(SECRET, "events/e1/a.jpg", undefined, NOW)).toBe(false);
    expect(await verifyMediaView(SECRET, "events/e1/a.jpg", "garbage", NOW)).toBe(false);
  });

  it("rejects an expiry further out than any token we mint", async () => {
    const far = await signMediaView(SECRET, "events/e1/a.jpg", NOW + 10 * 3600);
    expect(await verifyMediaView(SECRET, "events/e1/a.jpg", far, NOW)).toBe(false);
  });

  it("adds ?mv= to R2 URLs only", async () => {
    const [r2, stream] = await withAdminViewUrls(
      SECRET,
      [{ media_url: "/media/events/e1/a.jpg" }, { media_url: "https://customer-x.cloudflarestream.com/u/iframe" }],
      NOW
    );
    expect(r2.media_url).toMatch(/^\/media\/events\/e1\/a\.jpg\?mv=\d{10}\.[\w-]{43}$/);
    expect(stream.media_url).toBe("https://customer-x.cloudflarestream.com/u/iframe");
    expect(await withAdminViewUrls(undefined, [{ media_url: "/media/a.jpg" }])).toEqual([{ media_url: "/media/a.jpg" }]);
    const [already] = await withAdminViewUrls(SECRET, [{ media_url: "/media/a.jpg?mv=x" }], NOW);
    expect(already.media_url).toBe("/media/a.jpg?mv=x");
  });
});

describe("/media", () => {
  const objects = new Map<string, string>();

  let secret: string | undefined = SECRET;

  function env(): Env {
    return {
      DB: sqlite.db,
      BUCKET: {
        get: vi.fn(async (key: string) =>
          objects.has(key)
            ? { body: objects.get(key), httpMetadata: { contentType: "image/jpeg" }, httpEtag: '"e"' }
            : null
        ),
        head: vi.fn(async (key: string) =>
          objects.has(key) ? { size: objects.get(key)?.length ?? 0, httpMetadata: { contentType: "image/jpeg" }, httpEtag: '"e"' } : null
        ),
      } as unknown as R2Bucket,
      ASSETS: {} as Fetcher,
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "secret",
      ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      EVENT_ACCESS_SECRET: secret,
    };
  }

  function get(path: string, headers: Record<string, string> = {}) {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    return worker.fetch(new Request(`https://moments.test${path}`, { headers }), env(), ctx);
  }

  function addMoment(id: string, eventId: string, status = "approved") {
    const key = `events/${eventId}/moments/${id}.jpg`;
    objects.set(key, `bytes-${id}`);
    sqlite.raw
      .prepare(
        "INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type, moderation_status) VALUES (?, ?, 'Sara', ?, 'image/jpeg', ?)"
      )
      .run(id, eventId, `/media/${key}`, status);
    return key;
  }

  beforeEach(() => {
    sqlite = createSqliteD1();
    objects.clear();
    secret = SECRET;
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_mode) VALUES ('ev1', 'party', 'P', 'Party', 'public')").run();
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_mode, access_version) VALUES ('ev2', 'secret', 'S', 'Party', 'private', 1)").run();
  });

  it("serves approved moments with revalidating public caching", async () => {
    const key = addMoment("m1", "ev1");
    const res = await get(`/media/${key}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes-m1");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("hides hidden moments from direct links", async () => {
    const key = addMoment("m1", "ev1", "hidden");
    expect((await get(`/media/${key}`)).status).toBe(404);
  });

  it("hides derived objects of hidden moments too", async () => {
    addMoment("m1", "ev1", "hidden");
    objects.set("events/ev1/thumbs/m1.jpg", "thumb");
    sqlite.raw.prepare("UPDATE moments SET thumb_key = 'events/ev1/thumbs/m1.jpg' WHERE id = 'm1'").run();
    expect((await get("/media/events/ev1/thumbs/m1.jpg")).status).toBe(404);
  });

  it("still serves objects that belong to no moment (event covers)", async () => {
    objects.set("events/ev1/cover", "cover");
    expect((await get("/media/events/ev1/cover")).status).toBe(200);
  });

  it("lets a signed admin view load hidden and private media, privately cached", async () => {
    const hidden = addMoment("m1", "ev1", "hidden");
    const priv = addMoment("m2", "ev2");
    for (const key of [hidden, priv]) {
      const token = await signMediaView(SECRET, key, Math.floor(Date.now() / 1000));
      const res = await get(`/media/${key}?mv=${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    }
  });

  it("does not accept one key's admin view for another key", async () => {
    const hidden = addMoment("m1", "ev1", "hidden");
    const other = addMoment("m2", "ev1");
    const token = await signMediaView(SECRET, other, Math.floor(Date.now() / 1000));
    expect((await get(`/media/${hidden}?mv=${token}`)).status).toBe(404);
  });

  it("keeps the private gate, and hides hidden moments even with a grant", async () => {
    const visible = addMoment("m2", "ev2");
    const hidden = addMoment("m3", "ev2", "hidden");
    expect((await get(`/media/${visible}`)).status).toBe(401);
    const grant = await signAccessGrant(SECRET, { eventId: "ev2", accessVersion: 1, expiresAt: Math.floor(Date.now() / 1000) + 600 });
    expect((await get(`/media/${visible}`, { "X-Event-Access": grant })).status).toBe(200);
    expect((await get(`/media/${hidden}`, { "X-Event-Access": grant })).status).toBe(404);
  });

  it("gives the admin moment list signed view URLs", async () => {
    addMoment("m1", "ev1", "hidden");
    const res = await get("/api/admin/events/party/moments", { Authorization: `Basic ${btoa("admin:secret")}` });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { moments } = (await res.json()) as { moments: { media_url: string }[] };
    expect(moments[0].media_url).toMatch(/\?mv=/);
    expect((await get(moments[0].media_url)).status).toBe(200);
  });

  it("rejects range and revalidation requests for hidden moments", async () => {
    const key = addMoment("m1", "ev1", "hidden");
    expect((await get(`/media/${key}`, { Range: "bytes=0-3" })).status).toBe(404);
    expect((await get(`/media/${key}`, { "If-None-Match": '"e"' })).status).toBe(404);
  });

  it("serves the moment again once it is approved", async () => {
    const key = addMoment("m1", "ev1", "hidden");
    sqlite.raw.prepare("UPDATE moments SET moderation_status = 'approved' WHERE id = 'm1'").run();
    expect((await get(`/media/${key}`)).status).toBe(200);
  });

  it.each(["display_key", "poster_key"])("hides a hidden moment's %s object", async (column) => {
    addMoment("m1", "ev1", "hidden");
    objects.set("events/ev1/derived/m1.jpg", "derived");
    sqlite.raw.prepare(`UPDATE moments SET ${column} = 'events/ev1/derived/m1.jpg' WHERE id = 'm1'`).run();
    expect((await get("/media/events/ev1/derived/m1.jpg")).status).toBe(404);
  });

  it("rejects tampered and expired admin views", async () => {
    const key = addMoment("m1", "ev1", "hidden");
    const token = await signMediaView(SECRET, key, Math.floor(Date.now() / 1000));
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect((await get(`/media/${key}?mv=${tampered}`)).status).toBe(404);
    const expired = await signMediaView(SECRET, key, Math.floor(Date.now() / 1000) - 3 * 3600);
    expect((await get(`/media/${key}?mv=${expired}`)).status).toBe(404);
  });

  it("fails closed for hidden media when no secret is configured", async () => {
    secret = undefined;
    const key = addMoment("m1", "ev1", "hidden");
    const res = await get("/api/admin/events/party/moments", { Authorization: `Basic ${btoa("admin:secret")}` });
    const { moments } = (await res.json()) as { moments: { media_url: string }[] };
    expect(moments[0].media_url).toBe(`/media/${key}`);
    expect((await get(moments[0].media_url)).status).toBe(404);
  });

  it("returns a viewable URL from the moderation PATCH", async () => {
    addMoment("m1", "ev1");
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://moments.test/api/admin/moments/m1", {
        method: "PATCH",
        headers: { Authorization: `Basic ${btoa("admin:secret")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "hidden" }),
      }),
      env(),
      ctx
    );
    const { moment } = (await res.json()) as { moment: { media_url: string; moderation_status: string } };
    expect(moment.moderation_status).toBe("hidden");
    expect((await get(moment.media_url)).status).toBe(200);
    expect((await get(moment.media_url.split("?")[0])).status).toBe(404);
  });

  it("returns 404 for archived private events on guest routes", async () => {
    sqlite.raw.prepare("UPDATE events SET archived_at = datetime('now') WHERE id = 'ev2'").run();
    sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES ('p1', 'ev2', 'Sara')").run();
    for (const path of ["/api/events/secret/participants", "/api/events/secret/leaderboard", "/api/events/secret/moments"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("Sara");
    }
  });
});
