import { isAllowedContentType, sanitizeFilename } from "./storage";
import { MAX_DIRECT_UPLOAD_BYTES } from "./presign";
import { MULTIPART_PART_BYTES, type R2Part } from "./multipartPresign";

/**
 * Upload sessions for the native app (v1). The app uploads parts straight to
 * R2 with presigned URLs, possibly from a background URLSession that runs
 * for hours, so:
 * - init is idempotent per (guest, client_upload_id): a retry after a lost
 *   response returns the same session;
 * - all part URLs come in one call and live for a day (R2 allows 7);
 * - caption and owner are stored at init, so the server can finalize later
 *   without the app (next step: nudge + sweeper).
 * R2's ListParts stays the source of truth for which parts arrived.
 */

/** The R2 multipart calls this module needs (S3 API in production). */
export interface MultipartBackend {
  create(key: string, contentType: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<R2Part[]>;
  abort(key: string, uploadId: string): Promise<void>;
}

/** Part URLs live this long: long enough for a background upload to finish. */
export const PART_URL_TTL_SECONDS = 24 * 60 * 60;
/** Open sessions one guest may hold; a full queue of 8 MiB-part uploads fits. */
export const MAX_OPEN_UPLOADS_PER_GUEST = 50;
export const MAX_CAPTION_LENGTH = 500;
/** The app's id for one queued item: a UUID. */
export const CLIENT_UPLOAD_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface UploadSessionRow {
  id: string;
  event_id: string;
  participant_id: string;
  client_upload_id: string;
  key: string;
  upload_id: string;
  content_type: string;
  size_bytes: number;
  part_size: number;
  caption: string | null;
  status: "open" | "completed" | "aborted";
  created_at: string;
}

export interface StartUploadInput {
  eventId: string;
  participantId: string;
  nickname: string;
  clientUploadId: string;
  contentType: string;
  size: number;
  caption: string | null;
  filename: string | null;
}

export type StartUploadResult =
  | { kind: "started" | "existing"; session: UploadSessionRow }
  | { kind: "invalid"; message: string }
  /** The client id is already used for a different file. */
  | { kind: "conflict" }
  | { kind: "too_many_open" };

const SESSION_COLUMNS = `id, event_id, participant_id, client_upload_id, key, upload_id, content_type,
  size_bytes, part_size, caption, status, created_at`;

export function partCount(session: Pick<UploadSessionRow, "size_bytes" | "part_size">): number {
  return Math.max(1, Math.ceil(session.size_bytes / session.part_size));
}

/** Checks the file before any R2 call; returns an error message or null. */
export function validateUploadInput(input: Pick<StartUploadInput, "clientUploadId" | "contentType" | "size" | "caption">): string | null {
  if (!CLIENT_UPLOAD_ID_PATTERN.test(input.clientUploadId)) return "client_upload_id must be a UUID";
  if (!isAllowedContentType(input.contentType)) return "Unsupported file type";
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_DIRECT_UPLOAD_BYTES) {
    return "File too large (max 512MB)";
  }
  if (input.caption !== null && input.caption.length > MAX_CAPTION_LENGTH) return "Caption is too long";
  return null;
}

async function findByClientId(db: D1Database, input: StartUploadInput): Promise<UploadSessionRow | null> {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM uploads
        WHERE event_id = ? AND participant_id = ? AND client_upload_id = ?`
    )
    .bind(input.eventId, input.participantId, input.clientUploadId)
    .first<UploadSessionRow>();
}

/** The same file as the existing session (a retried init). */
function sameFile(session: UploadSessionRow, input: StartUploadInput): boolean {
  return session.size_bytes === input.size && session.content_type === input.contentType.toLowerCase();
}

/**
 * Opens (or returns) the guest's session for one queued item. A concurrent
 * duplicate init loses the unique-index race, aborts its own R2 multipart
 * and returns the winner.
 */
export async function startUpload(
  db: D1Database,
  backend: MultipartBackend,
  input: StartUploadInput
): Promise<StartUploadResult> {
  const message = validateUploadInput(input);
  if (message) return { kind: "invalid", message };
  const existing = await findByClientId(db, input);
  if (existing) return sameFile(existing, input) ? { kind: "existing", session: existing } : { kind: "conflict" };

  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM uploads WHERE participant_id = ? AND status = 'open'")
    .bind(input.participantId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_UPLOADS_PER_GUEST) return { kind: "too_many_open" };

  const contentType = input.contentType.toLowerCase();
  const key = `events/${input.eventId}/moments/${crypto.randomUUID()}-${sanitizeFilename(input.filename || "upload")}`;
  const uploadId = await backend.create(key, contentType);
  const id = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO uploads
         (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status,
          client_upload_id, participant_id, caption, part_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    )
    .bind(
      id, input.eventId, input.nickname, key, uploadId, contentType, input.size,
      input.clientUploadId, input.participantId, input.caption, MULTIPART_PART_BYTES
    )
    .run();
  if (inserted.meta.changes === 0) {
    await backend.abort(key, uploadId).catch(() => undefined);
    const winner = await findByClientId(db, input);
    if (!winner) throw new Error("upload session vanished after a duplicate init");
    return sameFile(winner, input) ? { kind: "existing", session: winner } : { kind: "conflict" };
  }
  const session = await db.prepare(`SELECT ${SESSION_COLUMNS} FROM uploads WHERE id = ?`).bind(id).first<UploadSessionRow>();
  if (!session) throw new Error("upload session missing after insert");
  return { kind: "started", session };
}

/** The guest's own session in this event, or null (never another guest's). */
export async function getOwnedUpload(
  db: D1Database,
  ref: { eventId: string; participantId: string; uploadId: string }
): Promise<UploadSessionRow | null> {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM uploads
        WHERE id = ? AND event_id = ? AND participant_id = ? AND client_upload_id IS NOT NULL`
    )
    .bind(ref.uploadId, ref.eventId, ref.participantId)
    .first<UploadSessionRow>();
}

export type PartUrlsResult =
  | { kind: "ok"; expiresAt: Date; parts: { part_number: number; url: string }[] }
  | { kind: "invalid"; message: string };

/**
 * Presigned PUT URLs for the requested parts (all parts when none are
 * named). The session must be open; the caller checks ownership.
 */
export async function presignPartUrls(
  backend: MultipartBackend,
  session: UploadSessionRow,
  requested: readonly number[] | undefined,
  now: Date = new Date()
): Promise<PartUrlsResult> {
  const total = partCount(session);
  const numbers = requested?.length ? [...new Set(requested)].sort((a, b) => a - b) : Array.from({ length: total }, (_, i) => i + 1);
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > total)) {
    return { kind: "invalid", message: `part numbers must be between 1 and ${total}` };
  }
  const parts = await Promise.all(
    numbers.map(async (n) => ({
      part_number: n,
      url: await backend.presignPart(session.key, session.upload_id, n, PART_URL_TTL_SECONDS),
    }))
  );
  return { kind: "ok", expiresAt: new Date(now.getTime() + PART_URL_TTL_SECONDS * 1000), parts };
}
