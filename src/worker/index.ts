import { Hono, type Context } from "hono";
import type { Env, EventRow, MomentRow, ParticipantRow, LeaderboardEntry, UploadRow } from "./types";
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
import { generateAiBanner, BannerGenerationError } from "./banner";

const app = new Hono<{ Bindings: Env }>();

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

async function getEventBySlug(db: D1Database, slug: string): Promise<{ id: string } | null> {
  return db.prepare("SELECT id FROM events WHERE slug = ?").bind(slug).first<{ id: string }>();
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

app.get("/api/events", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM events ORDER BY created_at DESC"
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

  if (!title || !type) {
    return c.json({ error: "title and type are required" }, 400);
  }

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
    `INSERT INTO events (id, slug, title, type, main_characters, description, cover_image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, slug, title, type, mainCharacters, description, coverImageUrl)
    .run();

  const event = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(id)
    .first<EventRow>();

  return c.json({ event }, 201);
});

app.get("/api/events/:slug", async (c) => {
  const event = await c.env.DB.prepare("SELECT * FROM events WHERE slug = ?")
    .bind(c.req.param("slug"))
    .first<EventRow>();
  if (!event) return c.json({ error: "event not found" }, 404);
  return c.json({ event });
});

app.get("/api/events/:slug/moments", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  // Offset pagination (not cursor): created_at is a `datetime('now')` text
  // default ("YYYY-MM-DD HH:MM:SS", space-separated), so a cursor comparison
  // would be fragile across formats. Event feeds are small enough that
  // deep-offset cost is a non-issue, and offset keeps ordering bulletproof.
  // Default 25, cap 100 — bounds the initial payload + DOM.
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "25", 10) || 25, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM moments WHERE event_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(event.id, limit, offset)
    .all<MomentRow>();

  // Total event moment count — drives the numbered page nav on the client (the
  // old `hasMore` heuristic is off-by-one at the boundary: a full final page
  // reports hasMore=true even though there's no next page). One cheap COUNT(*).
  const totalRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS c FROM moments WHERE event_id = ?"
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
      "SELECT COALESCE(SUM(points_awarded), 0) AS s FROM moments WHERE event_id = ? AND uploader_name = ?"
    )
      .bind(event.id, uploaderName)
      .first<{ s: number }>();
    your_points = pts?.s ?? 0;
  }

  return c.json({
    moments: results,
    hasMore: results.length === limit,
    total,
    your_points,
  });
});

app.post("/api/events/:slug/moments", async (c) => {
  const oversized = rejectOversizedMultipart(c);
  if (oversized) return oversized;
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

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

// Step 1: initiate. Validates type + size, builds the key, opens the R2
// multipart upload, and writes a D1 `uploads` row. Inert (501) until R2 S3
// creds are configured, same as the single-PUT presign route.
app.post("/api/events/:slug/moments/multipart/init", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);
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
    return c.json({ error: err instanceof Error ? err.message : "init failed" }, 502);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
  )
    .bind(id, event.id, uploaderName, key, uploadId, contentType || null, size)
    .run();

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
  const upload = await c.env.DB.prepare("SELECT * FROM uploads WHERE upload_id = ? AND key = ? AND event_id = ?")
    .bind(uploadId, key, event.id)
    .first<UploadRow>();
  if (!upload) return c.json({ error: "upload not found" }, 404);
  if (upload.status === "completed") return c.json({ error: "upload already completed" }, 409);
  // 'aborted' or 'open' — either way, list what R2 actually has. If aborted,
  // the client should re-init (returned parts let it decide).
  let parts;
  try {
    parts = await listParts(c.env, key, uploadId);
  } catch (err) {
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
  const upload = await getOpenUpload(c.env.DB, event.id, uploadId, key);
  if (!upload) return c.json({ error: "upload not found or already closed" }, 404);

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
    return c.json({ error: "part count does not match file size" }, 400);
  }

  try {
    await completeMultipartUpload(c.env, key, uploadId, cleanedParts);
  } catch (err) {
    // Leave the upload OPEN — the client can retry complete with corrected ETags.
    return c.json({ error: err instanceof Error ? err.message : "complete failed" }, 502);
  }

  const validated = await validateAssembledObject(c, key, upload.size_bytes);
  if (validated instanceof Response) {
    await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(upload.id).run();
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
    return c.json({ error: err instanceof Error ? err.message : "abort failed" }, 502);
  }
  await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE upload_id = ? AND key = ? AND event_id = ?")
    .bind(uploadId, key, event.id)
    .run();
  return c.json({ aborted: true });
});

app.get("/api/events/:slug/participants", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM participants WHERE event_id = ? ORDER BY joined_at ASC"
  )
    .bind(event.id)
    .all<ParticipantRow>();

  return c.json({ participants: results });
});

app.post("/api/events/:slug/participants", async (c) => {
  const event = await getEventBySlug(c.env.DB, c.req.param("slug"));
  if (!event) return c.json({ error: "event not found" }, 404);

  const body = await c.req.parseBody();
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
  const avatarSeed = typeof body.avatar_seed === "string" ? body.avatar_seed.trim() : null;

  if (!nickname) {
    return c.json({ error: "nickname is required" }, 400);
  }

  await upsertParticipant(c.env.DB, event.id, nickname, avatarSeed);

  const participant = await c.env.DB.prepare(
    "SELECT * FROM participants WHERE event_id = ? AND nickname = ?"
  )
    .bind(event.id, nickname)
    .first<ParticipantRow>();

  return c.json({ participant }, 200);
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
     LEFT JOIN moments m ON m.event_id = p.event_id AND m.uploader_name = p.nickname
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

app.get("/media/*", async (c) => {
  const key = c.req.path.slice("/media/".length);
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
        "Cache-Control": "public, max-age=31536000, immutable",
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
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    ETag: etag,
  };

  // 304: client already has this exact object (revalidation). Rare in practice
  // because responses are `immutable`, but correct when browsers do revalidate.
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

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
