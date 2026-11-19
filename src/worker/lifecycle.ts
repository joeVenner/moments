import type { Env, EventRow, MomentRow } from "./types";
import { PURGE_AT_SQL } from "./events";
import { deleteMomentMedia } from "./moderation";
import { abortEventUploads, type AbortFn } from "./orphanUploads";

export async function cleanupEvent(env: Env, event: Pick<EventRow, "id">, abort?: AbortFn): Promise<void> {
  // Unfinished multipart parts are invisible to BUCKET.list below; abort them
  // while the upload rows still say where they are.
  // Never let this block the purge itself (subrequest limits, R2 outages).
  try {
    await abortEventUploads(env, event.id, abort);
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "upload",
        event: "event_upload_abort_failed",
        eventId: event.id,
        error: error instanceof Error ? error.name : "unknown",
      })
    );
  }

  const { results: moments } = await env.DB.prepare(
    "SELECT * FROM moments WHERE event_id = ?"
  ).bind(event.id).all<MomentRow>();

  for (const moment of moments) await deleteMomentMedia(env, moment);

  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `events/${event.id}/`, cursor });
    if (page.objects.length > 0) await env.BUCKET.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM moments WHERE event_id = ?").bind(event.id),
    // The delete trigger tombstones each moment; the event is gone, so drop them.
    env.DB.prepare("DELETE FROM moment_tombstones WHERE event_id = ?").bind(event.id),
    env.DB.prepare("DELETE FROM guest_sessions WHERE event_id = ?").bind(event.id),
    env.DB.prepare("DELETE FROM participants WHERE event_id = ?").bind(event.id),
    // Sessions still open here failed to abort (or were past the per-purge
    // cap). Their part URLs work until R2 aborts them, so keep the rows,
    // stripped of guest data, for the hourly sweeper to finish the job.
    env.DB.prepare("DELETE FROM uploads WHERE event_id = ? AND status <> 'open'").bind(event.id),
    env.DB.prepare(
      "UPDATE uploads SET uploader_name = '', caption = NULL, participant_id = NULL WHERE event_id = ?"
    ).bind(event.id),
    env.DB.prepare("DELETE FROM access_failures WHERE event_id = ?").bind(event.id),
    env.DB.prepare("UPDATE events SET archived_at = datetime('now') WHERE id = ?").bind(event.id),
  ]);
}

/**
 * Events purged per hourly run, so the R2 work stays inside the run's
 * subrequest budget and leaves room for the upload stages after it. Random,
 * so an event that keeps failing can't block the rest.
 */
export const PURGE_EVENTS_PER_RUN = 5;

export async function cleanupExpiredEvents(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE archived_at IS NULL AND ${PURGE_AT_SQL} IS NOT NULL AND ${PURGE_AT_SQL} <= datetime('now')
      ORDER BY random() LIMIT ?`
  ).bind(PURGE_EVENTS_PER_RUN).all<EventRow>();
  let purged = 0;
  for (const event of results) {
    // One failing event must not stop the others; it is retried next run.
    try {
      await cleanupEvent(env, event);
      purged += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "event_purge_failed",
          eventId: event.id,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
    }
  }
  return purged;
}

/** Failed-PIN rows only matter inside the throttling window; keep a day for auditing. */
export async function pruneAccessFailures(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM access_failures WHERE created_at < datetime('now', '-1 day')").run();
}
