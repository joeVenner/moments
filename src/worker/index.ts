import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { getEventAnalytics } from "./adminAnalytics";
import { deleteAdminMoment } from "./adminModeration";
import type { Env, EventRow, MomentRow, LeaderboardEntry, UploadRow } from "./types";
import { insertEvent, normalizeDate } from "./eventWrites";
import { lifecycleChangeFrom, type SettingsRefusal, updateEventAccess, updateEventLifecycle } from "./eventSettings";
import { putMedia, pointsForContentType, isAllowedContentType, MAX_UPLOAD_BYTES, momentKey } from "./storage";
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
  presignBoundPutUrl,
  MULTIPART_PART_BYTES,
} from "./multipartPresign";
import { requireAdmin } from "./auth";
import { canFinishUploads, getActiveEventBySlug, getEventBySlug, toPublicEvent, UPLOADS_CLOSED } from "./events";
import {
  isHiddenMomentMedia,
  MEDIA_GRANT_PARAM,
  MEDIA_VIEW_PARAM,
  verifyMediaGrant,
  verifyMediaView,
  withAdminViewUrls,
} from "./mediaAccess";
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
} from "./streamSigning";
import {
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_URL_TTL_SECONDS,
  acceptThumbnail,
  isThumbnailUploadKey,
  isValidThumbnailSize,
  thumbnailKeys,
  thumbnailUploadKey,
} from "./thumbnails";
import { cleanupEvent, cleanupExpiredEvents, pruneAccessFailures } from "./lifecycle";
import { abortOrphanUploads } from "./orphanUploads";
import { finalizeReadyUploads, r2FinalizeBackend } from "./uploadFinalize";
import { withWebThumbnail } from "./media";
import { attemptEventAccess } from "./accessAttempt";
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
  resolveGuestSession,
  toPublicParticipant,
  type PublicParticipant,
} from "./guestIdentity";
import { leaveEvent, leaveStorage } from "./guestLeave";
import { isJoinLimited, JOIN_RATE_LIMITED, JOIN_RETRY_AFTER_SECONDS } from "./joinLimit";
import { gateReaction, GUEST_REQUIRED, REACTOR_ID_PATTERN, setReaction, viewerReactorId } from "./reactions";
import { finishAccess, guestMoment, resolveWebUploader, uploadAccess, uploadRefusal } from "./webUploader";
import { cleanWebCaption } from "./captionText";
import {
  grantEventAccess,
  verifyEventAccess,
} from "./eventAccess";
import {
  APPLE_APP_SITE_ASSOCIATION_PATH,
  appleAppSiteAssociation,
  isSmartAppBannerOn,
  withoutValidators,
  withSmartAppBanner,
} from "./appleApp";

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

