import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { signAccessGrant } from "./eventAccess";
import {
  mediaGrantExpiry,
  mediaViewExpiry,
  signMediaGrant,
  signMediaView,
  verifyMediaGrant,
  verifyMediaView,
  withAdminViewUrls,
  withGuestMediaGrant,
  withGuestMediaGrants,
} from "./mediaAccess";
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

describe("guest media grants", () => {
  const key = "events/e1/moments/a.jpg";

  it("verify only for the same key, access version, secret and a live expiry", async () => {
    const token = await signMediaGrant(SECRET, key, 3, NOW);
    expect(await verifyMediaGrant(SECRET, key, 3, token, NOW)).toBe(true);
    expect(await verifyMediaGrant(SECRET, "events/e1/moments/b.jpg", 3, token, NOW)).toBe(false);
    expect(await verifyMediaGrant(SECRET, key, 4, token, NOW)).toBe(false);
    expect(await verifyMediaGrant("other-secret-456", key, 3, token, NOW)).toBe(false);
    expect(await verifyMediaGrant(SECRET, key, 3, token, mediaGrantExpiry(NOW))).toBe(false);
    expect(await verifyMediaGrant(SECRET, key, 3, undefined, NOW)).toBe(false);
    expect(await verifyMediaGrant(SECRET, key, 3, `${token}x`, NOW)).toBe(false);
  });

  it("is not interchangeable with an admin view", async () => {
    const view = await signMediaView(SECRET, key, NOW);
    expect(await verifyMediaGrant(SECRET, key, 1, view, NOW)).toBe(false);
    const grant = await signMediaGrant(SECRET, key, 1, NOW);
    expect(await verifyMediaView(SECRET, key, grant, NOW)).toBe(false);
  });

  it("lasts 6-12 hours and rejects expiries further out", async () => {
    const exp = mediaGrantExpiry(NOW);
    expect(exp - NOW).toBeGreaterThan(6 * 3600);
    expect(exp - NOW).toBeLessThanOrEqual(12 * 3600);
    const far = await signMediaGrant(SECRET, key, 1, NOW + 13 * 3600);
    expect(await verifyMediaGrant(SECRET, key, 1, far, NOW)).toBe(false);
  });

  it("signs R2 URLs of private events only", async () => {
    const moment = {
      media_url: "/media/events/e1/moments/a.jpg",
      media: {
        kind: "image" as const,
        url: "/media/events/e1/moments/a.jpg",
        thumb_url: "/media/events/e1/thumbs/a.jpg",
        display_url: null,
        poster_url: "https://customer-x.cloudflarestream.com/u/thumbnails/thumbnail.jpg",
        hls_url: null,
        width: null,
        height: null,
        duration_ms: null,
        blurhash: null,
      },
    };
    const [signed] = await withGuestMediaGrants(SECRET, { access_mode: "private", access_version: 2 }, [moment], NOW);
    expect(signed.media_url).toMatch(/\?at=\d{10}\.[\w-]{43}$/);
    expect(signed.media.url).toBe(signed.media_url);
    expect(await verifyMediaGrant(SECRET, "events/e1/thumbs/a.jpg", 2, signed.media.thumb_url?.split("?at=")[1], NOW)).toBe(true);
    expect(signed.media.display_url).toBeNull();
    expect(signed.media.poster_url).toBe(moment.media.poster_url);
    const [open] = await withGuestMediaGrants(SECRET, { access_mode: "public", access_version: 1 }, [moment], NOW);
    expect(open).toEqual(moment);
    const [noSecret] = await withGuestMediaGrants(undefined, { access_mode: "private", access_version: 1 }, [moment], NOW);
    expect(noSecret).toEqual(moment);
  });
});

