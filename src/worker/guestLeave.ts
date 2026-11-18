/**
 * "Leave and delete my uploads" for a guest. Only what this guest provably
 * shared goes: moments recorded with their participant id
 * (`moments.participant_id`, set when an upload made with their guest token
 * becomes a moment: app sessions, web direct, multipart and Stream uploads).
 * Moments under the same nickname without that id never carried the token
 * and stay: deleting by name would let whoever claims a nickname erase the
 * real owner's photos.
 *
 * Resumable: each call does a bounded amount of work and reports whether
 * anything is left. Open sessions are aborted first (otherwise the finalize
 * sweep or a late complete would turn them into moments after the guest
 * left), then moments are deleted, and only when nothing is left are the
 * session rows, the guest sessions (the token) and the participant removed,
 * so a retry after a lost response still authenticates until the end.
 */
import { abortR2Multipart, markAborted, type MultipartBackend, r2MultipartBackend } from "./uploadSessions";
import { deleteStreamVideo } from "./moderation";
import { isStreamConfigured } from "./stream";
import { guestReactorId } from "./reactions";
import { streamUidOf } from "./streamSigning";
import type { Env } from "./types";

/** Each abort is one R2 or Stream subrequest. */
export const LEAVE_ABORT_BATCH = 10;
/**
 * Moments per call: one R2 batch delete (with the thumbnails, under R2's
 * 1000 keys), and one `IN (...)` list per statement, which must stay under
 * D1's 100 bound parameters.
 */
export const LEAVE_DELETE_BATCH = 90;
/** Stream videos per call: each delete is its own subrequest, unlike R2's batch. */
export const LEAVE_STREAM_BATCH = 20;

export interface LeavingGuest {
  eventId: string;
  participantId: string;
}

export interface LeaveResult {
  /** False: call again (the token still works until it is true). */
  done: boolean;
}

/** Where a guest's media lives. */
export interface LeaveStorage {
  bucket: Pick<R2Bucket, "delete">;
  multipart: MultipartBackend;
  /** Deletes a Stream video by uid; one already gone counts as deleted. */
  deleteStreamVideo(uid: string): Promise<void>;
}

/** The worker's real storage, shared by the web and app leave routes. */
export function leaveStorage(env: Env): LeaveStorage {
  return {
    bucket: env.BUCKET,
    multipart: r2MultipartBackend(env),
    deleteStreamVideo: async (uid) => {
      // A "delete my data" must not report success with the video left behind.
      if (!isStreamConfigured(env)) throw new Error("Stream is not configured");
      await deleteStreamVideo(env, uid);
    },
  };
}

const OWNED_MOMENTS = `SELECT id FROM moments WHERE event_id = ? AND participant_id = ?`;

const OPEN_SESSIONS = `SELECT id, key, upload_id FROM uploads WHERE event_id = ? AND participant_id = ? AND status = 'open'`;

interface OwnedMoment {
  id: string;
  media_url: string;
  thumb_key: string | null;
  display_key: string | null;
  poster_key: string | null;
}

/** R2 keys of a moment: its object (unless it is a Stream video) and its derived images.
 *  Stored media URLs never carry a query (`?mv=` is added on admin output only). */
function r2KeysOf(moment: OwnedMoment): string[] {
  const keys = [moment.thumb_key, moment.display_key, moment.poster_key].filter((k): k is string => !!k);
  return moment.media_url.startsWith("/media/") ? [moment.media_url.slice("/media/".length), ...keys] : keys;
}

export async function leaveEvent(db: D1Database, storage: LeaveStorage, guest: LeavingGuest): Promise<LeaveResult> {
  const { eventId, participantId } = guest;

  const open = await db
    .prepare(`${OPEN_SESSIONS} LIMIT ?`)
    .bind(eventId, participantId, LEAVE_ABORT_BATCH)
    .all<{ id: string; key: string; upload_id: string }>();
  const abortedKeys: string[] = [];
  try {
    // App sessions and web uploads alike (web rows have no client_upload_id).
    for (const session of open.results) {
      if (session.key.startsWith("stream-session/")) {
        // A Stream session before its tus create: nothing exists yet, and a
        // create after this finds the row closed and deletes its video.
        await markAborted(db, session.id);
        continue;
      }
      if (session.key.startsWith("stream/")) {
        // A web Stream upload: its video exists from the start. If the
        // complete races this, the moment it makes is found below.
        // Video first: if it fails the row stays open and the next call retries;
        // a complete after this fails its Stream lookup.
        await storage.deleteStreamVideo(session.upload_id);
        await markAborted(db, session.id);
        continue;
      }
      await abortR2Multipart(storage.multipart, session.key, session.upload_id);
      // False: completed meanwhile (its moment is picked up below) or aborted
      // by the guest's own cancel, which leaves no assembled object.
      if (await markAborted(db, session.id)) abortedKeys.push(session.key);
    }
  } finally {
    // A finalize that assembled the object but died before registering it
    // leaves the object with no row pointing at it once ours are deleted.
    // Also after a failed abort: the ones already aborted won't be seen again.
    if (abortedKeys.length > 0) await storage.bucket.delete(abortedKeys);
  }

  const moments = await db
    .prepare(
      `SELECT id, media_url, thumb_key, display_key, poster_key FROM moments
        WHERE event_id = ? AND participant_id = ? LIMIT ?`
    )
    .bind(eventId, participantId, LEAVE_DELETE_BATCH)
    .all<OwnedMoment>();
  // Bound the Stream deletes per call; the rest wait for the next call.
  let streamCount = 0;
  const batch = moments.results.filter((m) => !streamUidOf(m.media_url) || ++streamCount <= LEAVE_STREAM_BATCH);
  if (batch.length > 0) {
    // Media first: a moment row without its media is worse than the reverse
    // (a retry finds the row again and deletes the media again).
    const keys = batch.flatMap(r2KeysOf);
    if (keys.length > 0) await storage.bucket.delete(keys);
    for (const moment of batch) {
      const uid = streamUidOf(moment.media_url);
      if (uid) await storage.deleteStreamVideo(uid);
    }
    const ids = batch.map((m) => m.id);
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
    // The guest's hearts (made with their token; see reactions.ts).
    db.prepare(`DELETE FROM moment_reactions WHERE event_id = ? AND reactor_id = ? AND ${nothingLeft}`)
      .bind(eventId, guestReactorId(participantId), ...guard),
    db.prepare(`DELETE FROM guest_sessions WHERE event_id = ? AND participant_id = ? AND ${nothingLeft}`)
      .bind(eventId, participantId, ...guard),
    db.prepare(`DELETE FROM participants WHERE event_id = ? AND id = ? AND ${nothingLeft}`)
      .bind(eventId, participantId, ...guard),
  ]);
  return { done: removed.meta.changes === 1 };
}