// Fetched by Apple's CDN, not browsers: plain JSON, cacheable, never a redirect.
app.get(APPLE_APP_SITE_ASSOCIATION_PATH, (c) => {
  // Short until the app is verified live: a wrong file would otherwise stick.
  c.header("Cache-Control", "public, max-age=300");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Robots-Tag", NO_INDEX);
  return c.json(appleAppSiteAssociation(), 200);
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

/** Best effort: the event's purge removes anything left behind. */
async function deleteThumbnailUploads(env: Env, eventId: string, uploadRecordId: string, keys: string[]): Promise<void> {
  try {
    await env.BUCKET.delete(keys);
  } catch (err) {
    logUpload("error", "multipart_thumbnail_delete_failed", {
      eventId,
      uploadRecordId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
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

  await insertEvent(
    c.env.DB,
    { title, type, mainCharacters, description, coverImageUrl, startsAt: null, expiresAt },
    id
  );

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
  const result = await attemptEventAccess(c.env.DB, secret, event, {
    pin: typeof body?.pin === "string" ? body.pin : "",
    inviteToken: typeof body?.invite_token === "string" ? body.invite_token : "",
    clientIp: c.req.header("CF-Connecting-IP") ?? "unknown",
  });
  if (result.kind === "blocked") {
    return c.json(
      {
        error: "too many attempts",
        retry_after_seconds: result.retryAfterSeconds,
        hint: "ask the host for the invitation link",
      },
      429,
      { "Retry-After": String(result.retryAfterSeconds) }
    );
  }
  if (result.kind === "invalid") return c.json({ error: "invalid event access" }, 401);
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

/** The web's answer for a refused settings change (its messages are unchanged). */
function webSettingsRefusal(c: Context<{ Bindings: Env }>, refusal: SettingsRefusal) {
  return refusal.kind === "not_found"
    ? c.json({ error: "event not found" }, 404)
    : c.json({ error: refusal.error }, 400);
}

app.patch("/api/admin/events/:id/access", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { mode?: unknown; pin?: unknown } | null;
  const mode = body?.mode;
  if (mode !== "public" && mode !== "private") {
    const exists = await c.env.DB.prepare("SELECT 1 FROM events WHERE id = ?").bind(id).first();
    return exists ? c.json({ error: "invalid access mode" }, 400) : c.json({ error: "event not found" }, 404);
  }
  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  const result = await updateEventAccess(c.env, id, { mode, pin }, (work) => c.executionCtx.waitUntil(work));
  if (result.kind !== "ok") return webSettingsRefusal(c, result);
  const updated = await c.env.DB.prepare(
    `SELECT id, slug, title, type, main_characters, description, cover_image_url,
            created_at, starts_at, expires_at, uploads_close_at, purge_after, archived_at, access_mode, invite_token
       FROM events WHERE id = ?`
  ).bind(id).first<EventRow>();
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
    const parsed = lifecycleChangeFrom(body ?? {});
    if (parsed.kind === "invalid") return c.json({ error: `${parsed.field} is invalid` }, 400);
    const result = await updateEventLifecycle(c.env.DB, event.id, parsed.change);
    if (result.kind !== "ok") return webSettingsRefusal(c, result);
  }
  const updated = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(event.id).first<EventRow>();
  return c.json({ event: updated });
});

// The web feed's moment shape. Explicit so new internal columns (R2 keys,
// media metadata) never leak to guests by default.
const WEB_MOMENT_COLUMNS = `m.id, m.event_id, m.uploader_name, m.media_url, m.caption, m.points_awarded,
  m.created_at, m.size_bytes, m.mime_type, m.moderation_status, m.thumb_key`;

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
  const reactorId = await viewerReactorId(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientReactorId: c.req.query("reactor_id"),
  });

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

  // `reacted` is this guest's (token): never let a cache share it.
  c.header("Cache-Control", "no-store");
  return c.json({
    moments: await signMomentsForEvent(c.env, event, results.map(withWebThumbnail)),
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
    reactorId: await viewerReactorId(c.env, {
      eventId: event.id,
      token: c.req.header(GUEST_TOKEN_HEADER),
      clientReactorId: c.req.query("reactor_id"),
    }),
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
    reactorId: await viewerReactorId(c.env, {
      eventId: event.id,
      token: c.req.header(GUEST_TOKEN_HEADER),
      clientReactorId: c.req.query("reactor_id"),
    }),
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

  // Parsed lazily: an enforced request without a token is refused unread.
  let parsed: Awaited<ReturnType<typeof c.req.parseBody>> | undefined;
  const readBody = async () => (parsed ??= await c.req.parseBody());
  const uploader = await resolveWebUploader(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientName: async () => (await readBody()).uploader_name,
  });
  if (!uploader.ok) return c.json(uploader.body, uploader.status);
  const { uploaderName, participantId } = uploader;
  const body = await readBody();
  const caption = typeof body.caption === "string" ? cleanWebCaption(body.caption) : null;
  const file = body.file instanceof File ? body.file : null;

  if (!file || file.size === 0) {
    return c.json({ error: "file is required" }, 400);
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
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type, participant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, event.id, uploaderName, mediaUrl, caption, points, file.size, file.type || null, participantId)
    .run();

  // Defensive: guarantees a participant row exists even if the client somehow
  // uploaded without going through the nickname-gate join step, so the
  // leaderboard and participant strip never silently drop an uploader.
  await upsertParticipant(c.env.DB, event.id, uploaderName);

  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?")
    .bind(id)
    .first<MomentRow>();

  return c.json({ moment: moment && guestMoment(withWebThumbnail(moment)), points_awarded: points }, 201);
});

app.get("/api/events/:slug/highlights", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const reactorId = await viewerReactorId(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientReactorId: c.req.query("reactor_id"),
  });
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
  // `reacted` is this guest's (token): never let a cache share it.
  c.header("Cache-Control", "no-store");
  return c.json({ moments: await signMomentsForEvent(c.env, event, results.map(withWebThumbnail)) });
});

