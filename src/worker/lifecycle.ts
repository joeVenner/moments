import type { Env, EventRow, MomentRow } from "./types";
import { deleteMomentMedia } from "./moderation";

export async function cleanupEvent(env: Env, event: Pick<EventRow, "id">): Promise<void> {
  const { results: moments } = await env.DB.prepare(
    "SELECT * FROM moments WHERE event_id = ?"
  ).bind(event.id).all<MomentRow>();

  for (const moment of moments) await deleteMomentMedia(env, moment.media_url);

  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `events/${event.id}/`, cursor });
    if (page.objects.length > 0) await env.BUCKET.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM moments WHERE event_id = ?").bind(event.id),
    env.DB.prepare("DELETE FROM participants WHERE event_id = ?").bind(event.id),
    env.DB.prepare("DELETE FROM uploads WHERE event_id = ?").bind(event.id),
    env.DB.prepare("DELETE FROM access_failures WHERE event_id = ?").bind(event.id),
    env.DB.prepare("UPDATE events SET archived_at = datetime('now') WHERE id = ?").bind(event.id),
  ]);
}

export async function cleanupExpiredEvents(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE archived_at IS NULL AND expires_at IS NOT NULL AND expires_at <= datetime('now')"
  ).all<EventRow>();
  for (const event of results) await cleanupEvent(env, event);
  return results.length;
}

/** Failed-PIN rows only matter inside the throttling window; keep a day for auditing. */
export async function pruneAccessFailures(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM access_failures WHERE created_at < datetime('now', '-1 day')").run();
}
