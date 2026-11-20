/**
 * Guests reporting moments for the host to review. A guest reports a
 * moment they can see (approved, in their event) once; reporting it again
 * changes nothing.
 */

export interface ReportInput {
  eventId: string;
  momentId: string;
  /** The reporting guest, from their guest token. */
  participantId: string;
}

/** Records the report; false when the moment isn't one the guest can see. */
export async function reportMoment(db: D1Database, input: ReportInput): Promise<boolean> {
  const write = await db
    .prepare(
      `INSERT OR IGNORE INTO moment_reports (id, event_id, moment_id, participant_id)
       SELECT ?, event_id, id, ? FROM moments
       WHERE id = ? AND event_id = ? AND moderation_status = 'approved'`
    )
    .bind(crypto.randomUUID(), input.participantId, input.momentId, input.eventId)
    .run();
  if (write.meta.changes > 0) return true;
  // Nothing written: already reported (still a success) or not visible.
  // If the host hides the moment between the two queries, a report that
  // was written answers 404; the row is harmless and goes with the moment.
  const seen = await db
    .prepare("SELECT 1 AS seen FROM moments WHERE id = ? AND event_id = ? AND moderation_status = 'approved'")
    .bind(input.momentId, input.eventId)
    .first<{ seen: number }>();
  return seen !== null;
}
