import { isAllowedContentType, momentKey } from "./storage";
import { MAX_DIRECT_UPLOAD_BYTES } from "./presign";
import {
  abortMultipartUpload,
  createMultipartUpload,
  listParts,
  MULTIPART_PART_BYTES,
  partCountForSize,
  presignPartUrl,
  R2RequestError,
  type R2Part,
} from "./multipartPresign";
import type { Env } from "./types";

/**
 * Upload sessions for the native app (v1). The app uploads parts straight to
 * R2 with presigned URLs, possibly from a background URLSession that runs
 * for hours, so:
 * - init is idempotent per (guest, client_upload_id): a retry after a lost
 *   response returns the same session;
 * - all part URLs come in one call and live for hours (R2 allows 7 days;
 *   shorter keeps a leaked URL useful for less time, and the app can ask
 *   for fresh URLs for the parts still missing);
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

/** R2 through its S3 API (needs the R2_* secrets; see isR2Configured). */
export function r2MultipartBackend(env: Env): MultipartBackend {
  return {
    create: (key, contentType) => createMultipartUpload(env, key, contentType),
    presignPart: (key, uploadId, part, ttl) => presignPartUrl(env, key, uploadId, part, ttl),
    listParts: (key, uploadId) => listParts(env, key, uploadId),
    abort: (key, uploadId) => abortMultipartUpload(env, key, uploadId),
  };
}

/** Part URLs live this long; the app re-requests the missing parts after. */
export const PART_URL_TTL_SECONDS = 6 * 60 * 60;
/** Open sessions one guest may hold; a full queue of 8 MiB-part uploads fits. */
export const MAX_OPEN_UPLOADS_PER_GUEST = 50;
/** Open sessions per event, so new guests can't multiply the guest cap. */
export const MAX_OPEN_UPLOADS_PER_EVENT = 2000;
export const MAX_CAPTION_LENGTH = 500;
/** The app's id for one queued item: a UUID (compared lowercased). */
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
  completed_at: string | null;
  /** Kept on the row so the server can finalize without the guest. */
  uploader_name: string;
  /** The moment this session became, once completed. */
  moment_id: string | null;
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

export interface StartUploadHooks {
  /**
   * Asked only before opening a NEW session (a retry of an existing one
   * skips it, so a lost response can always be recovered): uploads still
   * open, rate limit.
   */
  canStartNew: () => Promise<"ok" | "closed" | "rate_limited">;
  /** Best-effort R2 cleanup failed (logged by the caller; ids only). */
  onCleanupError: (err: unknown) => void;
}

export type StartUploadResult =
  | { kind: "started" | "existing"; session: UploadSessionRow }
  | { kind: "invalid"; message: string }
  /** The client id is already used for a different file. */
  | { kind: "conflict" }
  /** The client id's session was aborted; the app must use a new id. */
  | { kind: "not_open"; session: UploadSessionRow }
  | { kind: "too_many_open" }
  /** The guest left (or was removed) while this request ran. */
  | { kind: "guest_gone" }
  | { kind: "closed" }
  | { kind: "rate_limited" };

/** Every session read goes through this (moment_id via the media_url index). */
const SESSION_SELECT = `SELECT id, event_id, participant_id, client_upload_id, key, upload_id, content_type,
    size_bytes, part_size, caption, status, created_at, completed_at, uploader_name,
    (SELECT m.id FROM moments m WHERE m.event_id = uploads.event_id AND m.media_url = '/media/' || uploads.key LIMIT 1) AS moment_id
  FROM uploads`;

export function partCount(session: Pick<UploadSessionRow, "size_bytes" | "part_size">): number {
  return partCountForSize(session.size_bytes, session.part_size);
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
      `${SESSION_SELECT}
        WHERE event_id = ? AND participant_id = ? AND client_upload_id = ?`
    )
    .bind(input.eventId, input.participantId, input.clientUploadId.toLowerCase())
    .first<UploadSessionRow>();
}

/** What a retried init gets for an existing session. */
function existingResult(session: UploadSessionRow, input: StartUploadInput): StartUploadResult {
  const sameFile = session.size_bytes === input.size && session.content_type === input.contentType.toLowerCase();
  if (!sameFile) return { kind: "conflict" };
  if (session.status === "aborted") return { kind: "not_open", session };
  return { kind: "existing", session };
}