describe("guest media grant edge cases", () => {
  const privateEvent = { access_mode: "private", access_version: 1 };

  it("leaves query-bearing and absolute URLs alone, and handles moments without media", async () => {
    const [query, absolute] = await withGuestMediaGrants(
      SECRET,
      privateEvent,
      [{ media_url: "/media/events/e1/a.jpg?x=1" }, { media_url: "https://customer-x.cloudflarestream.com/u/iframe" }],
      NOW
    );
    expect(query.media_url).toBe("/media/events/e1/a.jpg?x=1");
    expect(absolute.media_url).toBe("https://customer-x.cloudflarestream.com/u/iframe");
    const [plain] = await withGuestMediaGrants(SECRET, privateEvent, [{ media_url: "/media/events/e1/a.jpg" }], NOW);
    expect(plain.media_url).toMatch(/\?at=/);
  });

  it("signs a single URL such as the cover", async () => {
    expect(await withGuestMediaGrant(SECRET, privateEvent, "/media/events/e1/cover", NOW)).toMatch(/^\/media\/events\/e1\/cover\?at=/);
    expect(await withGuestMediaGrant(SECRET, privateEvent, null, NOW)).toBeNull();
    expect(await withGuestMediaGrant(SECRET, { access_mode: "public", access_version: 1 }, "/media/c", NOW)).toBe("/media/c");
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

  it("never serves a thumbnail's upload slot, and serves accepted thumbnails as safe JPEGs", async () => {
    const key = addMoment("m1", "ev1");
    objects.set(`${key}.thumb-upload.jpg`, "<html>");
    expect((await get(`/media/${key}.thumb-upload.jpg`)).status).toBe(404);
    objects.set(`${key}.thumb.jpg`, "jpeg");
    const res = await get(`/media/${key}.thumb.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("tells browsers never to sniff or run media", async () => {
    const key = addMoment("m1", "ev1");
    const variants: Record<string, string>[] = [{}, { "If-None-Match": '"other"' }, { Range: "bytes=0-1" }];
    for (const headers of variants) {
      const res = await get(`/media/${key}`, headers);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    }
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

  it("lets a native guest load one private key with ?at=, until the PIN changes", async () => {
    const key = addMoment("m2", "ev2");
    const other = addMoment("m4", "ev2");
    const now = Math.floor(Date.now() / 1000);
    const token = await signMediaGrant(SECRET, key, 1, now);
    const res = await get(`/media/${key}?at=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect((await get(`/media/${other}?at=${token}`)).status).toBe(401);
    expect((await get(`/media/${key}?at=${token}`, { Range: "bytes=0-1" })).status).toBe(206);
    sqlite.raw.prepare("UPDATE events SET access_version = 2 WHERE id = 'ev2'").run();
    expect((await get(`/media/${key}?at=${token}`)).status).toBe(401);
  });

  it("falls back to the header when ?at= is malformed or for another key", async () => {
    const key = addMoment("m2", "ev2");
    const grant = await signAccessGrant(SECRET, { eventId: "ev2", accessVersion: 1, expiresAt: Math.floor(Date.now() / 1000) + 600 });
    expect((await get(`/media/${key}?at=garbage`, { "X-Event-Access": grant })).status).toBe(200);
  });

  it("serves a private cover through ?at=", async () => {
    objects.set("events/ev2/cover", "cover");
    const token = await signMediaGrant(SECRET, "events/ev2/cover", 1, Math.floor(Date.now() / 1000));
    expect((await get("/media/events/ev2/cover")).status).toBe(401);
    expect((await get(`/media/events/ev2/cover?at=${token}`)).status).toBe(200);
  });

  it("never serves a hidden moment through ?at=", async () => {
    const hidden = addMoment("m3", "ev2", "hidden");
    const token = await signMediaGrant(SECRET, hidden, 1, Math.floor(Date.now() / 1000));
    expect((await get(`/media/${hidden}?at=${token}`)).status).toBe(404);
  });

  it("ignores ?at= without a secret", async () => {
    const key = addMoment("m2", "ev2");
    const token = await signMediaGrant(SECRET, key, 1, Math.floor(Date.now() / 1000));
    secret = undefined;
    expect((await get(`/media/${key}?at=${token}`)).status).toBe(401);
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
