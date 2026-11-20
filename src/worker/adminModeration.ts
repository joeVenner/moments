import { buildMomentMedia, type MomentMedia } from "./media";
import { withAdminViewUrls } from "./mediaAccess";
import { deleteMomentMedia } from "./moderation";
import { signMomentsForEvent, type StreamSigningEvent } from "./streamSigning";
import type { Env, MomentRow } from "./types";

/** Hard cap on one moderation list, like the web admin's. */
export const ADMIN_MOMENTS_LIMIT = 500;

export type ModerationStatus = MomentRow["moderation_status"];

/** A moment as the host's moderation grid shows it, hidden ones included. */
export interface AdminMoment {
  id: string;
  event_id: string;
  uploader_name: string;
  caption: string | null;
  created_at: string;
  mime_type: string | null;
  size_bytes: number | null;
  moderation_status: ModerationStatus;
  reaction_count: number;
  /** URLs carry `?mv=` view signatures (and Stream tokens when required). */
  media: MomentMedia;
}

// Selected FROM moments (unaliased): the count is correlated on moments.id.
const ADMIN_MOMENT_COLUMNS = `id, event_id, uploader_name, media_url, caption, created_at, mime_type, size_bytes,
  moderation_status, width, height, duration_ms, blurhash, thumb_key, display_key, poster_key,
  (SELECT COUNT(*) FROM moment_reactions r WHERE r.moment_id = moments.id) AS reaction_count`;

type AdminMomentRow = Pick<
  MomentRow,
  | "id" | "event_id" | "uploader_name" | "media_url" | "caption" | "created_at" | "mime_type" | "size_bytes"
  | "moderation_status" | "width" | "height" | "duration_ms" | "blurhash" | "thumb_key" | "display_key" | "poster_key"
> & { reaction_count: number };

/**
 * Raw rows → host-facing moments: storage keys become `media` URLs, Stream
 * URLs get playback tokens when the event needs them, and every /media URL gets a
 * short-lived admin view signature so hidden moments still load.
 */
async function toAdminMoments(env: Env, event: StreamSigningEvent, rows: readonly AdminMomentRow[]): Promise<AdminMoment[]> {
  // Both signers take {media_url, media}; `row` rides along for the final shape.
  const withMedia = rows.map((row) => ({ row, media_url: row.media_url, media: buildMomentMedia(row) }));
  const streamed = await signMomentsForEvent(env, event, withMedia);
  const viewable = await withAdminViewUrls(env.EVENT_ACCESS_SECRET, streamed);
  return viewable.map(({ row, media }) => ({
    id: row.id,
    event_id: row.event_id,
    uploader_name: row.uploader_name,
    caption: row.caption,
    created_at: row.created_at,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    moderation_status: row.moderation_status,
    reaction_count: row.reaction_count,
    media,
  }));
}

/** Every moment of an event, newest first; null when the event doesn't exist. */
export async function listAdminMoments(
  env: Env,
  eventId: string
): Promise<{ moments: AdminMoment[]; truncated: boolean } | null> {
  const event = await env.DB.prepare("SELECT access_mode, kind FROM events WHERE id = ?").bind(eventId).first<StreamSigningEvent>();
  if (!event) return null;
  const { results } = await env.DB.prepare(
    `SELECT ${ADMIN_MOMENT_COLUMNS} FROM moments WHERE event_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    // One extra row tells whether the cap cut the list short.
    .bind(eventId, ADMIN_MOMENTS_LIMIT + 1)
    .all<AdminMomentRow>();
  return {
    moments: await toAdminMoments(env, event, results.slice(0, ADMIN_MOMENTS_LIMIT)),
    truncated: results.length > ADMIN_MOMENTS_LIMIT,
  };
}

/**
 * Hides or shows a moment. Guests see the change through the feed's
 * change_seq trigger. Null when no moment has this id.
 */
export async function setMomentModeration(env: Env, momentId: string, status: ModerationStatus): Promise<AdminMoment | null> {
  const [, select] = await env.DB.batch([
    env.DB.prepare("UPDATE moments SET moderation_status = ? WHERE id = ?").bind(status, momentId),
    env.DB.prepare(
      `SELECT ${ADMIN_MOMENT_COLUMNS},
              (SELECT access_mode FROM events WHERE events.id = moments.event_id) AS access_mode,
              (SELECT kind FROM events WHERE events.id = moments.event_id) AS kind
         FROM moments WHERE id = ?`
    ).bind(momentId),
  ]);
  const row = (select.results as (AdminMomentRow & StreamSigningEvent)[])[0];
  if (!row) return null;
  const { access_mode, kind, ...moment } = row;
  const [admin] = await toAdminMoments(env, { access_mode, kind }, [moment]);
  return admin ?? null;
}

export type DeleteMomentResult = "deleted" | "not_found";

/**
 * Deletes a moment's stored media, then its row (the feed tombstone trigger
 * tells guests). Media is removed first so a failure leaves the row for a
 * retry instead of orphaning objects; it throws in that case.
 */
export async function deleteAdminMoment(env: Env, momentId: string): Promise<DeleteMomentResult> {
  const moment = await env.DB.prepare(
    "SELECT id, media_url, thumb_key, display_key, poster_key FROM moments WHERE id = ?"
  ).bind(momentId).first<Pick<MomentRow, "id" | "media_url" | "thumb_key" | "display_key" | "poster_key">>();
  if (!moment) return "not_found";
  await deleteMomentMedia(env, moment);
  await env.DB.prepare("DELETE FROM moments WHERE id = ?").bind(moment.id).run();
  return "deleted";
}