app.post("/api/events/:slug/moments/:id/reactions", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { reactor_id?: unknown } | null;
  // Optional with a guest token (the server reacts as that guest). When sent,
  // same shape as v1 (web ids are UUIDs); never a server-made `guest:` id.
  const reactorId = body?.reactor_id === undefined ? undefined : typeof body.reactor_id === "string" ? body.reactor_id : "";
  if (reactorId !== undefined && !REACTOR_ID_PATTERN.test(reactorId)) return c.json({ error: "reactor_id is invalid" }, 400);
  const gate = await gateReaction(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientIp: c.req.header("CF-Connecting-IP"),
    reactorId,
  });
  if (!gate.ok) return c.json(gate.body, gate.status);
  // A toggle is "set the opposite of now"; setReaction makes the write
  // idempotent, so a double tap can't hit the UNIQUE constraint.
  const momentId = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT 1 AS found FROM moment_reactions WHERE moment_id = ? AND event_id = ? AND reactor_id = ?"
  ).bind(momentId, event.id, gate.reactorId).first<{ found: number }>();
  const state = await setReaction(c.env.DB, { eventId: event.id, momentId, reactorId: gate.reactorId, reacted: !existing });
  if (!state) return c.json({ error: "moment not found" }, 404);
  return c.json(state);
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
  return c.json(await getEventAnalytics(c.env.DB, event.id));
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
  try {
    if ((await deleteAdminMoment(c.env, c.req.param("id"))) === "not_found") {
      return c.json({ error: "moment not found" }, 404);
    }
  } catch (error) {
    // The cause stays in the logs: storage errors can name internal endpoints.
    console.error(JSON.stringify({ msg: "admin_moment_delete_failed", reason: error instanceof Error ? error.name : "unknown" }));
    return c.json({ error: "unable to delete media" }, 502);
  }
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

