/**
 * Aborts R2 multipart sessions nobody will finish. Parts of an unfinished
 * upload are billed storage that no object listing shows, so the hourly cron
 * reaps them instead of waiting on the bucket's lifecycle rule.
 */

import { PURGE_AT_SQL, UPLOAD_FINISH_GRACE_MINUTES, UPLOADS_CLOSE_AT_SQL } from "./events";
import { abortMultipartUpload } from "./multipartPresign";
import { thumbnailKeys } from "./thumbnails";
import { isR2Configured } from "./presign";
import type { Env } from "./types";
import { UPLOAD_SESSION_TTL_HOURS } from "./uploadSessions";


/**
 * An open session this old is abandoned. Matches R2's default 7-day
 * incomplete-multipart expiry: the web queue can resume a paused upload days
 * later and does not yet recover from an aborted session, so reaping sooner
 * would strand it.
 */
export const ORPHAN_UPLOAD_AGE_HOURS = 7 * 24;
/** Per cron run. Each abort is one subrequest; leftovers go next run. */
export const ORPHAN_ABORT_BATCH = 40;
/** Per purged event, so one event's sessions cannot eat the cron's subrequest budget. */
export const EVENT_ABORT_BATCH = 25;
const PARALLEL_ABORTS = 6;

/**
 * R2 multipart sessions only (Stream rows use stream-session/ and stream/ keys),
 * and only keys inside the row's own event folder with a real upload id: an
 * abort is a DELETE on the key, so never aim it anywhere else.
 */
const R2_SESSION_SQL = `u.upload_id <> ''
  AND substr(u.key, 1, length('events/' || u.event_id || '/moments/')) = 'events/' || u.event_id || '/moments/'`;

export interface OpenUploadSession {
  id: string;
  key: string;
  upload_id: string;
}

export interface AbortSummary {
  aborted: number;
  failed: number;
}

export type AbortFn = (env: Env, key: string, uploadId: string) => Promise<void>;

/**
 * Open sessions to reap, in random order: abandoned (older than
 * ORPHAN_UPLOAD_AGE_HOURS; app sessions after UPLOAD_SESSION_TTL_HOURS) or still open past the event's upload close plus
 * the finish grace. Purged events' sessions are aborted by cleanupEvent;
 * any it could not abort stay open and are picked up here.
 */
export async function findOrphanUploads(db: D1Database, limit: number): Promise<OpenUploadSession[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.key, u.upload_id
         FROM uploads u JOIN events e ON e.id = u.event_id
        WHERE u.status = 'open'
          AND ${R2_SESSION_SQL}
          AND (u.created_at <= datetime('now', '-${ORPHAN_UPLOAD_AGE_HOURS} hours')
               -- App sessions (client id) expire sooner; the app opens a new one.
               OR (u.client_upload_id IS NOT NULL
                   AND u.created_at <= datetime('now', '-${UPLOAD_SESSION_TTL_HOURS} hours'))
               OR (${UPLOADS_CLOSE_AT_SQL} IS NOT NULL
                   AND ${UPLOADS_CLOSE_AT_SQL} <= datetime('now', '-${UPLOAD_FINISH_GRACE_MINUTES} minutes')))
        -- Random, not oldest first: rows that fail every run cannot starve the rest.
        ORDER BY random()
        LIMIT ?`
    )
    .bind(limit)
    .all<OpenUploadSession>();
  return results;
}

/**
 * Aborts each session in R2 and marks it aborted. A failed abort is logged and
 * left open, so the next run retries it. Logs carry ids only, never keys
 * (keys embed the uploaded file's name).
 */
export async function abortUploadSessions(
  env: Env,
  sessions: readonly OpenUploadSession[],
  abort: AbortFn = abortMultipartUpload
): Promise<AbortSummary> {
  const abortedIds: string[] = [];
  let failed = 0;
  for (let start = 0; start < sessions.length; start += PARALLEL_ABORTS) {
    const batch = sessions.slice(start, start + PARALLEL_ABORTS);
    const outcomes = await Promise.allSettled(batch.map((session) => abort(env, session.key, session.upload_id)));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        abortedIds.push(batch[index].id);
        return;
      }
      failed += 1;
      console.error(
        JSON.stringify({
          scope: "upload",
          event: "orphan_abort_failed",
          uploadRowId: batch[index].id,
          error: outcome.reason instanceof Error ? outcome.reason.name : "unknown",
        })
      );
    });
  }
  if (abortedIds.length > 0) {
    await env.DB.batch(
      abortedIds.map((id) =>
        env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ? AND status = 'open'").bind(id)
      )
    );
    await deleteUnregisteredObjects(env, abortedIds);
  }
  return { aborted: abortedIds.length, failed };
}

/**
 * A session can be open with its object already assembled (the worker died
 * between Complete and registering the moment). Once aborted, nothing will
 * register it, so its object goes too, unless a moment uses it.
 */
async function deleteUnregisteredObjects(env: Env, ids: readonly string[]): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT u.key FROM uploads u
      WHERE u.id IN (${ids.map(() => "?").join(", ")}) AND u.status = 'aborted' AND ${R2_SESSION_SQL}
        AND NOT EXISTS (SELECT 1 FROM moments m WHERE m.event_id = u.event_id AND m.media_url = '/media/' || u.key)`
  )
    .bind(...ids)
    .all<{ key: string }>();
  if (results.length === 0 || !env.BUCKET) return;
  try {
    // Each session's thumbnail too, uploaded beside it before the abort.
    await env.BUCKET.delete(results.flatMap((row) => [row.key, ...thumbnailKeys(row.key)]));
  } catch (err) {
    console.error(JSON.stringify({ scope: "upload", event: "orphan_object_delete_failed", error: err instanceof Error ? err.name : "unknown" }));
  }
}

/** Hourly cron entry point: reaps up to ORPHAN_ABORT_BATCH orphaned sessions. */
export async function abortOrphanUploads(env: Env, abort: AbortFn = abortMultipartUpload): Promise<AbortSummary> {
  if (!isR2Configured(env)) return { aborted: 0, failed: 0 };
  const summary = await abortUploadSessions(env, await findOrphanUploads(env.DB, ORPHAN_ABORT_BATCH), abort);
  // Rows a purge kept only so they could be aborted are done with now.
  await env.DB.prepare(
    `DELETE FROM uploads WHERE status = 'aborted'
        AND event_id IN (SELECT id FROM events WHERE archived_at IS NOT NULL AND ${PURGE_AT_SQL} <= datetime('now'))`
  ).run();
  console.log(JSON.stringify({ scope: "upload", event: "orphan_uploads_reaped", ...summary }));
  return summary;
}

/**
 * Aborts every open session of one event before its rows are deleted
 * (purge or archive). Best effort and capped at EVENT_ABORT_BATCH: anything
 * left is reclaimed by the bucket's AbortIncompleteMultipartUpload rule.
 */
export async function abortEventUploads(
  env: Env,
  eventId: string,
  abort: AbortFn = abortMultipartUpload
): Promise<AbortSummary> {
  if (!isR2Configured(env)) return { aborted: 0, failed: 0 };
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.key, u.upload_id FROM uploads u
      WHERE u.event_id = ? AND u.status = 'open' AND ${R2_SESSION_SQL}
      ORDER BY u.created_at LIMIT ?`
  )
    .bind(eventId, EVENT_ABORT_BATCH)
    .all<OpenUploadSession>();
  return abortUploadSessions(env, results, abort);
}
