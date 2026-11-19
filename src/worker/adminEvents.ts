import { toPublicEvent, type PublicEvent } from "./events";
import { withGuestMediaGrant } from "./mediaAccess";
import type { EventRow } from "./types";

/** An event as the host's list shows it: public fields plus two counts. */
export type AdminEventSummary = PublicEvent & { moment_count: number; participant_count: number };

/** Hard cap on one list; far above what a single host runs. */
export const ADMIN_EVENTS_LIMIT = 500;

/**
 * Every event, newest first, with its moment and guest counts. Secrets
 * (PIN hash, invite token, access version) never leave this function; a
 * private event's cover carries a signed grant like the guest API's.
 */
export async function listAdminEvents(
  db: D1Database,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ events: AdminEventSummary[]; truncated: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM moments m WHERE m.event_id = e.id) AS moment_count,
              (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id) AS participant_count
         FROM events e
        ORDER BY e.created_at DESC, e.id
        LIMIT ?`
    )
    // One extra row tells whether the cap cut the list short.
    .bind(ADMIN_EVENTS_LIMIT + 1)
    .all<EventRow & { moment_count: number; participant_count: number }>();
  const events = await Promise.all(
    results.slice(0, ADMIN_EVENTS_LIMIT).map(async ({ moment_count, participant_count, ...event }) => {
      const publicEvent = toPublicEvent(event);
      const cover = await withGuestMediaGrant(secret, event, publicEvent.cover_image_url, nowSeconds);
      return { ...publicEvent, cover_image_url: cover, moment_count, participant_count };
    })
  );
  return { events, truncated: results.length > ADMIN_EVENTS_LIMIT };
}