const V1_SESSION_ERROR = { error: "this upload is managed by the app API", code: "v1_upload_session" } as const;

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
  const uploader = await resolveWebUploader(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientName: () => body?.uploader_name,
  });
  if (!uploader.ok) return c.json(uploader.body, uploader.status);
  const { uploaderName, participantId } = uploader;
  const contentType = typeof body?.content_type === "string" ? body.content_type.toLowerCase() : "";
  const size = typeof body?.size === "number" ? body.size : NaN;
  if (!contentType.startsWith("video/") || !isAllowedContentType(contentType)) {
    return c.json({ error: "unsupported video type" }, 400);
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_DIRECT_UPLOAD_BYTES) {
    return c.json({ error: "File too large (max 512MB)" }, 400);
  }
  const sessionId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status, participant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  )
    .bind(sessionId, event.id, uploaderName, `stream-session/${sessionId}`, sessionId, contentType, size, participantId)
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
    const recorded = await c.env.DB.prepare(
      "UPDATE uploads SET key = ?, upload_id = ? WHERE id = ? AND event_id = ? AND status = 'open'"
    )
      .bind(`stream/${streamUid}`, streamUid, session.id, event.id)
      .run();
    if (recorded.meta.changes !== 1) {
      // The session was aborted meanwhile (the guest cancelled or left): no
      // row would ever point at this video, so it goes now.
      await fetch(streamApiUrl(c.env, `/${streamUid}`), {
        method: "DELETE",
        headers: streamAuthHeaders(c.env),
      }).catch(() => {});
      logUpload("warn", "stream_tus_session_closed", { eventId: event.id, uploadRecordId: session.id });
      return c.json({ error: "upload not found" }, 409);
    }
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
  const caption = typeof body?.caption === "string" ? cleanWebCaption(body.caption) : null;
  if (!streamUid || !uploaderName) return c.json({ error: "stream_uid and uploader_name are required" }, 400);

  const upload = await getUpload(c.env.DB, event.id, streamUid, `stream/${streamUid}`);
  // App sessions never finish here.
  if (!upload || upload.client_upload_id) return c.json({ error: "upload not found" }, 404);
  const token = c.req.header(GUEST_TOKEN_HEADER);
  const access = await finishAccess(c.env, { eventId: event.id, token, row: upload, clientName: uploaderName });
  if (access !== "ok") {
    const refusal = uploadRefusal(access);
    return c.json(refusal.body, refusal.status);
  }
  const mediaUrl = streamMediaUrl(c.env, streamUid);
  const existingMoment = await c.env.DB.prepare("SELECT * FROM moments WHERE event_id = ? AND media_url = ?")
    .bind(event.id, mediaUrl)
    .first<MomentRow>();
  if (existingMoment) {
    // A replay; a moment hidden meanwhile isn't handed back.
    if (existingMoment.moderation_status !== "approved") return c.json({ error: "upload not found" }, 404);
    const [signedExisting] = await signMomentsForEvent(c.env, event, [existingMoment]);
    return c.json({ moment: guestMoment(withWebThumbnail(signedExisting)), points_awarded: existingMoment.points_awarded });
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
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type, participant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    // The row's name and owner, set when the session opened (never the body's).
    .bind(momentId, event.id, upload.uploader_name, mediaUrl, caption, points, upload.size_bytes, upload.content_type, upload.participant_id)
    .run();
  await c.env.DB.prepare(
    "UPDATE uploads SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  ).bind(upload.id).run();
  await upsertParticipant(c.env.DB, event.id, upload.uploader_name);
  const moment = await c.env.DB.prepare("SELECT * FROM moments WHERE id = ?").bind(momentId).first<MomentRow>();
  logUpload("info", "stream_upload_completed", {
    eventId: event.id,
    uploadRecordId: upload.id,
    momentId,
    sizeBytes: upload.size_bytes,
  });
  if (!moment) return c.json({ error: "moment not found" }, 500);
  const [signedMoment] = await signMomentsForEvent(c.env, event, [moment]);
  return c.json({ moment: signedMoment && guestMoment(withWebThumbnail(signedMoment)), points_awarded: points }, 201);
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
  const access = await uploadAccess(c.env, { eventId: event.id, token: c.req.header(GUEST_TOKEN_HEADER), row: upload });
  if (access !== "ok") {
    const refusal = uploadRefusal(access);
    return c.json(refusal.body, refusal.status);
  }

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

  const uploader = await resolveWebUploader(c.env, {
    eventId: event.id,
    token: c.req.header(GUEST_TOKEN_HEADER),
    clientName: () => body?.uploader_name,
  });
  if (!uploader.ok) return c.json(uploader.body, uploader.status);
  const { uploaderName, participantId } = uploader;
  const contentType = typeof body?.content_type === "string" ? body.content_type.toLowerCase() : "";
  const size = typeof body?.size === "number" ? body.size : NaN;
  const filename = typeof body?.filename === "string" ? body.filename : "upload";

  if (!isAllowedContentType(contentType)) return c.json({ error: "Unsupported file type" }, 400);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_DIRECT_UPLOAD_BYTES) {
    return c.json({ error: "File too large (max 512MB)" }, 400);
  }

  const key = momentKey(event.id, filename);
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
    `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status, participant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  )
    .bind(id, event.id, uploaderName, key, uploadId, contentType || null, size, participantId)
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
  const access = await uploadAccess(c.env, { eventId: event.id, token: c.req.header(GUEST_TOKEN_HEADER), row: upload });
  if (access !== "ok") {
    const refusal = uploadRefusal(access);
    return c.json(refusal.body, refusal.status);
  }

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

// Optional: a presigned PUT for the moment's ~400 px JPEG grid thumbnail,
// bound to image/jpeg and the exact size. Sent before the parts; complete
// keeps it only if it is a whole JPEG, and never fails because of it. Older
// clients never call this, and their moments simply have no thumbnail.
app.post("/api/events/:slug/moments/multipart/thumbnail-url", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  if (!event.uploads_finishing) return c.json(UPLOADS_CLOSED, 403);
  if (!isR2Configured(c.env)) {
    return c.json({ error: "Large direct uploads are not configured" }, 501);
  }

  const body = (await c.req.json().catch(() => null)) as {
    upload_id?: unknown;
    key?: unknown;
    size?: unknown;
  } | null;

  const uploadId = typeof body?.upload_id === "string" ? body.upload_id : "";
  const key = typeof body?.key === "string" ? body.key : "";
  const size = typeof body?.size === "number" ? body.size : NaN;
  if (!uploadId || !key || !isValidThumbnailSize(size)) {
    return c.json({ error: "upload_id, key, and size (1..204800) are required" }, 400);
  }
  if (!registrationKeyBelongsToEvent(event.id, key)) {
    return c.json({ error: "key does not belong to this event" }, 400);
  }
  const upload = await getOpenUpload(c.env.DB, event.id, uploadId, key);
  if (!upload) return c.json({ error: "upload not found" }, 404);
  // App sessions use v1's thumbnail-url.
  if (upload.client_upload_id) return c.json(V1_SESSION_ERROR, 409);
  const access = await uploadAccess(c.env, { eventId: event.id, token: c.req.header(GUEST_TOKEN_HEADER), row: upload });
  if (access !== "ok") {
    const refusal = uploadRefusal(access);
    return c.json(refusal.body, refusal.status);
  }

  try {
    const url = await presignBoundPutUrl(c.env, thumbnailUploadKey(key), THUMBNAIL_CONTENT_TYPE, size, THUMBNAIL_URL_TTL_SECONDS);
    return c.json({ url, expires_in: THUMBNAIL_URL_TTL_SECONDS });
  } catch (err) {
    logUpload("error", "multipart_thumbnail_presign_failed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      error: err instanceof Error ? err.name : "presign failed",
    });
    return c.json({ error: "presign failed" }, 502);
  }
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
  const access = await uploadAccess(c.env, { eventId: event.id, token: c.req.header(GUEST_TOKEN_HEADER), row: upload });
  if (access !== "ok") {
    const refusal = uploadRefusal(access);
    return c.json(refusal.body, refusal.status);
  }
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
  const caption = typeof body?.caption === "string" ? cleanWebCaption(body.caption) : null;
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
  // App sessions finish through v1, which checks part sizes and file bytes.
  if (upload.client_upload_id) return c.json(V1_SESSION_ERROR, 409);
  const token = c.req.header(GUEST_TOKEN_HEADER);
  const access = await finishAccess(c.env, { eventId: event.id, token, row: upload, clientName: uploaderName });
  if (access !== "ok") {
    const refusal = uploadRefusal(access);
    return c.json(refusal.body, refusal.status);
  }
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
    if (existingMoment.moderation_status !== "approved") return c.json({ error: "upload not found" }, 404);
    return c.json({ moment: guestMoment(withWebThumbnail(existingMoment)), points_awarded: existingMoment.points_awarded });
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
    // No moment exists: both the slot and any served copy go.
    await deleteThumbnailUploads(c.env, event.id, upload.id, thumbnailKeys(key));
    logUpload("error", "multipart_validation_failed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      status: validated.status,
    });
    return validated;
  }

  const points = pointsForContentType(validated.contentType);
  const id = crypto.randomUUID();
  // Optional: a missing, bad or unreadable thumbnail never holds the moment
  // back (the feed falls back to the file).
  const thumbKey = await acceptThumbnail(r2FinalizeBackend(c.env), key).catch((err: unknown) => {
    logUpload("error", "thumbnail_check_failed", {
      eventId: event.id,
      uploadRecordId: upload.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  });
  await c.env.DB.prepare(
    `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type, participant_id, thumb_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    // The row's name and owner, set at init (never the body's).
    .bind(id, event.id, upload.uploader_name, `/media/${key}`, caption, points, validated.size, validated.contentType || null, upload.participant_id, thumbKey)
    .run();
  await c.env.DB.prepare(
    "UPDATE uploads SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  )
    .bind(upload.id)
    .run();
  await upsertParticipant(c.env.DB, event.id, upload.uploader_name);

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
  return c.json({ moment: moment && guestMoment(withWebThumbnail(moment)), points_awarded: points }, 201);
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
  const upload = await getUpload(c.env.DB, event.id, uploadId, key);
  if (upload?.client_upload_id) return c.json(V1_SESSION_ERROR, 409);
  if (upload) {
    const access = await uploadAccess(c.env, { eventId: event.id, token: c.req.header(GUEST_TOKEN_HEADER), row: upload });
    if (access !== "ok") {
      const refusal = uploadRefusal(access);
      return c.json(refusal.body, refusal.status);
    }
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
  await c.env.DB.prepare(
    "UPDATE uploads SET status = 'aborted' WHERE upload_id = ? AND key = ? AND event_id = ? AND client_upload_id IS NULL"
  )
    .bind(uploadId, key, event.id)
    .run();
  // Only the never-served slot, and only for a row this caller may act on:
  // a served `.thumb.jpg` belongs to a moment (the purge removes any orphan).
  if (upload && upload.status !== "completed") await deleteThumbnailUploads(c.env, event.id, upload.id, [thumbnailUploadKey(key)]);
  logUpload("info", "multipart_aborted", { eventId: event.id });
  return c.json({ aborted: true });
});

// "Leave and delete my uploads" from the web; the same work as the app's
// v1 route (guestLeave.ts). Only the token's guest can leave, enforced or not:
// there is nothing to own without one. Call again until `done`.
app.post("/api/events/:slug/leave", async (c) => {
  const event = await getActiveEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
  const session = await resolveGuestSession(c.env.DB, event.id, c.req.header(GUEST_TOKEN_HEADER));
  if (!session) return c.json(GUEST_REQUIRED, 403);
  c.header("Cache-Control", "no-store");
  if (c.env.UPLOAD_LIMITER) {
    // Same key as the app's leave: one budget per guest across both.
    const { success } = await c.env.UPLOAD_LIMITER.limit({ key: `${event.id}:guest:${session.sessionId}` });
    if (!success) return c.json({ error: "too many requests", code: "rate_limited" }, 429);
  }
  try {
    const result = await leaveEvent(c.env.DB, leaveStorage(c.env), {
      eventId: event.id,
      participantId: session.participant.id,
    });
    return c.json(result);
  } catch (error) {
    logUpload("error", "web_leave_failed", {
      eventId: event.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return c.json({ error: "Storage is unavailable; try again.", code: "storage_unavailable" }, 502);
  }
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
    isLimited: () => isJoinLimited(c.env.JOIN_LIMITER, event.id, c.req.header("CF-Connecting-IP")),
  });
  if (!result.ok && result.error === "rate_limited") {
    c.header("Retry-After", String(JOIN_RETRY_AFTER_SECONDS));
    return c.json(JOIN_RATE_LIMITED, 429);
  }
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

/**
 * On every /media answer: the bytes are guest uploads, so the browser must
 * never sniff them into something else or run them as a page.
 */
const MEDIA_SAFETY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

/** A served thumbnail is always the JPEG the server wrote; never trust metadata. */
function mediaContentType(key: string, stored: string | undefined): string {
  if (key.endsWith(".thumb.jpg")) return "image/jpeg";
  return stored ?? "application/octet-stream";
}

app.get("/media/*", async (c) => {
  const key = c.req.path.slice("/media/".length);
  // The app's thumbnail upload slot: still writable through its URL, never served.
  if (isThumbnailUploadKey(key)) return c.notFound();
  const eventId = /^events\/([^/]+)\//.exec(key)?.[1];
  // Only what the access check needs; the three lookups are independent.
  const eventColumns = "id, access_mode, invite_token, access_version";
  const secret = c.env.EVENT_ACCESS_SECRET;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [mediaEvent, isHidden, isAdminView] = await Promise.all([
    eventId
      ? c.env.DB.prepare(`SELECT ${eventColumns} FROM events WHERE id = ?`).bind(eventId).first<MediaEvent>()
      : c.env.DB.prepare(`SELECT ${eventColumns} FROM events WHERE cover_image_url = ? LIMIT 1`)
          .bind(`/media/${key}`).first<MediaEvent>(),
    isHiddenMomentMedia(c.env.DB, key),
    // Admin dashboard loads (hidden or private media) carry a signed ?mv= view.
    secret
      ? verifyMediaView(secret, key, c.req.query(MEDIA_VIEW_PARAM), nowSeconds)
      : Promise.resolve(false),
  ]);
  if (!isAdminView) {
    const isPrivate = mediaEvent?.access_mode === "private";
    // Native guests' ?at= is checked first; it covers this one key only.
    const hasGuestGrant =
      isPrivate && secret
        ? await verifyMediaGrant(secret, key, mediaEvent.access_version, c.req.query(MEDIA_GRANT_PARAM), nowSeconds)
        : false;
    if (isPrivate && !hasGuestGrant && !(await verifyEventAccess(c, mediaEvent))) {
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
        ...MEDIA_SAFETY_HEADERS,
        "Content-Type": mediaContentType(key, object.httpMetadata?.contentType),
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
    ...MEDIA_SAFETY_HEADERS,
    "Content-Type": mediaContentType(key, meta.httpMetadata?.contentType),
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

async function serveNoIndexSpa(c: Context<{ Bindings: Env }>, request: Request = c.req.raw): Promise<Response> {
  const response = await c.env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", NO_INDEX);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

app.get("/admin", (c) => serveNoIndexSpa(c));
app.get("/admin/*", (c) => serveNoIndexSpa(c));
app.get("/e/*", async (c) => {
  if (!isSmartAppBannerOn(c.env.APP_STORE_ID)) return serveNoIndexSpa(c);
  const page = await serveNoIndexSpa(c, withoutValidators(c.req.raw));
  return withSmartAppBanner(page, { pageUrl: new URL(c.req.url), appStoreId: c.env.APP_STORE_ID });
});

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
    // Sequential (they share the subrequest budget); finalize before the orphan
    // sweep so a finished upload is kept, not aborted. A failing stage logs and
    // lets the next one run.
    const stage = (name: string, run: () => Promise<unknown>) => () =>
      run().catch((err: unknown) =>
        console.error(JSON.stringify({ scope: "cron", event: "stage_failed", stage: name, error: err instanceof Error ? err.name : "unknown" }))
      );
    ctx.waitUntil(
      stage("cleanup", () => cleanupExpiredEvents(env))()
        .then(stage("finalize", () => finalizeReadyUploads(env)))
        .then(stage("orphans", () => abortOrphanUploads(env)))
    );
    ctx.waitUntil(pruneAccessFailures(env));
  },
} satisfies ExportedHandler<Env>;
