import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Env, EventRow, MomentRow, LeaderboardEntry, UploadRow } from "./types";
import { slugify, randomSuffix } from "./slugify";
import { putMedia, pointsForContentType, sanitizeFilename, isAllowedContentType, MAX_UPLOAD_BYTES } from "./storage";
import {
  isR2Configured,
  registrationKeyBelongsToEvent,
  MAX_DIRECT_UPLOAD_BYTES,
  PRESIGN_EXPIRY_SECONDS,
} from "./presign";
import {
  createMultipartUpload,
  presignPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  listParts,
  partCountForSize,
  MULTIPART_PART_BYTES,
} from "./multipartPresign";
import { requireAdmin } from "./auth";
import { canFinishUploads, getActiveEventBySlug, getEventBySlug, toPublicEvent, UPLOADS_CLOSED } from "./events";
import { isHiddenMomentMedia, MEDIA_VIEW_PARAM, verifyMediaView, withAdminViewUrls } from "./mediaAccess";
import { v1 } from "./v1";
import { generateAiBanner, BannerGenerationError } from "./banner";
import { isStreamConfigured, streamApiUrl, streamAuthHeaders, streamMediaUrl } from "./stream";
import {
  isStreamSigningConfigured,
  setRequireSignedUrls,
  shouldSignStream,
  signMomentsForEvent,
  signStreamToken,
  STREAM_SIGNING_UNAVAILABLE,
  StreamSigningError,
  tokenExpiry,
  streamUploadMetadata,
  syncStreamSigning,
} from "./streamSigning";
import { deleteMomentMedia } from "./moderation";
import { cleanupEvent, cleanupExpiredEvents, pruneAccessFailures } from "./lifecycle";
import { abortOrphanUploads } from "./orphanUploads";
import {
  CHANGES_MAX_LIMIT,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  clampLimit,
  getFeedChanges,
  getFeedPage,
  parseCursor,
} from "./feed";
import {
  GUEST_TOKEN_HEADER,
  MAX_NICKNAME_LENGTH,
  PUBLIC_PARTICIPANT_COLUMNS,
  joinEventAsGuest,
  toPublicParticipant,
  type PublicParticipant,
} from "./guestIdentity";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  PIN_FAILURE_WINDOW_MINUTES,
  PIN_SLOWDOWN_MS,
  decidePinAttempt,
  grantEventAccess,
  hashClientIp,
  hashEventPin,
  randomAccessToken,
  timingSafeEqual,
  verifyEventAccess,
} from "./eventAccess";

const app = new Hono<{ Bindings: Env }>();

// Document routes (/, /admin, /e/*) are proxied through this app too (for the
// www redirect and X-Robots-Tag), but they still forward to the ASSETS
// binding, whose response already carries public/_headers' security headers
// (CSP included). Scoping secureHeaders() to /api/* and /media/* only keeps
// it from clobbering those _headers values with its own defaults — and from
// throwing on "/", whose handler returns the ASSETS response's immutable
// Headers object directly (secureHeaders mutates c.res.headers in place).
app.use("/api/*", secureHeaders({ contentSecurityPolicy: undefined }));
app.use("/media/*", secureHeaders({ contentSecurityPolicy: undefined }));

const NO_INDEX = "noindex, nofollow, noarchive, nosnippet";

app.use("/api/*", async (c, next) => {
  await next();
  c.res.headers.set("X-Robots-Tag", NO_INDEX);
});

app.use("/media/*", async (c, next) => {
  await next();
  c.res.headers.set("X-Robots-Tag", `${NO_INDEX}, noimageindex`);
});

