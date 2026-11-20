import { getEventAnalytics, type EventAnalytics } from "./adminAnalytics";
import { toPublicEvent, type PublicEvent } from "./events";
import { advertisedGuestCap, GUEST_PAYING_PLAN_STATES_SQL } from "./guestCap";
import { withGuestMediaGrant } from "./mediaAccess";
import type { EventRow } from "./types";

/** An event as the host's list shows it: public fields, its billing kind, guest limit and two counts. */
export type AdminEventSummary = PublicEvent &
  Pick<EventRow, "kind"> & { guest_cap: number | null; moment_count: number; participant_count: number };

type AdminEventRow = EventRow & { moment_count: number; participant_count: number; tier_guest_cap: number | null };

/**
 * Every event column, the two counts and the owner's live tier cap (the
 * same plans the join check counts); callers add WHERE/ORDER/LIMIT.
 */
const ADMIN_EVENT_SELECT = `SELECT e.*,
        (SELECT COUNT(*) FROM moments m WHERE m.event_id = e.id) AS moment_count,
        (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id) AS participant_count,
        (SELECT pr.guest_cap FROM plans pl JOIN products pr ON pr.id = pl.product_id
          WHERE pl.user_id = e.owner_user_id AND pl.state IN ${GUEST_PAYING_PLAN_STATES_SQL} LIMIT 1) AS tier_guest_cap
   FROM events e`;

/**
 * The one place a raw event row becomes host-facing: secrets (PIN hash,
 * invite token, access version) are dropped by toPublicEvent, and a private
 * event's cover carries a signed grant like the guest API's.
 */
async function toAdminEventSummary(
  { moment_count, participant_count, tier_guest_cap, ...event }: AdminEventRow,
  secret: string | undefined,
  nowSeconds: number
): Promise<AdminEventSummary> {
  const publicEvent = toPublicEvent(event);
  const cover = await withGuestMediaGrant(secret, event, publicEvent.cover_image_url, nowSeconds);
  return {
    ...publicEvent,
    kind: event.kind,
    guest_cap: advertisedGuestCap(event.kind, tier_guest_cap),
    cover_image_url: cover,
    moment_count,
    participant_count,
  };
}

/** Hard cap on one list; far above what a single host runs. */
export const ADMIN_EVENTS_LIMIT = 500;

/**
 * The host's events (every event when `ownerUserId` is null: the operator),
 * newest first, with their moment and guest counts. Secrets (PIN hash,
 * invite token, access version) never leave this function; a private
 * event's cover carries a signed grant like the guest API's.
 */
export async function listAdminEvents(
  db: D1Database,
  secret: string | undefined,
  ownerUserId: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ events: AdminEventSummary[]; truncated: boolean }> {
  const { results } = await db
    .prepare(`${ADMIN_EVENT_SELECT} WHERE (?1 IS NULL OR e.owner_user_id = ?1) ORDER BY e.created_at DESC, e.id LIMIT ?2`)
    // One extra row tells whether the cap cut the list short.
    .bind(ownerUserId, ADMIN_EVENTS_LIMIT + 1)
    .all<AdminEventRow>();
  const events = await Promise.all(
    results.slice(0, ADMIN_EVENTS_LIMIT).map((row) => toAdminEventSummary(row, secret, nowSeconds))
  );
  return { events, truncated: results.length > ADMIN_EVENTS_LIMIT };
}

/** Links a host shares: the guest page, and for a private event the invite link. */
export interface EventShareLinks {
  event_url: string;
  /** Opens a private event without its PIN; null for public events. */
  invite_url: string | null;
}

export type AdminEventDetail = { event: AdminEventSummary; share: EventShareLinks; analytics: EventAnalytics };

/** Builds share links the way the web admin does, from the site's origin. */
export function shareLinks(origin: string, event: Pick<EventRow, "slug" | "access_mode" | "invite_token">): EventShareLinks {
  const eventUrl = `${origin}/e/${encodeURIComponent(event.slug)}`;
  const inviteUrl =
    event.access_mode === "private" && event.invite_token
      ? `${eventUrl}?invite=${encodeURIComponent(event.invite_token)}`
      : null;
  return { event_url: eventUrl, invite_url: inviteUrl };
}

/**
 * One event for the host's detail screen: its summary, share links and
 * analytics. Null when no event has this id. The invite link is the only
 * secret returned, and only to a signed-in host.
 */
export async function getAdminEventDetail(
  db: D1Database,
  secret: string | undefined,
  eventId: string,
  origin: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<AdminEventDetail | null> {
  const row = await db.prepare(`${ADMIN_EVENT_SELECT} WHERE e.id = ?`).bind(eventId).first<AdminEventRow>();
  if (!row) return null;
  return {
    event: await toAdminEventSummary(row, secret, nowSeconds),
    share: shareLinks(origin, row),
    analytics: await getEventAnalytics(db, row.id),
  };
}
