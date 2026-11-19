/**
 * How many guests an event may have. Events from before hosting plans and
 * the operator's own have no limit; a plan's test event takes a few guests;
 * a main event takes its plan's tier, plus a 10% grace so a host who sold a
 * few too many seats isn't stopped at the door.
 */

export const TEST_EVENT_GUEST_CAP = 15;

/** A tier's cap plus 10%, rounded up (integer maths: 50 → 55, never 56). */
export function capWithGrace(tierCap: number): number {
  return Math.ceil((tierCap * 11) / 10);
}

/**
 * The most guests this event may have, or null for no limit. A main event
 * whose owner's plan has ended (lapsed, refunded, purged or none) gets 0:
 * nobody pays for new guests then.
 */
export async function eventGuestCap(db: D1Database, eventId: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT e.kind, pr.guest_cap
       FROM events e
       LEFT JOIN plans p ON p.user_id = e.owner_user_id AND p.state IN ('active', 'canceling', 'grace', 'billing_retry')
       LEFT JOIN products pr ON pr.id = p.product_id
       WHERE e.id = ?`
    )
    .bind(eventId)
    .first<{ kind: "legacy" | "operator" | "main" | "test"; guest_cap: number | null }>();
  if (!row) return 0;
  switch (row.kind) {
    case "legacy":
    case "operator":
      return null;
    case "test":
      return TEST_EVENT_GUEST_CAP;
    case "main":
      return row.guest_cap === null ? 0 : capWithGrace(row.guest_cap);
    default: {
      const unknownKind: never = row.kind;
      throw new Error(`unknown event kind ${String(unknownKind)}`);
    }
  }
}

/** A numbered SQL parameter such as "?5": the only thing guestFitsSql splices in. */
export type SqlPlaceholder = `?${number}`;

/**
 * SQL for "a new guest still fits", given the placeholders that hold the cap
 * (null = no limit), the event id and the nickname. A guest already in the
 * event always fits, so rejoining is never blocked.
 */
export function guestFitsSql(cap: SqlPlaceholder, eventId: SqlPlaceholder, nickname: SqlPlaceholder): string {
  return `(${cap} IS NULL
    OR (SELECT COUNT(*) FROM participants WHERE event_id = ${eventId}) < ${cap}
    OR EXISTS (SELECT 1 FROM participants WHERE event_id = ${eventId} AND nickname = ${nickname}))`;
}
