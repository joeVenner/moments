/** What a guest sees counted in the event header. */
export type EventStats = {
  /** Moments guests can see (hidden ones are not counted). */
  moment_count: number;
  /** Guests in the event now (those who left are deleted, so not counted). */
  guest_count: number;
};

/** One query, both counts. */
export async function getEventStats(db: D1Database, eventId: string): Promise<EventStats> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM moments WHERE event_id = ?1 AND moderation_status = 'approved') AS moment_count,
         (SELECT COUNT(*) FROM participants WHERE event_id = ?1) AS guest_count`,
    )
    .bind(eventId)
    .first<EventStats>();
  // A scalar SELECT always returns its one row.
  if (!row) throw new Error("event stats query returned no row");
  return { moment_count: row.moment_count, guest_count: row.guest_count };
}
