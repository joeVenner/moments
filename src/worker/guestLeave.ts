/**
 * "Leave and delete my uploads" for a guest. Only what this guest provably
 * shared goes: moments created from upload sessions their token opened
 * (`uploads.participant_id`). Moments under the same nickname from the web,
 * which never carried a guest token, stay: deleting by name would let
 * whoever claims a legacy nickname erase the real owner's photos.
 *
 * Resumable: each call does a bounded amount of work and reports whether
 * anything is left. Open sessions are aborted first (otherwise the finalize
 * sweep would turn them into moments after the guest left), then moments are
 * deleted, and only when nothing is left are the session rows, the guest
 * sessions (the token) and the participant removed, so a retry after a lost
 * response still authenticates until the end.
 */
import { abortUpload, getUploadById, type MultipartBackend } from "./uploadSessions";

/** Each abort is one R2 subrequest. */
export const LEAVE_ABORT_BATCH = 10;
/**
 * Moments per call: one R2 batch delete, and one `IN (...)` list per
 * statement, which must stay under D1's 100 bound parameters.
 */
export const LEAVE_DELETE_BATCH = 90;

export interface LeavingGuest {
  eventId: string;
  participantId: string;
}

export interface LeaveResult {
  /** False: call again (the token still works until it is true). */
  done: boolean;
}

/** Moments created from this guest's sessions, matched by object key. */
const OWNED_MOMENTS = `SELECT m.id, m.media_url FROM moments m
  JOIN uploads u ON u.event_id = m.event_id AND m.media_url = '/media/' || u.key
  WHERE u.event_id = ? AND u.participant_id = ?`;

const OPEN_SESSIONS = `SELECT id FROM uploads WHERE event_id = ? AND participant_id = ? AND status = 'open'`;

export async function leaveEvent(
  db: D1Database,
  bucket: Pick<R2Bucket, "delete">,
  backend: MultipartBackend,
  guest: LeavingGuest
): Promise<LeaveResult> {
  const { eventId, participantId } = guest;

  const open = await db.prepare(`${OPEN_SESSIONS} LIMIT ?`).bind(eventId, participantId, LEAVE_ABORT_BATCH).all<{ id: string }>();
  const abortedKeys: string[] = [];
  try {
    for (const { id } of open.results) {
      const session = await getUploadById(db, id);
      // Completed meanwhile: its moment is picked up below.
      if (session && (await abortUpload(db, backend, session)).kind === "aborted") abortedKeys.push(session.key);
    }
  } finally {
    // A finalize that assembled the object but died before registering it
    // leaves the object with no row pointing at it once ours are deleted.
    // Also after a failed abort: the ones already aborted won't be seen again.
    if (abortedKeys.length > 0) await bucket.delete(abortedKeys);
  }

  const moments = await db.prepare(`${OWNED_MOMENTS} LIMIT ?`).bind(eventId, participantId, LEAVE_DELETE_BATCH)
    .all<{ id: string; media_url: string }>();
  if (moments.results.length > 0) {
    const keys = moments.results.map((m) => m.media_url.slice("/media/".length));
    // Objects first: a moment row without its object is worse than the reverse
    // (a retry finds the row again and deletes the key again).
    await bucket.delete(keys);
    const ids = moments.results.map((m) => m.id);
    const marks = ids.map(() => "?").join(", ");
    await db.batch([
      db.prepare(`DELETE FROM moment_reactions WHERE moment_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM moments WHERE id IN (${marks})`).bind(...ids),
    ]);
  }

  // Everything below runs only if nothing is open and no moment is left,
  // checked inside the same transaction (a session opened or finalized
  // meanwhile keeps the guest, and the next call handles it).
  const nothingLeft = `NOT EXISTS (${OPEN_SESSIONS}) AND NOT EXISTS (${OWNED_MOMENTS})`;
  const guard = [eventId, participantId, eventId, participantId];
  const [, , , removed] = await db.batch([
    db.prepare(`DELETE FROM uploads WHERE event_id = ? AND participant_id = ? AND ${nothingLeft}`)
      .bind(eventId, participantId, ...guard),
    // The guest's hearts: those under the reactor ids their sessions bound
    // (0017). Hearts never sent with the token aren't linked to them, so stay.
    db.prepare(
      `DELETE FROM moment_reactions WHERE event_id = ? AND reactor_id IN (
         SELECT reactor_id FROM guest_sessions
         WHERE event_id = ? AND participant_id = ? AND reactor_id IS NOT NULL
       ) AND ${nothingLeft}`
    ).bind(eventId, eventId, participantId, ...guard),
    db.prepare(`DELETE FROM guest_sessions WHERE event_id = ? AND participant_id = ? AND ${nothingLeft}`)
      .bind(eventId, participantId, ...guard),
    db.prepare(`DELETE FROM participants WHERE event_id = ? AND id = ? AND ${nothingLeft}`)
      .bind(eventId, participantId, ...guard),
  ]);
  return { done: removed.meta.changes === 1 };
}
