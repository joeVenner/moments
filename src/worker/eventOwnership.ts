import type { HostSession } from "./hostSessions";

/**
 * Which events a signed-in host may see and change. The operator sees every
 * event; any other host only the events they own. An event with no owner
 * (none should exist after migration 0024) is visible to the operator alone.
 */

/** Every event (null) for the operator, otherwise only this user's. */
export function ownerScope(session: Pick<HostSession, "role" | "userId">): string | null {
  return session.role === "operator" ? null : session.userId;
}

/** True when the host may act on this event; false also when it doesn't exist. */
export async function hostCanAccessEvent(
  db: D1Database,
  session: Pick<HostSession, "role" | "userId">,
  eventId: string
): Promise<boolean> {
  const owner = ownerScope(session);
  const row = await db
    .prepare("SELECT 1 AS found FROM events WHERE id = ?1 AND (?2 IS NULL OR owner_user_id = ?2)")
    .bind(eventId, owner)
    .first<{ found: number }>();
  return row !== null;
}

/** True when the host may act on this moment (through its event's owner). */
export async function hostCanAccessMoment(
  db: D1Database,
  session: Pick<HostSession, "role" | "userId">,
  momentId: string
): Promise<boolean> {
  const owner = ownerScope(session);
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM moments m JOIN events e ON e.id = m.event_id
       WHERE m.id = ?1 AND (?2 IS NULL OR e.owner_user_id = ?2)`
    )
    .bind(momentId, owner)
    .first<{ found: number }>();
  return row !== null;
}