app.get("/", (c) => {
  const url = new URL(c.req.url);
  if (url.hostname === "www.moments-hq.com") {
    url.hostname = "moments-hq.com";
    return c.redirect(url.toString(), 308);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

function logUpload(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, string | number | boolean | null>
): void {
  const message = JSON.stringify({ scope: "upload", event, ...details });
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}

// Admin-only: listing all events and creating new ones. Guest-facing routes
// (event by slug, moments, media, participants, leaderboard) stay public.
app.use("/api/events", requireAdmin);
app.use("/api/admin/*", requireAdmin);

/**
 * Early size gate for the multipart upload routes. parseBody() buffers the
 * entire request body into the Worker isolate before storage.ts's 25MB check
 * can reject it — so without this, a direct (non-UI) POST of a huge file would
 * consume isolate memory (Workers isolate ≈ 128MB) before failing, with blast
 * radius for other requests sharing that isolate. Reading Content-Length lets
 * us reject >25MB with a 413 before a single byte is buffered. Best-effort:
 * chunked transfers send no Content-Length and fall through to the post-buffer
 * check, but the common abuse case (a single oversized file) carries one.
 */
function rejectOversizedMultipart(c: Context<{ Bindings: Env }>): Response | null {
  const len = parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File too large (max 25MB)" }, 413);
  }
  return null;
}

async function uniqueSlug(db: D1Database, title: string): Promise<string> {
  const base = slugify(title) || "event";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const existing = await db
      .prepare("SELECT id FROM events WHERE slug = ?")
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeDate(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // Outside this range toISOString() is not "YYYY-..." and would compare as
  // already past against datetime('now'), purging the event immediately.
  const year = parsed.getUTCFullYear();
  if (year < 2000 || year > 2100) return undefined;
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

async function upsertParticipant(
  db: D1Database,
  eventId: string,
  nickname: string,
  avatarSeed?: string | null
): Promise<void> {
  const existing = await db
    .prepare("SELECT id, avatar_seed FROM participants WHERE event_id = ? AND nickname = ?")
    .bind(eventId, nickname)
    .first<{ id: string; avatar_seed: string | null }>();

  if (existing) {
    // Keep the avatar the guest first picked. Re-joining with the same nickname
    // (e.g. from another device, or after clearing local storage) must NOT
    // regenerate the face everyone else already sees — only backfill a seed if
    // they originally joined without one (e.g. uploaded before going through
    // the nickname gate). Never replace an already-chosen face.
    if (avatarSeed && !existing.avatar_seed) {
      await db
        .prepare("UPDATE participants SET avatar_seed = ? WHERE id = ?")
        .bind(avatarSeed, existing.id)
        .run();
    }
    return;
  }

  await db
    .prepare(
      `INSERT INTO participants (id, event_id, nickname, avatar_seed) VALUES (?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), eventId, nickname, avatarSeed ?? null)
    .run();
}

// Native app API (src/worker/v1). Has its own private-event gate.
app.route("/api/v1", v1);

app.use("/api/events/:slug/*", async (c, next) => {
  // Only the unlock endpoint itself is reachable without access.
  if (c.req.method === "POST" && /^\/api\/events\/[^/]+\/access$/.test(c.req.path)) return next();
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (event?.access_mode === "private" && !(await verifyEventAccess(c, event))) {
    return c.json({ error: "access required", access_required: true }, 401);
  }
  return next();
});

app.get("/api/events", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, type, main_characters, description, cover_image_url,
            created_at, starts_at, expires_at, uploads_close_at, purge_after, archived_at, access_mode, invite_token
       FROM events ORDER BY created_at DESC`
  ).all<EventRow>();
  return c.json({ events: results });
});

app.post("/api/events", async (c) => {
  const oversized = rejectOversizedMultipart(c);
  if (oversized) return oversized;
  const body = await c.req.parseBody();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const mainCharacters =
    typeof body.main_characters === "string" ? body.main_characters.trim() : null;
  const description = typeof body.description === "string" ? body.description.trim() : null;
  const cover = body.cover instanceof File && body.cover.size > 0 ? body.cover : null;
  const coverImageUrlField =
    typeof body.cover_image_url === "string" ? body.cover_image_url.trim() : null;
  const expiresAt = body.expires_at === undefined ? null : normalizeDate(body.expires_at);

  if (!title || !type) {
    return c.json({ error: "title and type are required" }, 400);
  }
  if (expiresAt === undefined) return c.json({ error: "expires_at is invalid" }, 400);

  const id = crypto.randomUUID();
  const slug = await uniqueSlug(c.env.DB, title);

  let coverImageUrl: string | null = null;
  if (cover) {
    try {
      const { url } = await putMedia(c.env, `events/${id}/cover`, cover);
      coverImageUrl = url;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cover upload failed" }, 400);
    }
  } else if (coverImageUrlField && coverImageUrlField.startsWith("/media/")) {
    // Already-generated AI banner stored in R2 by /api/admin/generate-banner —
    // no re-upload needed. Only trust our own /media/ namespace here, since
    // this is rendered directly as an <img src> elsewhere.
    coverImageUrl = coverImageUrlField;
  }

  await c.env.DB.prepare(
    `INSERT INTO events (id, slug, title, type, main_characters, description, cover_image_url, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, slug, title, type, mainCharacters, description, coverImageUrl, expiresAt)
    .run();

  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(id)
    .first<EventRow>();

  return c.json({ event }, 201);
});

app.get("/api/events/:slug", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  if (!(await verifyEventAccess(c, event))) {
    return c.json({ error: "access required", access_required: true }, 401);
  }
  return c.json({ event: toPublicEvent(event) });
});

app.post("/api/events/:slug/access", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  if (event.access_mode !== "private") return c.json({ unlocked: true });

  const secret = c.env.EVENT_ACCESS_SECRET;
  if (!secret) {
    // Fail closed: never fall back to issuing the raw invite token.
    console.error(JSON.stringify({ msg: "event_access_secret_missing", route: "access" }));
    return c.json({ error: "private events are temporarily unavailable" }, 503);
  }

  const body = (await c.req.json().catch(() => null)) as {
    pin?: unknown;
    invite_token?: unknown;
  } | null;
  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  const inviteToken = typeof body?.invite_token === "string" ? body.invite_token : "";

  // The invite link is the host's escape hatch, so it is never throttled.
  if (inviteToken && event.invite_token && timingSafeEqual(inviteToken, event.invite_token)) {
    return c.json(await unlockResponse(c, secret, event));
  }
  if (!pin || pin.length > MAX_PIN_LENGTH || !event.access_pin_hash || !event.access_pin_salt) {
    return c.json({ error: "invalid event access" }, 401);
  }

  // Record the attempt *before* checking it, so concurrent guesses count
  // each other; the row is removed again if the PIN turns out to be right.
  const ipHash = await hashClientIp(secret, c.req.header("CF-Connecting-IP") ?? "unknown");
  const attemptId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO access_failures (id, event_id, ip_hash) VALUES (?, ?, ?)")
    .bind(attemptId, event.id, ipHash).run();
  const counts = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(ip_hash = ?), 0) AS client_failures, COUNT(*) AS event_failures
       FROM access_failures
      WHERE event_id = ? AND created_at > datetime('now', ?)`
  ).bind(ipHash, event.id, `-${PIN_FAILURE_WINDOW_MINUTES} minutes`)
    .first<{ client_failures: number; event_failures: number }>();
  const decision = decidePinAttempt(
    Math.max(0, (counts?.client_failures ?? 1) - 1),
    Math.max(0, (counts?.event_failures ?? 1) - 1)
  );
  if (decision === "block") {
    return c.json(
      {
        error: "too many attempts",
        retry_after_seconds: PIN_FAILURE_WINDOW_MINUTES * 60,
        hint: "ask the host for the invitation link",
      },
      429,
      { "Retry-After": String(PIN_FAILURE_WINDOW_MINUTES * 60) }
    );
  }
  if (decision === "slow") await new Promise((resolve) => setTimeout(resolve, PIN_SLOWDOWN_MS));

  const isPinValid = timingSafeEqual(await hashEventPin(pin, event.access_pin_salt), event.access_pin_hash);
  if (!isPinValid) return c.json({ error: "invalid event access" }, 401);

  await c.env.DB.prepare("DELETE FROM access_failures WHERE id = ?").bind(attemptId).run();
  return c.json(await unlockResponse(c, secret, event));
});

/** `{unlocked}` stays for the web client; native clients use access_token as X-Event-Access. */
async function unlockResponse(
  c: Context<{ Bindings: Env }>,
  secret: string,
  event: EventRow
): Promise<{ unlocked: true; access_token: string; expires_at: string }> {
  const grant = await grantEventAccess(c, secret, event);
  return {
    unlocked: true,
    access_token: grant.accessToken,
    expires_at: new Date(grant.expiresAt * 1000).toISOString(),
  };
}

app.patch("/api/admin/events/:id/access", async (c) => {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(c.req.param("id")).first<EventRow>();
  if (!event) return c.json({ error: "event not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { mode?: unknown; pin?: unknown } | null;
  const mode = body?.mode;
  if (mode !== "public" && mode !== "private") return c.json({ error: "invalid access mode" }, 400);

  let salt = event.access_pin_salt;
  let hash = event.access_pin_hash;
  let inviteToken = event.invite_token ?? randomAccessToken();
  let accessVersion = event.access_version;
  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  if (pin) {
    if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
      return c.json({ error: `PIN must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} characters` }, 400);
    }
    salt = randomAccessToken().slice(0, 32);
    hash = await hashEventPin(pin, salt);
    // A new PIN means the old one may have leaked: revoke every issued grant
    // and every shared invite link. The host copies the new link afterwards.
    accessVersion += 1;
    inviteToken = randomAccessToken();
  } else if (mode === "private" && event.access_mode !== "private") {
    // Re-privatising must not resurrect grants issued during an earlier private period.
    accessVersion += 1;
  }
  if (mode === "private" && !hash) return c.json({ error: "a PIN is required for private events" }, 400);
  await c.env.DB.prepare(
    `UPDATE events
        SET access_mode = ?, access_pin_hash = ?, access_pin_salt = ?, invite_token = ?, access_version = ?
      WHERE id = ?`
  ).bind(mode, hash, salt, inviteToken, accessVersion, event.id).run();
  const updated = await c.env.DB.prepare(
    `SELECT id, slug, title, type, main_characters, description, cover_image_url,
            created_at, starts_at, expires_at, uploads_close_at, purge_after, archived_at, access_mode, invite_token
       FROM events WHERE id = ?`
  ).bind(event.id).first<EventRow>();
  // Re-apply requireSignedURLs to the event's existing Stream videos: on every
  // private save (backfills older uploads) and when going public.
  if (isStreamConfigured(c.env) && isStreamSigningConfigured(c.env) && (mode === "private" || event.access_mode !== mode)) {
    c.executionCtx.waitUntil(syncStreamSigning(c.env, event.id, mode === "private"));
  }
  return c.json({ event: updated });
});

app.patch("/api/admin/events/:id/lifecycle", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    expires_at?: unknown;
    uploads_close_at?: unknown;
    purge_after?: unknown;
    archive_now?: unknown;
  } | null;
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(c.req.param("id")).first<EventRow>();
  if (!event) return c.json({ error: "event not found" }, 404);

  if (body?.archive_now === true) {
    await cleanupEvent(c.env, event);
  } else {
    const has = (field: string) => body !== null && typeof body === "object" && field in body;
    if (!has("expires_at") && !has("uploads_close_at") && !has("purge_after")) {
      return c.json({ error: "expires_at is invalid" }, 400);
    }
    const expiresAt = has("expires_at") ? normalizeDate(body?.expires_at) : event.expires_at;
    if (expiresAt === undefined) return c.json({ error: "expires_at is invalid" }, 400);
    // The web admin only knows expires_at: when that is all that is sent, it
    // is the single end date again, so a stale split date cannot outlive it.
    const isSingleDate = !has("uploads_close_at") && !has("purge_after");
    const uploadsCloseAt = has("uploads_close_at")
      ? normalizeDate(body?.uploads_close_at)
      : isSingleDate ? null : event.uploads_close_at;
    const purgeAfter = has("purge_after") ? normalizeDate(body?.purge_after) : isSingleDate ? null : event.purge_after;
    if (uploadsCloseAt === undefined) return c.json({ error: "uploads_close_at is invalid" }, 400);
    if (purgeAfter === undefined) return c.json({ error: "purge_after is invalid" }, 400);
    const effectiveClose = uploadsCloseAt ?? expiresAt;
    const effectivePurge = purgeAfter ?? expiresAt;
    if (effectiveClose && effectivePurge && effectiveClose > effectivePurge) {
      return c.json({ error: "uploads must close before the event is purged" }, 400);
    }
    await c.env.DB.prepare(
      "UPDATE events SET expires_at = ?, uploads_close_at = ?, purge_after = ?, archived_at = NULL WHERE id = ?"
    )
      .bind(expiresAt, uploadsCloseAt, purgeAfter, event.id).run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(event.id).first<EventRow>();
  return c.json({ event: updated });
});

// The web feed's moment shape. Explicit so new internal columns (R2 keys,
// media metadata) never leak to guests by default.
const WEB_MOMENT_COLUMNS = `m.id, m.event_id, m.uploader_name, m.media_url, m.caption, m.points_awarded,
  m.created_at, m.size_bytes, m.mime_type, m.moderation_status`;

app.get("/api/events/:slug/moments", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  // Offset pagination (not cursor): created_at is a `datetime('now')` text
  // default ("YYYY-MM-DD HH:MM:SS", space-separated), so a cursor comparison
  // would be fragile across formats. Event feeds are small enough that
  // deep-offset cost is a non-issue, and offset keeps ordering bulletproof.
  // Default 25, cap 100 — bounds the initial payload + DOM.
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "25", 10) || 25, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const reactorId = (c.req.query("reactor_id") ?? "").slice(0, 100);

  const { results } = await c.env.DB.prepare(
    `SELECT ${WEB_MOMENT_COLUMNS},
            (SELECT COUNT(*) FROM moment_reactions r WHERE r.moment_id = m.id) AS reaction_count,
            EXISTS(SELECT 1 FROM moment_reactions r WHERE r.moment_id = m.id AND r.reactor_id = ?) AS reacted
       FROM moments m
      WHERE m.event_id = ? AND m.moderation_status = 'approved'
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(reactorId, event.id, limit, offset)
    .all<MomentRow>();

  // Total event moment count — drives the numbered page nav on the client (the
  // old `hasMore` heuristic is off-by-one at the boundary: a full final page
  // reports hasMore=true even though there's no next page). One cheap COUNT(*).
  const totalRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS c FROM moments WHERE event_id = ? AND moderation_status = 'approved'"
  )
    .bind(event.id)
    .first<{ c: number }>();
  const total = totalRow?.c ?? results.length;

  // Optional: the requesting guest's running point total for this event. Lets
  // the client render the sticky "Your points" bar correctly even though the
  // paginated `moments` array now holds only the current page (it can no longer
  // sum points across everything). Best-effort — absent when no nickname is sent
  // (e.g. before the guest has joined).
  const uploaderNameRaw = c.req.query("uploader_name");
  const uploaderName =
    typeof uploaderNameRaw === "string" ? uploaderNameRaw.trim() : "";
  let your_points = 0;
  if (uploaderName) {
    const pts = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(points_awarded), 0) AS s FROM moments WHERE event_id = ? AND uploader_name = ? AND moderation_status = 'approved'"
    )
      .bind(event.id, uploaderName)
      .first<{ s: number }>();
    your_points = pts?.s ?? 0;
  }

  return c.json({
    moments: await signMomentsForEvent(c.env, event, results),
    hasMore: results.length === limit,
    total,
    your_points,
  });
});

// Cursor feed for native clients (feed.ts). The web keeps the offset list above.
app.get("/api/events/:slug/feed", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const page = await getFeedPage(c.env.DB, {
    eventId: event.id,
    before: parseCursor(c.req.query("before")),
    limit: clampLimit(c.req.query("limit"), FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT),
    reactorId: (c.req.query("reactor_id") ?? "").slice(0, 100),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ ...page, moments: await signMomentsForEvent(c.env, event, page.moments) });
});

app.get("/api/events/:slug/feed/changes", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const since = parseCursor(c.req.query("since"));
  if (since === null) return c.json({ error: "since must be a non-negative integer cursor" }, 400);
  const changes = await getFeedChanges(c.env.DB, {
    eventId: event.id,
    since,
    limit: clampLimit(c.req.query("limit"), CHANGES_MAX_LIMIT, CHANGES_MAX_LIMIT),
    reactorId: (c.req.query("reactor_id") ?? "").slice(0, 100),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ ...changes, upserts: await signMomentsForEvent(c.env, event, changes.upserts) });
});

app.post("/api/events/:slug/moments", async (c) => {
  const oversized = rejectOversizedMultipart(c);
  if (oversized) return oversized;
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // New uploads only; sessions opened before the close may still finish.
  if (!event.uploads_open) return c.json(UPLOADS_CLOSED, 403);

  const body = await c.req.parseBody();
  const uploaderName =
    typeof body.uploader_name === "string" ? body.uploader_name.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : null;
  const file = body.file instanceof File ? body.file : null;

  if (!uploaderName || !file || file.size === 0) {
    return c.json({ error: "uploader_name and file are required" }, 400);
  }

  let mediaUrl: string;
  try {
    const { url } = await putMedia(c.env, `events/${event.id}/moments`, file);
    mediaUrl = url;
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "upload failed" }, 400);
  }

  const points = pointsForContentType(file.type);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, event.id, uploaderName, mediaUrl, caption, points, file.size, file.type || null)
    .run();

  // Defensive: guarantees a participant row exists even if the client somehow
  // uploaded without going through the nickname-gate join step, so the
  // leaderboard and participant strip never silently drop an uploader.
  await upsertParticipant(c.env.DB, event.id, uploaderName);

  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(id)
    .first<MomentRow>();

  return c.json({ moment, points_awarded: points }, 201);
});

app.get("/api/events/:slug/highlights", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const reactorId = (c.req.query("reactor_id") ?? "").slice(0, 100);
  const { results } = await c.env.DB.prepare(
    `SELECT ${WEB_MOMENT_COLUMNS},
            COUNT(r.id) AS reaction_count,
            EXISTS(SELECT 1 FROM moment_reactions mine WHERE mine.moment_id = m.id AND mine.reactor_id = ?) AS reacted
       FROM moments m
       LEFT JOIN moment_reactions r ON r.moment_id = m.id
      WHERE m.event_id = ? AND m.moderation_status = 'approved'
      GROUP BY m.id
      ORDER BY reaction_count DESC, m.created_at DESC
      LIMIT 50`
  ).bind(reactorId, event.id).all<MomentRow>();
  return c.json({ moments: await signMomentsForEvent(c.env, event, results) });
});

app.post("/api/events/:slug/moments/:id/reactions", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { reactor_id?: unknown } | null;
  const reactorId = typeof body?.reactor_id === "string" ? body.reactor_id.slice(0, 100) : "";
  if (!reactorId) return c.json({ error: "reactor_id is required" }, 400);
  const moment = await c.env.DB.prepare(
    "SELECT id FROM moments WHERE id = ? AND event_id = ? AND moderation_status = 'approved'"
  ).bind(c.req.param("id"), event.id).first<{ id: string }>();
  if (!moment) return c.json({ error: "moment not found" }, 404);
  const existing = await c.env.DB.prepare(
    "SELECT id FROM moment_reactions WHERE moment_id = ? AND reactor_id = ?"
  ).bind(moment.id, reactorId).first<{ id: string }>();
  let reacted: boolean;
  if (existing) {
    await c.env.DB.prepare("DELETE FROM moment_reactions WHERE id = ?").bind(existing.id).run();
    reacted = false;
  } else {
    await c.env.DB.prepare(
      "INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES (?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), moment.id, event.id, reactorId).run();
    reacted = true;
  }
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM moment_reactions WHERE moment_id = ?"
  ).bind(moment.id).first<{ count: number }>();
  return c.json({ reacted, reaction_count: count?.count ?? 0 });
});

app.get("/api/admin/events/:slug/moments", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM moments WHERE event_id = ? ORDER BY created_at DESC LIMIT 500"
  ).bind(event.id).all<MomentRow>();
  const signed = await signMomentsForEvent(c.env, event, results);
  // Carries signed view URLs: keep it out of every cache.
  c.header("Cache-Control", "private, no-store");
  return c.json({ moments: await withAdminViewUrls(c.env.EVENT_ACCESS_SECRET, signed) });
});

app.get("/api/admin/events/:slug/analytics", async (c) => {
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE slug = ?")
    .bind(c.req.param("slug")).first<{ id: string }>();
  if (!event) return c.json({ error: "event not found" }, 404);
  const [summary, participants, reactions, activity, uploadStates] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_moments,
              SUM(CASE WHEN moderation_status = 'hidden' THEN 1 ELSE 0 END) AS hidden_moments,
              SUM(CASE WHEN mime_type LIKE 'video/%' THEN 1 ELSE 0 END) AS videos,
              SUM(CASE WHEN mime_type NOT LIKE 'video/%' OR mime_type IS NULL THEN 1 ELSE 0 END) AS photos,
              COALESCE(SUM(size_bytes), 0) AS storage_bytes
         FROM moments WHERE event_id = ?`
    ).bind(event.id).first(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM participants WHERE event_id = ?")
      .bind(event.id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM moment_reactions WHERE event_id = ?")
      .bind(event.id).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
         FROM moments WHERE event_id = ? AND created_at >= datetime('now', '-13 days')
        GROUP BY date(created_at) ORDER BY day ASC`
    ).bind(event.id).all<{ day: string; count: number }>(),
    c.env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM uploads WHERE event_id = ? GROUP BY status"
    ).bind(event.id).all<{ status: string; count: number }>(),
  ]);
  return c.json({
    summary: {
      ...(summary ?? {}),
      participants: participants?.count ?? 0,
      reactions: reactions?.count ?? 0,
    },
    activity: activity.results,
    upload_states: uploadStates.results,
  });
});

app.patch("/api/admin/moments/:id", async (c) => {
  const status = ((await c.req.json().catch(() => null)) as { status?: unknown } | null)?.status;
  if (status !== "approved" && status !== "hidden") {
    return c.json({ error: "status must be approved or hidden" }, 400);
  }
  const result = await c.env.DB.prepare(
    "UPDATE moments SET moderation_status = ? WHERE id = ?"
  ).bind(status, c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "moment not found" }, 404);
  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(c.req.param("id")).first<MomentRow>();
  if (!moment) return c.json({ error: "moment not found" }, 404);
  const event = await c.env.DB.prepare("SELECT access_mode FROM events WHERE id = ?")
    .bind(moment.event_id).first<{ access_mode: string }>();
  const [signed] = event ? await signMomentsForEvent(c.env, event, [moment]) : [moment];
  const [viewable] = await withAdminViewUrls(c.env.EVENT_ACCESS_SECRET, [signed]);
  c.header("Cache-Control", "private, no-store");
  return c.json({ moment: viewable });
});

app.delete("/api/admin/moments/:id", async (c) => {
  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(c.req.param("id")).first<MomentRow>();
  if (!moment) return c.json({ error: "moment not found" }, 404);

  try {
    await deleteMomentMedia(c.env, moment.media_url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "unable to delete media" }, 502);
  }

  await c.env.DB.prepare("DELETE FROM moments WHERE id = ?").bind(moment.id).run();
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Resumable multipart large-upload flow (P3.1 evolution). The original
// single presigned PUT died + restarted from byte zero when iOS suspended the
// background tab; this flow splits the file into 8 MiB parts the browser PUTs
// straight to R2, so an interruption only costs one part and resume is
// instant. The Worker stays out of the data path (it only signs part URLs and
// runs Create/Complete/Abort/ListParts server-side). R2 ListParts is the
// resume source of truth; the D1 `uploads` row is accounting/cleanup.
//
// Security mirrors the single-PUT register path: every route re-checks the
// key belongs to this event, and every part/complete/abort/status call binds
// the uploadId to an OPEN uploads row under THIS event — so a caller can't
// drive another event's upload or complete a partial one (the assembled size
// must equal the size declared at init).
// ---------------------------------------------------------------------------

/** Look up an open upload owned by this event. Returns null if missing/owned
 *  by another event/already closed — the caller treats that as a 404/400. */
async function getOpenUpload(
  db: D1Database,
  eventId: string,
  uploadId: string,
  key: string
): Promise<UploadRow | null> {
  return db
    .prepare("SELECT * FROM uploads WHERE upload_id = ? AND key = ? AND event_id = ? AND status = 'open'")
    .bind(uploadId, key, eventId)
    .first<UploadRow>();
}

async function getUpload(
  db: D1Database,
  eventId: string,
  uploadId: string,
  key: string
): Promise<UploadRow | null> {
  return db
    .prepare("SELECT * FROM uploads WHERE upload_id = ? AND key = ? AND event_id = ?")
    .bind(uploadId, key, eventId)
    .first<UploadRow>();
}

async function getMomentForUpload(
  db: D1Database,
  eventId: string,
  key: string
): Promise<MomentRow | null> {
  return db
    .prepare("SELECT * FROM moments WHERE event_id = ? AND media_url = ? ORDER BY created_at LIMIT 1")
    .bind(eventId, `/media/${key}`)
    .first<MomentRow>();
}

/**
 * Post-assembly validation shared by the complete step. Confirms the assembled
 * object exists on R2, is an allowed type, is ≤ 512 MB, and (multipart only)
 * matches the size declared at init — so dropping parts can't smuggle through a
 * truncated object as "complete". Deletes the object on failure (mirrors the
 * register path) and returns a JSON error Response for the caller to return.
 */
async function validateAssembledObject(
  c: Context<{ Bindings: Env }>,
  key: string,
  expectedSize?: number
): Promise<{ contentType: string; size: number } | Response> {
  const object = await c.env.BUCKET.head(key);
  if (!object) return c.json({ error: "uploaded object not found" }, 404);
  const contentType = object.httpMetadata?.contentType?.toLowerCase() ?? "";
  if (!isAllowedContentType(contentType)) {
    await c.env.BUCKET.delete(key);
    return c.json({ error: "Unsupported file type" }, 400);
  }
  if (object.size <= 0 || object.size > MAX_DIRECT_UPLOAD_BYTES) {
    await c.env.BUCKET.delete(key);
    return c.json({ error: "File too large (max 512MB)" }, 400);
  }
  if (expectedSize !== undefined && object.size !== expectedSize) {
    // A smaller assembled object means the client completed with missing parts.
    await c.env.BUCKET.delete(key);
    return c.json({ error: "uploaded object size mismatch" }, 400);
  }
  return { contentType, size: object.size };
}

// Upload capabilities are explicit so the client never starts a Stream queue
// item unless all server-side configuration is present. R2 remains the safe
// fallback during rollout or if Stream is disabled.
app.get("/api/upload-capabilities", (c) =>
  c.json({ stream_tus: isStreamConfigured(c.env) })
);

// Cloudflare Stream tus creation proxy. Only the initial POST crosses the
// Worker; Stream returns a one-time Location and the browser PATCHes bytes
// directly to videodelivery.net without exposing the API token.
app.post("/api/events/:slug/moments/stream/session", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // New uploads only; sessions opened before the close may still finish.
  if (!event.uploads_open) return c.json(UPLOADS_CLOSED, 403);
  if (!isStreamConfigured(c.env)) return c.json({ error: "Stream uploads are not configured" }, 501);
  const body = (await c.req.json().catch(() => null)) as {
    uploader_name?: unknown;
    content_type?: unknown;
    size?: unknown;
  } | null;
  const uploaderName = typeof body?.uploader_name === "string" ? body.uploader_name.trim() : "";
  const contentType = typeof body?.content_type === "string" ? body.content_type.toLowerCase() : "";
  const size = typeof body?.size === "number" ? body.size : NaN;
  if (!uploaderName) return c.json({ error: "uploader_name is required" }, 400);
  if (!contentType.startsWith("video/") || !isAllowedContentType(contentType)) {
    return c.json({ error: "unsupported video type" }, 400);
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_DIRECT_UPLOAD_BYTES) {
    return c.json({ error: "File too large (max 512MB)" }, 400);
  }
  const sessionId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
  )
    .bind(sessionId, event.id, uploaderName, `stream-session/${sessionId}`, sessionId, contentType, size)
    .run();
  return c.json({ session_id: sessionId });
});

app.post("/api/events/:slug/moments/stream/tus", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // Sessions opened before the close get a short grace, not until purge.
  if (!canFinishUploads(event)) return c.json(UPLOADS_CLOSED, 403);
  if (!isStreamConfigured(c.env)) return c.json({ error: "Stream uploads are not configured" }, 501);
  const shouldRequireSigned = event.access_mode === "private" && isStreamSigningConfigured(c.env);

  const tusVersion = c.req.header("Tus-Resumable") ?? "";
  const uploadLength = Number(c.req.header("Upload-Length") ?? NaN);
  const uploadMetadata = c.req.header("Upload-Metadata") ?? "";
  const sessionId = c.req.query("session") ?? "";
  const session = sessionId
    ? await c.env.DB.prepare("SELECT * FROM uploads WHERE id = ? AND event_id = ? AND status = 'open'")
        .bind(sessionId, event.id)
        .first<UploadRow>()
    : null;

  if (tusVersion !== "1.0.0") return c.json({ error: "Tus-Resumable 1.0.0 is required" }, 412);
  if (!session || !session.key.startsWith("stream-session/")) return c.json({ error: "upload session not found" }, 404);
  if (uploadLength !== session.size_bytes) return c.json({ error: "upload size does not match session" }, 400);

  let upstream: Response;
  try {
    upstream = await fetch(`${streamApiUrl(c.env)}?direct_user=true`, {
      method: "POST",
      headers: {
        ...streamAuthHeaders(c.env),
        "Tus-Resumable": tusVersion,
        "Upload-Length": String(uploadLength),
        // Private events' videos only play through signed URLs (when configured).
        "Upload-Metadata": streamUploadMetadata(uploadMetadata, shouldRequireSigned),
        "Upload-Creator": event.id,
      },
    });
  } catch (error) {
    logUpload("error", "stream_tus_create_failed", {
      eventId: event.id,
      sizeBytes: uploadLength,
      error: error instanceof Error ? error.message : "Stream request failed",
    });
    return c.json({ error: "Unable to create Stream upload" }, 502);
  }

  const location = upstream.headers.get("Location");
  const streamUid = upstream.headers.get("stream-media-id");
  if (!upstream.ok || !location || !streamUid) {
    logUpload("error", "stream_tus_create_rejected", {
      eventId: event.id,
      sizeBytes: uploadLength,
      status: upstream.status,
    });
    return c.json({ error: "Stream rejected the upload" }, 502);
  }

  try {
    await c.env.DB.prepare(
      "UPDATE uploads SET key = ?, upload_id = ? WHERE id = ? AND event_id = ? AND status = 'open'"
    )
      .bind(`stream/${streamUid}`, streamUid, session.id, event.id)
      .run();
  } catch (error) {
    await fetch(streamApiUrl(c.env, `/${streamUid}`), {
      method: "DELETE",
      headers: streamAuthHeaders(c.env),
    }).catch(() => {});
    logUpload("error", "stream_upload_record_failed", {
      eventId: event.id,
      error: error instanceof Error ? error.message : "D1 insert failed",
    });
    return c.json({ error: "Unable to persist Stream upload" }, 500);
  }

  logUpload("info", "stream_tus_created", {
    eventId: event.id,
    uploadRecordId: session.id,
    sizeBytes: uploadLength,
    contentType: session.content_type,
  });
  return new Response(null, {
    status: 201,
    headers: {
      Location: location,
      "Tus-Resumable": "1.0.0",
      "stream-media-id": streamUid,
      "Access-Control-Expose-Headers": "Location, stream-media-id, Tus-Resumable",
    },
  });
});

app.post("/api/events/:slug/moments/stream/complete", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // Sessions opened before the close get a short grace, not until purge.
  if (!canFinishUploads(event)) return c.json(UPLOADS_CLOSED, 403);
  if (!isStreamConfigured(c.env)) return c.json({ error: "Stream uploads are not configured" }, 501);

  const body = (await c.req.json().catch(() => null)) as {
    stream_uid?: unknown;
    uploader_name?: unknown;
    caption?: unknown;
  } | null;
  const streamUid = typeof body?.stream_uid === "string" ? body.stream_uid : "";
  const uploaderName = typeof body?.uploader_name === "string" ? body.uploader_name.trim() : "";
  const caption = typeof body?.caption === "string" ? body.caption.trim() : null;
  if (!streamUid || !uploaderName) return c.json({ error: "stream_uid and uploader_name are required" }, 400);

  const upload = await getUpload(c.env.DB, event.id, streamUid, `stream/${streamUid}`);
  if (!upload || upload.uploader_name !== uploaderName) return c.json({ error: "upload not found" }, 404);
  const mediaUrl = streamMediaUrl(c.env, streamUid);
  const existingMoment = await c.env.DB.prepare("SELECT * FROM moments WHERE event_id = ? AND media_url = ?")
    .bind(event.id, mediaUrl)
    .first<MomentRow>();
  if (existingMoment) {
    const [signedExisting] = await signMomentsForEvent(c.env, event, [existingMoment]);
    return c.json({ moment: signedExisting, points_awarded: existingMoment.points_awarded });
  }
  if (upload.status !== "open") return c.json({ error: "upload is not open" }, 409);

  const detailsResponse = await fetch(streamApiUrl(c.env, `/${streamUid}`), {
    headers: streamAuthHeaders(c.env),
  });
  const details = (await detailsResponse.json().catch(() => null)) as {
    success?: boolean;
    result?: { uid?: string; size?: number; status?: { state?: string }; requireSignedURLs?: boolean };
  } | null;
  if (!detailsResponse.ok || !details?.success || details.result?.uid !== streamUid) {
    return c.json({ error: "Unable to verify Stream upload" }, 502);
  }
  if (details.result.status?.state === "error") return c.json({ error: "Stream could not process this video" }, 422);
  if (typeof details.result.size === "number" && details.result.size !== upload.size_bytes) {
    return c.json({ error: "Stream upload size mismatch" }, 400);
  }

  if (event.access_mode !== "private" && details.result.requireSignedURLs === true) {
    // Started while the event was private, finishing after it went public:
    // unlock it, or the unsigned public URL would never play. Best effort.
    await setRequireSignedUrls(c.env, streamUid, false).catch((error: unknown) =>
      logUpload("error", "stream_unlock_failed", {
        eventId: event.id,
        uploadRecordId: upload.id,
        error: error instanceof Error ? error.message : "Stream request failed",
      })
    );
  }
  if (shouldSignStream(c.env, event)) {
    // Before anything is committed: prove the key signs (else 503, retryable),
    // and lock this video even if its upload began while the event was public.
    await signStreamToken(c.env, streamUid, tokenExpiry(Math.floor(Date.now() / 1000)));
    if (details.result.requireSignedURLs !== true) {
      try {
        await setRequireSignedUrls(c.env, streamUid, true);
      } catch (error) {
        logUpload("error", "stream_require_signed_failed", {
          eventId: event.id,
          uploadRecordId: upload.id,
          error: error instanceof Error ? error.message : "Stream request failed",
        });
        return c.json({ error: "Unable to secure the Stream upload" }, 502);
      }
    }
  }

  const points = pointsForContentType(upload.content_type ?? "video/mp4");
  const momentId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(momentId, event.id, uploaderName, mediaUrl, caption, points, upload.size_bytes, upload.content_type)
    .run();
  await c.env.DB.prepare(
    "UPDATE uploads SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  ).bind(upload.id).run();
  await upsertParticipant(c.env.DB, event.id, uploaderName);
  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?").bind(momentId).first<MomentRow>();
  logUpload("info", "stream_upload_completed", {
    eventId: event.id,
    uploadRecordId: upload.id,
    momentId,
    sizeBytes: upload.size_bytes,
  });
  if (!moment) return c.json({ error: "moment not found" }, 500);
  const [signedMoment] = await signMomentsForEvent(c.env, event, [moment]);
  return c.json({ moment: signedMoment, points_awarded: points }, 201);
});

app.post("/api/events/:slug/moments/stream/abort", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  if (!isStreamConfigured(c.env)) return c.json({ error: "Stream uploads are not configured" }, 501);
  const body = (await c.req.json().catch(() => null)) as {
    stream_uid?: unknown;
    session_id?: unknown;
  } | null;
  const streamUid = typeof body?.stream_uid === "string" ? body.stream_uid : "";
  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  if (!streamUid && !sessionId) return c.json({ error: "stream_uid or session_id is required" }, 400);
  const upload = streamUid
    ? await getUpload(c.env.DB, event.id, streamUid, `stream/${streamUid}`)
    : await c.env.DB.prepare("SELECT * FROM uploads WHERE id = ? AND event_id = ?")
        .bind(sessionId, event.id)
        .first<UploadRow>();
  if (!upload) return c.json({ error: "upload not found" }, 404);

  const effectiveUid = upload.key.startsWith("stream/") ? upload.upload_id : "";
  if (effectiveUid) {
    const response = await fetch(streamApiUrl(c.env, `/${effectiveUid}`), {
      method: "DELETE",
      headers: streamAuthHeaders(c.env),
    });
    if (!response.ok && response.status !== 404) return c.json({ error: "Unable to delete Stream upload" }, 502);
  }
  await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(upload.id).run();
  logUpload("info", "stream_upload_aborted", { eventId: event.id, uploadRecordId: upload.id });
  return c.json({ aborted: true });
});

// Step 1: initiate. Validates type + size, builds the key, opens the R2
// multipart upload, and writes a D1 `uploads` row. Inert (501) until R2 S3
// creds are configured, same as the single-PUT presign route.
app.post("/api/events/:slug/moments/multipart/init", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // New uploads only; sessions opened before the close may still finish.
  if (!event.uploads_open) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) {
    return c.json({ error: "Large direct uploads are not configured" }, 501);
  }

  const body = (await c.req.json().catch(() => null)) as {
    uploader_name?: unknown;
    content_type?: unknown;
    size?: unknown;
    filename?: unknown;
  } | null;

  const uploaderName = typeof body?.uploader_name === "string" ? body.uploader_name.trim() : "";
  const contentType = typeof body?.content_type === "string" ? body.content_type.toLowerCase() : "";
  const size = typeof body?.size === "number" ? body.size : NaN;
  const filename = typeof body?.filename === "string" ? body.filename : "upload";

  if (!uploaderName) return c.json({ error: "uploader_name is required" }, 400);
  if (!isAllowedContentType(contentType)) return c.json({ error: "Unsupported file type" }, 400);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_DIRECT_UPLOAD_BYTES) {
    return c.json({ error: "File too large (max 512MB)" }, 400);
  }

  const key = `events/${event.id}/moments/${crypto.randomUUID()}-${sanitizeFilename(filename)}`;
  let uploadId: string;
  try {
    uploadId = await createMultipartUpload(c.env, key, contentType);
  } catch (err) {
    logUpload("error", "multipart_init_failed", {
      eventId: event.id,
      sizeBytes: Number.isFinite(size) ? size : 0,
      contentType,
      error: err instanceof Error ? err.message : "init failed",
    });
    return c.json({ error: err instanceof Error ? err.message : "init failed" }, 502);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
  )
    .bind(id, event.id, uploaderName, key, uploadId, contentType || null, size)
    .run();
  logUpload("info", "multipart_initialized", {
    eventId: event.id,
    uploadRecordId: id,
    sizeBytes: size,
    partCount: partCountForSize(size),
    contentType,
  });

  return c.json({
    upload_id: uploadId,
    key,
    part_size: MULTIPART_PART_BYTES,
    part_count: partCountForSize(size),
    media_url: `/media/${key}`,
    expires_in: PRESIGN_EXPIRY_SECONDS,
  });
});

// Step 2: mint a presigned UploadPart URL. One cheap call per part; the URL is
// query-signed (no creds in the browser) and bound to partNumber + uploadId.
app.post("/api/events/:slug/moments/multipart/part-url", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // Sessions opened before the close get a short grace, not until purge.
  if (!event.uploads_finishing) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) {
    return c.json({ error: "Large direct uploads are not configured" }, 501);
  }

  const body = (await c.req.json().catch(() => null)) as {
    upload_id?: unknown;
    key?: unknown;
    part_number?: unknown;
  } | null;

  const uploadId = typeof body?.upload_id === "string" ? body.upload_id : "";
  const key = typeof body?.key === "string" ? body.key : "";
  const partNumber = typeof body?.part_number === "number" ? body.part_number : NaN;

  if (!uploadId || !key || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return c.json({ error: "upload_id, key, and part_number (1..10000) are required" }, 400);
  }
  if (!registrationKeyBelongsToEvent(event.id, key)) {
    return c.json({ error: "key does not belong to this event" }, 400);
  }
  const upload = await getOpenUpload(c.env.DB, event.id, uploadId, key);
  if (!upload) return c.json({ error: "upload not found" }, 404);

  let url: string;
  try {
    url = await presignPartUrl(c.env, key, uploadId, partNumber);
  } catch (err) {
    logUpload("error", "multipart_part_presign_failed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      partNumber,
      error: err instanceof Error ? err.message : "presign failed",
    });
    return c.json({ error: err instanceof Error ? err.message : "presign failed" }, 502);
  }
  return c.json({ url, part_number: partNumber });
});

// Resume query: which parts R2 already has. The client skips these and re-PUTs
// the rest. Source of truth (survives reload + cross-device) — the D1 row only
// confirms the upload is still open + owned by this event.
app.get("/api/events/:slug/moments/multipart/status", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  if (!isR2Configured(c.env)) {
    return c.json({ error: "Large direct uploads are not configured" }, 501);
  }

  const uploadId = c.req.query("upload_id") ?? "";
  const key = c.req.query("key") ?? "";
  if (!uploadId || !key) return c.json({ error: "upload_id and key are required" }, 400);
  if (!registrationKeyBelongsToEvent(event.id, key)) {
    return c.json({ error: "key does not belong to this event" }, 400);
  }
  const upload = await getUpload(c.env.DB, event.id, uploadId, key);
  if (!upload) return c.json({ error: "upload not found" }, 404);
  if (upload.status === "completed") {
    const moment = await getMomentForUpload(c.env.DB, event.id, key);
    if (!moment) return c.json({ error: "completed upload has no moment" }, 409);
    return c.json({
      status: "completed",
      part_size: MULTIPART_PART_BYTES,
      part_count: partCountForSize(upload.size_bytes),
      parts: [],
      moment,
      points_awarded: moment.points_awarded,
    });
  }
  // 'aborted' or 'open' — either way, list what R2 actually has. If aborted,
  // the client should re-init (returned parts let it decide).
  let parts;
  try {
    parts = await listParts(c.env, key, uploadId);
  } catch (err) {
    const error = err instanceof Error ? err.message : "listParts failed";
    // CompleteMultipartUpload consumes the multipart session. If its response
    // or the following registration was interrupted, ListParts correctly says
    // NoSuchUpload even though the assembled object exists. Surface that state
    // so the client can replay only the idempotent registration step.
    if (error.includes("NoSuchUpload")) {
      const assembled = await validateAssembledObject(c, key, upload.size_bytes);
      if (!(assembled instanceof Response)) {
        return c.json({
          status: "assembled",
          assembly_complete: true,
          part_size: MULTIPART_PART_BYTES,
          part_count: partCountForSize(upload.size_bytes),
          parts: [],
        });
      }
    }
    logUpload("error", "multipart_status_failed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      error,
    });
    return c.json({ error: err instanceof Error ? err.message : "listParts failed" }, 502);
  }
  return c.json({
    status: upload.status,
    part_size: MULTIPART_PART_BYTES,
    part_count: partCountForSize(upload.size_bytes),
    parts, // [{partNumber, etag}]
  });
});

// Step 3: finalize. Completes the R2 multipart, head()-validates the assembled
// object (type + size, including a match against the size declared at init so a
// truncated upload can't slip through), writes the moment row, and closes the
// uploads row. On any validation failure the object is deleted + the upload is
// marked aborted.
app.post("/api/events/:slug/moments/multipart/complete", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  // Sessions opened before the close get a short grace, not until purge.
  if (!event.uploads_finishing) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) {
    return c.json({ error: "Large direct uploads are not configured" }, 501);
  }

  const body = (await c.req.json().catch(() => null)) as {
    upload_id?: unknown;
    key?: unknown;
    caption?: unknown;
    uploader_name?: unknown;
    parts?: unknown;
  } | null;

  const uploadId = typeof body?.upload_id === "string" ? body.upload_id : "";
  const key = typeof body?.key === "string" ? body.key : "";
  const caption = typeof body?.caption === "string" ? body.caption.trim() : null;
  const uploaderName = typeof body?.uploader_name === "string" ? body.uploader_name.trim() : "";
  const parts = Array.isArray(body?.parts) ? body.parts : null;

  if (!uploadId || !key || !uploaderName || !parts) {
    return c.json({ error: "upload_id, key, uploader_name, and parts are required" }, 400);
  }
  if (!registrationKeyBelongsToEvent(event.id, key)) {
    return c.json({ error: "key does not belong to this event" }, 400);
  }
  const upload = await getUpload(c.env.DB, event.id, uploadId, key);
  if (!upload) return c.json({ error: "upload not found" }, 404);
  const existingMoment = await getMomentForUpload(c.env.DB, event.id, key);
  if (existingMoment) {
    if (upload.status !== "completed") {
      await c.env.DB.prepare(
        "UPDATE uploads SET status = 'completed', completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?"
      ).bind(upload.id).run();
    }
    logUpload("info", "multipart_completion_replayed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      momentId: existingMoment.id,
    });
    return c.json({ moment: existingMoment, points_awarded: existingMoment.points_awarded });
  }
  let validated: { contentType: string; size: number } | Response | undefined;
  if (upload.status !== "open") {
    validated = await validateAssembledObject(c, key, upload.size_bytes);
    if (validated instanceof Response) return c.json({ error: "upload is not open" }, 409);
    logUpload("warn", "multipart_aborted_registration_recovered", {
      eventId: event.id,
      uploadRecordId: upload.id,
      sizeBytes: validated.size,
    });
  }

  // Normalize + sanity-check the part list the client sends (ETags captured
  // from each part PUT's response header). R2's Complete call is the final
  // authority on ETag correctness; we just need numbers + strings in order.
  const cleanedParts = parts
    .map((p: unknown) =>
      p && typeof p === "object" && "partNumber" in p && "etag" in p
        ? { partNumber: Number((p as { partNumber: unknown }).partNumber), etag: String((p as { etag: unknown }).etag) }
        : null
    )
    .filter((p: { partNumber: number; etag: string } | null): p is { partNumber: number; etag: string } => p !== null);
  if (cleanedParts.length !== partCountForSize(upload.size_bytes)) {
    logUpload("warn", "multipart_part_count_rejected", {
      eventId: event.id,
      uploadRecordId: upload.id,
      receivedParts: cleanedParts.length,
      expectedParts: partCountForSize(upload.size_bytes),
    });
    return c.json({ error: "part count does not match file size" }, 400);
  }

  try {
    if (!validated) await completeMultipartUpload(c.env, key, uploadId, cleanedParts);
  } catch (err) {
    // The R2 Complete call may have succeeded even if its response was lost.
    // If the final object is present and exact, continue registration instead
    // of trapping the client in a permanent NoSuchUpload retry loop.
    validated = await validateAssembledObject(c, key, upload.size_bytes);
    if (validated instanceof Response) {
      logUpload("error", "multipart_complete_failed", {
        eventId: event.id,
        uploadRecordId: upload.id,
        error: err instanceof Error ? err.message : "complete failed",
      });
      return c.json({ error: err instanceof Error ? err.message : "complete failed" }, 502);
    }
    logUpload("warn", "multipart_complete_response_recovered", {
      eventId: event.id,
      uploadRecordId: upload.id,
      sizeBytes: validated.size,
    });
  }

  validated ??= await validateAssembledObject(c, key, upload.size_bytes);
  if (validated instanceof Response) {
    await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(upload.id).run();
    logUpload("error", "multipart_validation_failed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      status: validated.status,
    });
    return validated;
  }

  const points = pointsForContentType(validated.contentType);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, event.id, uploaderName, `/media/${key}`, caption, points, validated.size, validated.contentType || null)
    .run();
  await c.env.DB.prepare(
    "UPDATE uploads SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  )
    .bind(upload.id)
    .run();
  await upsertParticipant(c.env.DB, event.id, uploaderName);

  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(id)
    .first<MomentRow>();
  logUpload("info", "multipart_completed", {
    eventId: event.id,
    uploadRecordId: upload.id,
    momentId: id,
    sizeBytes: validated.size,
    contentType: validated.contentType,
  });
  return c.json({ moment, points_awarded: points }, 201);
});

// Cancel: frees the storage held by uploaded parts. Always call on give-up.
app.post("/api/events/:slug/moments/multipart/abort", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  if (!isR2Configured(c.env)) {
    return c.json({ error: "Large direct uploads are not configured" }, 501);
  }

  const body = (await c.req.json().catch(() => null)) as {
    upload_id?: unknown;
    key?: unknown;
  } | null;

  const uploadId = typeof body?.upload_id === "string" ? body.upload_id : "";
  const key = typeof body?.key === "string" ? body.key : "";
  if (!uploadId || !key) return c.json({ error: "upload_id and key are required" }, 400);
  if (!registrationKeyBelongsToEvent(event.id, key)) {
    return c.json({ error: "key does not belong to this event" }, 400);
  }

  try {
    await abortMultipartUpload(c.env, key, uploadId);
  } catch (err) {
    logUpload("error", "multipart_abort_failed", {
      eventId: event.id,
      error: err instanceof Error ? err.message : "abort failed",
    });
    return c.json({ error: err instanceof Error ? err.message : "abort failed" }, 502);
  }
  await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE upload_id = ? AND key = ? AND event_id = ?")
    .bind(uploadId, key, event.id)
    .run();
  logUpload("info", "multipart_aborted", { eventId: event.id });
  return c.json({ aborted: true });
});

app.get("/api/events/:slug/participants", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT ${PUBLIC_PARTICIPANT_COLUMNS} FROM participants WHERE event_id = ? ORDER BY joined_at ASC`
  )
    .bind(event.id)
    .all<PublicParticipant>();

  return c.json({ participants: results });
});

app.post("/api/events/:slug/participants", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const body = await c.req.parseBody();
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
  const avatarSeed = typeof body.avatar_seed === "string" ? body.avatar_seed.trim() || null : null;

  if (!nickname) {
    return c.json({ error: "nickname is required" }, 400);
  }
  if (nickname.length > MAX_NICKNAME_LENGTH) {
    return c.json({ error: `nickname must be at most ${MAX_NICKNAME_LENGTH} characters` }, 400);
  }

  const result = await joinEventAsGuest(c.env.DB, {
    eventId: event.id,
    nickname,
    avatarSeed: avatarSeed?.slice(0, 100) ?? null,
    presentedToken: c.req.header(GUEST_TOKEN_HEADER) ?? null,
    enforceClaims: c.env.GUEST_TOKENS_ENFORCED === "true",
  });
  if (!result.ok) {
    return c.json({ error: "This nickname is already taken in this event.", code: result.error }, 409);
  }

  // guest_token is present only when this request won the nickname; a client
  // re-joining with its current token keeps using that token.
  return c.json(
    { participant: toPublicParticipant(result.participant), ...(result.guestToken ? { guest_token: result.guestToken } : {}) },
    200
  );
});

app.get("/api/events/:slug/leaderboard", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT
       p.nickname AS uploader_name,
       COALESCE(SUM(m.points_awarded), 0) AS total_points,
       COUNT(m.id) AS moment_count
     FROM participants p
     LEFT JOIN moments m ON m.event_id = p.event_id AND m.uploader_name = p.nickname AND m.moderation_status = 'approved'
     WHERE p.event_id = ?
     GROUP BY p.nickname
     ORDER BY total_points DESC, p.joined_at ASC`
  )
    .bind(event.id)
    .all<LeaderboardEntry>();

  return c.json({ leaderboard: results });
});

app.post("/api/admin/generate-banner", async (c) => {
  if (!c.env.OPENAI_API_KEY) {
    return c.json({ error: "AI banner generation is not configured" }, 501);
  }

  const body = await c.req.parseBody();
  const selfie = body.selfie instanceof File ? body.selfie : null;
  const theme = typeof body.theme === "string" ? body.theme : "";

  if (!selfie || selfie.size === 0) {
    return c.json({ error: "selfie is required" }, 400);
  }

  try {
    const { url } = await generateAiBanner(c.env, selfie, theme);
    return c.json({ banner_url: url });
  } catch (err) {
    const message = err instanceof BannerGenerationError ? err.message : "Banner generation failed";
    return c.json({ error: message }, 400);
  }
});

type MediaEvent = Pick<EventRow, "id" | "access_mode" | "invite_token" | "access_version">;

app.get("/media/*", async (c) => {
  const key = c.req.path.slice("/media/".length);
  const eventId = /^events\/([^/]+)\//.exec(key)?.[1];
  // Only what the access check needs; the three lookups are independent.
  const eventColumns = "id, access_mode, invite_token, access_version";
  const secret = c.env.EVENT_ACCESS_SECRET;
  const [mediaEvent, isHidden, isAdminView] = await Promise.all([
    eventId
      ? c.env.DB.prepare(`SELECT ${eventColumns} FROM events WHERE id = ?`).bind(eventId).first<MediaEvent>()
      : c.env.DB.prepare(`SELECT ${eventColumns} FROM events WHERE cover_image_url = ? LIMIT 1`)
          .bind(`/media/${key}`).first<MediaEvent>(),
    isHiddenMomentMedia(c.env.DB, key),
    // Admin dashboard loads (hidden or private media) carry a signed ?mv= view.
    secret
      ? verifyMediaView(secret, key, c.req.query(MEDIA_VIEW_PARAM), Math.floor(Date.now() / 1000))
      : Promise.resolve(false),
  ]);
  if (!isAdminView) {
    if (mediaEvent?.access_mode === "private" && !(await verifyEventAccess(c, mediaEvent))) {
      return c.json({ error: "access required" }, 401);
    }
    // Hidden moments disappear from the feed and from direct links alike.
    if (isHidden) return c.notFound();
  }
  // Not immutable: hiding a moment must take effect, so browsers revalidate
  // after 5 minutes (cheap: ETag -> 304, and the hidden check runs again).
  const mediaCacheControl = mediaEvent?.access_mode === "private" || isAdminView
    ? "private, max-age=300"
    : "public, max-age=300";
  const ifNoneMatch = c.req.header("If-None-Match") ?? "";
  const rangeHeader = c.req.header("Range") ?? "";
  // Single byte range only (what browsers send for <video> seeking): bytes=a-b,
  // bytes=a-, or bytes=-b. "bytes=-" (no digits) is not a range.
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  const wantsRange = rangeMatch !== null && rangeHeader !== "bytes=-";
  const conditional = ifNoneMatch.length > 0;

  // Fast path: no cache revalidation and no byte-range → stream the whole object
  // exactly like before (one R2 get, no head()). Covers image card loads.
  if (!wantsRange && !conditional) {
    const object = await c.env.BUCKET.get(key);
    if (!object) return c.notFound();
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": mediaCacheControl,
        "Accept-Ranges": "bytes",
        ETag: object.httpEtag,
      },
    });
  }

  // For a 304 or a 206 we need the total size (+ etag), so pay one cheap head()
  // call — metadata only, no body transfer, edge-cacheable.
  const meta = await c.env.BUCKET.head(key);
  if (!meta) return c.notFound();
  const total = meta.size;
  const etag = meta.httpEtag;
  const baseHeaders: Record<string, string> = {
    "Content-Type": meta.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": mediaCacheControl,
    "Accept-Ranges": "bytes",
    ETag: etag,
  };

  // 304: client already has this exact object. Common: media is cached for an
  // hour and then revalidated (hidden moments are rejected above, never 304).
  if (conditional && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  // 206: single byte range (video seeking). Clamp to object bounds; 416 if the
  // start is past the end.
  if (wantsRange && rangeMatch) {
    const startStr = rangeMatch[1];
    const endStr = rangeMatch[2];
    let offset: number;
    let length: number;
    if (startStr === "") {
      // suffix: bytes=-N → last N bytes
      const n = parseInt(endStr, 10);
      length = Math.min(n, total);
      offset = total - length;
    } else {
      offset = parseInt(startStr, 10);
      if (offset >= total) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
        });
      }
      length = endStr === "" ? total - offset : Math.min(parseInt(endStr, 10), total - 1) - offset + 1;
    }
    const obj = await c.env.BUCKET.get(key, { range: { offset, length } });
    if (!obj) return c.notFound();
    const end = offset + length - 1;
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(length),
        "Content-Range": `bytes ${offset}-${end}/${total}`,
      },
    });
  }

  // Conditional but the etag didn't match, no range → serve the full body.
  const object = await c.env.BUCKET.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, { headers: baseHeaders });
});

async function serveNoIndexSpa(c: Context<{ Bindings: Env }>): Promise<Response> {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", NO_INDEX);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

app.get("/admin", serveNoIndexSpa);
app.get("/admin/*", serveNoIndexSpa);
app.get("/e/*", serveNoIndexSpa);

app.onError((err, c) => {
  // Fail closed: without a working key we cannot hand out private video URLs.
  if (err instanceof StreamSigningError) return c.json(STREAM_SIGNING_UNAVAILABLE, 503);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Sequential: both spend the invocation's subrequest budget on R2 calls.
    ctx.waitUntil(cleanupExpiredEvents(env).then(() => abortOrphanUploads(env)));
    ctx.waitUntil(pruneAccessFailures(env));
  },
} satisfies ExportedHandler<Env>;
