import { matchesContentType, SIGNATURE_BYTES } from "./mediaSignature";
import { isR2Configured } from "./presign";
import { completeMultipartUpload, type R2Part, R2RequestError } from "./multipartPresign";
import { pointsForContentType } from "./storage";
import { acceptThumbnail, thumbnailKeys } from "./thumbnails";
import type { Env } from "./types";
import {
  getUploadById,
  markAborted,
  type MultipartBackend,
  partCount,
  r2MultipartBackend,
  type UploadSessionRow,
} from "./uploadSessions";

/**
 * Finishes a v1 upload on the server: the app (or the sweeper) only says
 * "try now". R2's ListParts is the truth for what arrived:
 * 1. every part must have exactly the size the session implies (presigned
 *    PUTs bind no length, so this is where oversized parts are caught),
 *    before CompleteMultipartUpload, which can't be undone;
 * 2. the assembled object must have the declared size and type, and its
 *    first bytes must match that type;
 * 3. the moment insert and the session's `open` → `completed` move happen
 *    in one batch, guarded on `status = 'open'`, so a racing cancel and a
 *    finalize can't both win.
 * Every step is safe to replay after a lost response.
 */

export interface FinalizeBackend extends MultipartBackend {
  complete(key: string, uploadId: string, parts: R2Part[]): Promise<void>;
  head(key: string): Promise<{ contentType: string; size: number } | null>;
  /** The object's first `length` bytes, or null if it doesn't exist. */
  readStart(key: string, length: number): Promise<Uint8Array | null>;
  readAll(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

export function r2FinalizeBackend(env: Env): FinalizeBackend {
  return {
    ...r2MultipartBackend(env),
    complete: async (key, uploadId, parts) => {
      await completeMultipartUpload(env, key, uploadId, parts);
    },
    head: async (key) => {
      const object = await env.BUCKET.head(key);
      return object ? { contentType: object.httpMetadata?.contentType?.toLowerCase() ?? "", size: object.size } : null;
    },
    readStart: async (key, length) => {
      const object = await env.BUCKET.get(key, { range: { offset: 0, length } });
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    readAll: async (key) => {
      const object = await env.BUCKET.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    put: async (key, bytes, contentType) => {
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    },
    deleteObject: (key) => env.BUCKET.delete(key),
  };
}

export type RejectReason = "part_size_mismatch" | "object_mismatch" | "signature_mismatch";

export type FinalizeResult =
  | { kind: "completed"; session: UploadSessionRow }
  /** Parts are still missing; upload them and try again. */
  | { kind: "incomplete"; uploadedParts: number[] }
  /** The bytes don't match the session; it is aborted and the object removed. */
  | { kind: "rejected"; reason: RejectReason }
  /** Aborted (by the guest, a sweep or a rejection), or its moment was since deleted. */
  | { kind: "not_open" };

export type PartCheck = { kind: "ready" } | { kind: "incomplete"; uploadedParts: number[] } | { kind: "bad" };

/** Whether R2's parts are exactly the file the session declared. */
export function checkParts(session: Pick<UploadSessionRow, "size_bytes" | "part_size">, parts: readonly R2Part[]): PartCheck {
  const total = partCount(session);
  const lastSize = session.size_bytes - (total - 1) * session.part_size;
  const seen = new Set<number>();
  for (const part of parts) {
    if (part.size === undefined) throw new Error("ListParts returned a part without a size");
    if (part.partNumber < 1 || part.partNumber > total) return { kind: "bad" };
    if (part.size !== (part.partNumber === total ? lastSize : session.part_size)) return { kind: "bad" };
    seen.add(part.partNumber);
  }
  if (seen.size < total) return { kind: "incomplete", uploadedParts: [...seen].sort((a, b) => a - b) };
  return { kind: "ready" };
}

/** Aborts first, so bytes are only removed from a session nobody completed. */
async function reject(
  db: D1Database,
  session: UploadSessionRow,
  reason: RejectReason,
  cleanup: () => Promise<void>
): Promise<FinalizeResult> {
  if (!(await markAborted(db, session.id))) return settled(db, session.id);
  await cleanup();
  return { kind: "rejected", reason };
}

/** The answer for a session that is no longer open. */
async function settled(db: D1Database, id: string): Promise<FinalizeResult> {
  const session = await getUploadById(db, id);
  // A completed session whose moment was deleted (moderation) is finished too.
  if (session?.status === "completed" && session.moment_id) return { kind: "completed", session };
  return { kind: "not_open" };
}

/** Checks the assembled object, then inserts the moment and closes the session. */
async function register(db: D1Database, backend: FinalizeBackend, session: UploadSessionRow): Promise<FinalizeResult> {
  const object = await backend.head(session.key);
  if (!object) {
    // No multipart and no object: aborted elsewhere (e.g. R2's lifecycle rule).
    if (!(await markAborted(db, session.id))) return settled(db, session.id);
    return { kind: "not_open" };
  }
  const removeThumbnails = async () => {
    for (const key of thumbnailKeys(session.key)) await backend.deleteObject(key);
  };
  const removeObject = async () => {
    await backend.deleteObject(session.key);
    await removeThumbnails();
  };
  if (object.size !== session.size_bytes || object.contentType !== session.content_type) {
    return reject(db, session, "object_mismatch", removeObject);
  }
  const start = await backend.readStart(session.key, SIGNATURE_BYTES);
  if (!start || !matchesContentType(start, session.content_type)) {
    return reject(db, session, "signature_mismatch", removeObject);
  }
  // Optional: a missing, bad or unreadable thumbnail never holds the moment
  // back. A storage error here means the moment has no thumbnail (the feed
  // falls back to the file); the event's purge removes any leftover.
  const thumbKey = await acceptThumbnail(backend, session.key).catch((err: unknown) => {
    console.error(
      JSON.stringify({ scope: "upload", event: "thumbnail_check_failed", uploadRecordId: session.id, error: err instanceof Error ? err.name : "unknown" })
    );
    return null;
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type, participant_id, thumb_key)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (${OPEN_IN_LIVE_EVENT})`
      )
      .bind(
        crypto.randomUUID(), session.event_id, session.uploader_name, `/media/${session.key}`, session.caption,
        pointsForContentType(session.content_type), object.size, session.content_type, session.participant_id, thumbKey,
        session.id
      ),
    db
      .prepare(`UPDATE uploads SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND EXISTS (${OPEN_IN_LIVE_EVENT})`)
      .bind(session.id, session.id),
  ]);
  const current = await getUploadById(db, session.id);
  if (current?.status === "completed" && current.moment_id) return { kind: "completed", session: current };
  // Cancelled, or the event purged, while we checked: nothing points at the object.
  await removeObject();
  return { kind: "not_open" };
}

/**
 * Guards the moment insert: the session is still open and its event not
 * archived, so a finalize racing a purge can't leave a moment (with the
 * guest's name and caption) in a purged event.
 */
const OPEN_IN_LIVE_EVENT = `SELECT 1 FROM uploads u JOIN events e ON e.id = u.event_id
  WHERE u.id = ? AND u.status = 'open' AND e.archived_at IS NULL`;

export async function finalizeUpload(
  db: D1Database,
  backend: FinalizeBackend,
  session: UploadSessionRow
): Promise<FinalizeResult> {
  if (session.status !== "open") return settled(db, session.id);

  let parts: R2Part[];
  try {
    parts = await backend.listParts(session.key, session.upload_id);
  } catch (err) {
    // Complete already ran (its response was lost): the object is the truth now.
    if (err instanceof R2RequestError && err.code === "NoSuchUpload") return register(db, backend, session);
    throw err;
  }
  const check = checkParts(session, parts);
  if (check.kind === "incomplete") return check;
  if (check.kind === "bad") {
    return reject(db, session, "part_size_mismatch", async () => {
      await backend.abort(session.key, session.upload_id);
      for (const key of thumbnailKeys(session.key)) await backend.deleteObject(key);
    });
  }
  try {
    await backend.complete(session.key, session.upload_id, parts);
  } catch (err) {
    // The call may have succeeded with its response lost; register checks.
    const assembled = await backend.head(session.key).catch(() => null);
    if (!assembled) throw err;
  }
  return register(db, backend, session);
}

/** Sessions the hourly sweep tries per run (each costs up to 5 R2 calls). */
export const FINALIZE_SWEEP_BATCH = 5;
/** Leave sessions this young alone; the app is probably still uploading. */
export const FINALIZE_SWEEP_MIN_AGE_MINUTES = 30;

export interface FinalizeSweepSummary {
  completed: number;
  waiting: number;
  rejected: number;
  /** Aborted or cancelled meanwhile. */
  closed: number;
  failed: number;
}

/**
 * Hourly cron: finishes open v1 sessions nobody nudged (the app was killed,
 * or its background "complete" call never ran), in live events only. Runs
 * before the orphan sweep so a finished upload is kept, not aborted. A part
 * URL can't be minted after the close grace and lives 6 h, so this can't
 * accept uploads long after the close.
 */
export async function finalizeReadyUploads(
  env: Env,
  backend: FinalizeBackend = r2FinalizeBackend(env)
): Promise<FinalizeSweepSummary> {
  const summary: FinalizeSweepSummary = { completed: 0, waiting: 0, rejected: 0, closed: 0, failed: 0 };
  if (!isR2Configured(env)) return summary;
  const { results } = await env.DB.prepare(
    `SELECT u.id FROM uploads u JOIN events e ON e.id = u.event_id
      WHERE u.status = 'open' AND u.client_upload_id IS NOT NULL
        AND u.created_at <= datetime('now', ?)
        -- Live events only (PURGE_AT_SQL, qualified for the join).
        AND e.archived_at IS NULL
        AND (COALESCE(e.purge_after, e.expires_at) IS NULL OR COALESCE(e.purge_after, e.expires_at) > datetime('now'))
      ORDER BY random()
      LIMIT ?`
  )
    .bind(`-${FINALIZE_SWEEP_MIN_AGE_MINUTES} minutes`, FINALIZE_SWEEP_BATCH)
    .all<{ id: string }>();
  for (const { id } of results) {
    try {
      const session = await getUploadById(env.DB, id);
      if (!session) continue;
      const result = await finalizeUpload(env.DB, backend, session);
      if (result.kind === "completed") summary.completed += 1;
      else if (result.kind === "incomplete") summary.waiting += 1;
      else if (result.kind === "rejected") summary.rejected += 1;
      else summary.closed += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        JSON.stringify({
          scope: "upload",
          event: "finalize_sweep_failed",
          uploadRecordId: id,
          error: err instanceof Error ? err.name : "unknown",
          ...(err instanceof R2RequestError ? { status: err.status, s3Code: err.code } : {}),
        })
      );
    }
  }
  console.log(JSON.stringify({ scope: "upload", event: "finalize_sweep", ...summary }));
  return summary;
}

