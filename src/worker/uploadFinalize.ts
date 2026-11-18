import { matchesContentType, SIGNATURE_BYTES } from "./mediaSignature";
import { completeMultipartUpload, type R2Part, R2RequestError } from "./multipartPresign";
import { pointsForContentType } from "./storage";
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
  /** Aborted (by the guest, the sweeper or a rejection). */
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

async function reject(
  db: D1Database,
  session: UploadSessionRow,
  reason: RejectReason,
  cleanup: () => Promise<void>
): Promise<FinalizeResult> {
  await cleanup();
  await markAborted(db, session.id);
  return { kind: "rejected", reason };
}

async function completedSession(db: D1Database, id: string): Promise<FinalizeResult> {
  const session = await getUploadById(db, id);
  if (!session?.moment_id) throw new Error("completed upload has no moment");
  return { kind: "completed", session };
}

/** Checks the assembled object, then inserts the moment and closes the session. */
async function register(db: D1Database, backend: FinalizeBackend, session: UploadSessionRow): Promise<FinalizeResult> {
  const object = await backend.head(session.key);
  if (!object) {
    // No multipart and no object: aborted elsewhere (e.g. R2's lifecycle rule).
    await markAborted(db, session.id);
    return { kind: "not_open" };
  }
  const removeObject = () => backend.deleteObject(session.key);
  if (object.size !== session.size_bytes || object.contentType !== session.content_type) {
    return reject(db, session, "object_mismatch", removeObject);
  }
  const start = await backend.readStart(session.key, SIGNATURE_BYTES);
  if (!start || !matchesContentType(start, session.content_type)) {
    return reject(db, session, "signature_mismatch", removeObject);
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO moments (id, event_id, uploader_name, media_url, caption, points_awarded, size_bytes, mime_type)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM uploads WHERE id = ? AND status = 'open')`
      )
      .bind(
        crypto.randomUUID(), session.event_id, session.uploader_name, `/media/${session.key}`, session.caption,
        pointsForContentType(session.content_type), object.size, session.content_type, session.id
      ),
    db
      .prepare("UPDATE uploads SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(session.id),
  ]);
  const current = await getUploadById(db, session.id);
  if (current?.status === "completed" && current.moment_id) return { kind: "completed", session: current };
  // Cancelled while we checked: nothing points at the object any more.
  await removeObject();
  return { kind: "not_open" };
}

export async function finalizeUpload(
  db: D1Database,
  backend: FinalizeBackend,
  session: UploadSessionRow
): Promise<FinalizeResult> {
  if (session.status === "completed") return completedSession(db, session.id);
  if (session.status === "aborted") return { kind: "not_open" };
  // A replay after the moment insert but before the response.
  if (session.moment_id) return completedSession(db, session.id);

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
    return reject(db, session, "part_size_mismatch", () => backend.abort(session.key, session.upload_id));
  }
  try {
    await backend.complete(session.key, session.upload_id, parts);
  } catch (err) {
    // The call may have succeeded with its response lost; register checks.
    if (!(await backend.head(session.key))) throw err;
  }
  return register(db, backend, session);
}