async function openCounts(db: D1Database, input: StartUploadInput): Promise<{ guest: number; event: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM uploads WHERE participant_id = ? AND status = 'open') AS guest,
              (SELECT COUNT(*) FROM uploads WHERE event_id = ? AND status = 'open') AS event`
    )
    .bind(input.participantId, input.eventId)
    .first<{ guest: number; event: number }>();
  return { guest: row?.guest ?? 0, event: row?.event ?? 0 };
}

/**
 * Opens (or returns) the guest's session for one queued item. The caps are
 * enforced atomically by the insert itself (the count before it only saves
 * R2 calls in the common case); a concurrent duplicate loses on the unique
 * index, aborts its own R2 multipart and returns the winner.
 */
export async function startUpload(
  db: D1Database,
  backend: MultipartBackend,
  input: StartUploadInput,
  hooks: StartUploadHooks
): Promise<StartUploadResult> {
  const message = validateUploadInput(input);
  if (message) return { kind: "invalid", message };
  const existing = await findByClientId(db, input);
  if (existing) return existingResult(existing, input);

  const gate = await hooks.canStartNew();
  if (gate !== "ok") return { kind: gate };
  const counts = await openCounts(db, input);
  if (counts.guest >= MAX_OPEN_UPLOADS_PER_GUEST || counts.event >= MAX_OPEN_UPLOADS_PER_EVENT) {
    return { kind: "too_many_open" };
  }

  const contentType = input.contentType.toLowerCase();
  const key = momentKey(input.eventId, input.filename || "upload");
  const uploadId = await backend.create(key, contentType);
  const abortOwn = () => backend.abort(key, uploadId).catch(hooks.onCleanupError);
  const id = crypto.randomUUID();
  let changes: number;
  try {
    const result = await db
      .prepare(
        `INSERT INTO uploads
           (id, event_id, uploader_name, key, upload_id, content_type, size_bytes, status,
            client_upload_id, participant_id, caption, part_size)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM uploads WHERE participant_id = ? AND status = 'open') < ?
            AND (SELECT COUNT(*) FROM uploads WHERE event_id = ? AND status = 'open') < ?
            -- A guest who left meanwhile must not get a session nobody can abort.
            AND EXISTS (SELECT 1 FROM participants WHERE id = ? AND event_id = ?)
         ON CONFLICT (event_id, participant_id, client_upload_id) WHERE client_upload_id IS NOT NULL DO NOTHING`
      )
      .bind(
        id, input.eventId, input.nickname, key, uploadId, contentType, input.size,
        input.clientUploadId.toLowerCase(), input.participantId, input.caption, MULTIPART_PART_BYTES,
        input.participantId, MAX_OPEN_UPLOADS_PER_GUEST, input.eventId, MAX_OPEN_UPLOADS_PER_EVENT,
        input.participantId, input.eventId
      )
      .run();
    changes = result.meta.changes;
  } catch (err) {
    // No row points at the multipart, so the sweeper could never find it.
    await abortOwn();
    throw err;
  }
  if (changes === 0) {
    await abortOwn();
    const winner = await findByClientId(db, input);
    if (winner) return existingResult(winner, input);
    const stillHere = await db.prepare("SELECT 1 FROM participants WHERE id = ? AND event_id = ?")
      .bind(input.participantId, input.eventId).first();
    return stillHere ? { kind: "too_many_open" } : { kind: "guest_gone" };
  }
  const session = await getUploadById(db, id);
  if (!session) throw new Error("upload session missing after insert");
  return { kind: "started", session };
}

/** A v1 session by row id (server-side callers: finalize, the sweeper). */
export async function getUploadById(db: D1Database, id: string): Promise<UploadSessionRow | null> {
  return db.prepare(`${SESSION_SELECT} WHERE id = ? AND client_upload_id IS NOT NULL`).bind(id).first<UploadSessionRow>();
}

/** The guest's own session in this event, or null (never another guest's). */
export async function getOwnedUpload(
  db: D1Database,
  ref: { eventId: string; participantId: string; uploadId: string }
): Promise<UploadSessionRow | null> {
  return db
    .prepare(
      `${SESSION_SELECT}
        WHERE id = ? AND event_id = ? AND participant_id = ? AND client_upload_id IS NOT NULL`
    )
    .bind(ref.uploadId, ref.eventId, ref.participantId)
    .first<UploadSessionRow>();
}

export type PartUrlsResult =
  | { kind: "ok"; expiresAt: Date; parts: { part_number: number; url: string }[] }
  | { kind: "invalid"; message: string };

/**
 * Presigned PUT URLs for the requested parts (all parts when the list is
 * omitted; an empty list is a client bug, not "all"). The session must be
 * open; the caller checks ownership.
 */
export async function presignPartUrls(
  backend: MultipartBackend,
  session: UploadSessionRow,
  requested: readonly number[] | undefined,
  now: Date = new Date()
): Promise<PartUrlsResult> {
  const total = partCount(session);
  if (requested !== undefined && requested.length === 0) return { kind: "invalid", message: "part_numbers is empty" };
  const numbers = requested ? [...new Set(requested)].sort((a, b) => a - b) : Array.from({ length: total }, (_, i) => i + 1);
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

export type AbortUploadResult = { kind: "aborted"; session: UploadSessionRow } | { kind: "completed" };

/**
 * Marks an open session aborted. Returns false when it was no longer open
 * (finalize won the race), so abort and complete can't both succeed.
 */
export async function markAborted(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ? AND status = 'open'").bind(id).run();
  return result.meta.changes > 0;
}

/**
 * Cancels the guest's session: aborts it in R2 (which also kills its part
 * URLs) and frees its slot under the open-session cap. Idempotent; R2
 * already having no such upload counts as done.
 */
export async function abortUpload(
  db: D1Database,
  backend: MultipartBackend,
  session: UploadSessionRow
): Promise<AbortUploadResult> {
  if (session.status === "completed") return { kind: "completed" };
  if (session.status === "open") {
    try {
      await backend.abort(session.key, session.upload_id);
    } catch (err) {
      if (!(err instanceof R2RequestError && err.code === "NoSuchUpload")) throw err;
    }
    if (!(await markAborted(db, session.id))) {
      // Finalize completed it meanwhile (its multipart was already gone).
      const current = await getUploadById(db, session.id);
      if (current?.status === "completed") return { kind: "completed" };
    }
  }
  return { kind: "aborted", session: { ...session, status: "aborted" } };
}
