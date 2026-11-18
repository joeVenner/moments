/**
 * Heart reactions, set idempotently: adding twice or removing twice leaves
 * the same state, so a client can retry after a lost response without
 * flipping the heart (the web's toggle route can't offer that).
 *
 * Known limit until guest tokens are enforced: reactor ids are chosen by the
 * client, so counts are only as honest as the rate limit makes them. The fix
 * (reactor = the token's participant, on this and the web route, plus the
 * feed's `reacted`) belongs with switching enforcement on.
 */

/** What identifies one device's reactions; web UUIDs and iOS hex ids fit. */
export const REACTOR_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/;

export interface ReactionState {
  reacted: boolean;
  reaction_count: number;
}

export interface SetReactionInput {
  eventId: string;
  momentId: string;
  reactorId: string;
  reacted: boolean;
}

const VISIBLE_MOMENT = "SELECT id FROM moments WHERE id = ? AND event_id = ? AND moderation_status = 'approved'";

/**
 * Adds or removes this reactor's heart on a visible (approved) moment of the
 * event. Returns null when there is no such moment. The visibility check is
 * part of the write and the count is read in the same transaction, so a
 * moment deleted or hidden meanwhile can't be written to or fail the batch.
 */
export async function setReaction(db: D1Database, input: SetReactionInput): Promise<ReactionState | null> {
  const write = input.reacted
    ? db
        .prepare(
          `INSERT OR IGNORE INTO moment_reactions (id, moment_id, event_id, reactor_id)
           SELECT ?, id, event_id, ? FROM moments WHERE id = ? AND event_id = ? AND moderation_status = 'approved'`
        )
        .bind(crypto.randomUUID(), input.reactorId, input.momentId, input.eventId)
    : db
        .prepare(`DELETE FROM moment_reactions WHERE reactor_id = ? AND moment_id IN (${VISIBLE_MOMENT})`)
        .bind(input.reactorId, input.momentId, input.eventId);
  const [, state] = await db.batch<{ visible: number; count: number }>([
    write,
    db
      .prepare(
        `SELECT EXISTS(${VISIBLE_MOMENT}) AS visible,
                (SELECT COUNT(*) FROM moment_reactions WHERE moment_id = ?) AS count`
      )
      .bind(input.momentId, input.eventId, input.momentId),
  ]);
  const row = state.results[0];
  if (!row?.visible) return null;
  return { reacted: input.reacted, reaction_count: row.count };
}
