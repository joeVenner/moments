import type { HostSession } from "./hostSessions";
import type { EventRow } from "./types";

/** What the plan check needs about an event the host may act on. */
export type HostEventRef = Pick<EventRow, "kind" | "owner_user_id">;

/**
 * Which events a signed-in host may see and change. The operator sees every
 * event; any other host only the events they own. An event with no owner
 * (none should exist after migration 0024) is visible to the operator alone.
 */

/** Every event (null) for the operator, otherwise only this user's. */
export function ownerScope(session: Pick<HostSession, "role" | "userId">): string | null {
  return session.role === "operator" ? null : session.userId;
}

/** The event when the host may act on it; null when they may not or it doesn't exist. */
export async function findHostEvent(
  db: D1Database,
  session: Pick<HostSession, "role" | "userId">,
  eventId: string
): Promise<HostEventRef | null> {
  return db
    .prepare("SELECT kind, owner_user_id FROM events WHERE id = ?1 AND (?2 IS NULL OR owner_user_id = ?2)")
    .bind(eventId, ownerScope(session))
    .first<HostEventRef>();
}

/** The moment's event when the host may act on the moment; null otherwise. */
export async function findHostMomentEvent(
  db: D1Database,
  session: Pick<HostSession, "role" | "userId">,
  momentId: string
): Promise<HostEventRef | null> {
  return db
    .prepare(
      `SELECT e.kind, e.owner_user_id FROM moments m JOIN events e ON e.id = m.event_id
       WHERE m.id = ?1 AND (?2 IS NULL OR e.owner_user_id = ?2)`
    )
    .bind(momentId, ownerScope(session))
    .first<HostEventRef>();
}
