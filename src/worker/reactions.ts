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

import { resolveGuestSession } from "./guestIdentity";

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

/**
 * Ties a guest session to the reactor id its device presents and returns the
 * id the heart should be written under. The first reaction binds the session;
 * a different id later (a reinstall that kept the token) moves the session's
 * hearts in this event to the new id instead of adding a second set.
 *
 * Every step is one D1 batch (a transaction) and only acts while the session
 * is still bound as read, so parallel requests with different ids end with
 * one bound id and their writes all land under it (no orphaned hearts).
 * An id is bound to at most one session per event (unique index, 0017): an id
 * another session holds is neither bound nor moved, and the heart is written
 * under it as a tokenless one would be (one browser that joined twice).
 *
 * Known limits until GUEST_TOKENS_ENFORCED (and server-made ids): omitting
 * the token skips this, and a token holder who learned another device's
 * random, never-returned id before that device bound it could bind it first.
 */
export async function bindReactor(
  db: D1Database,
  input: { sessionId: string; eventId: string; reactorId: string }
): Promise<string> {
  const { sessionId, eventId, reactorId } = input;
  const heldElsewhere = (id: string) =>
    db.prepare("SELECT 1 FROM guest_sessions WHERE event_id = ? AND reactor_id = ? AND id != ?").bind(eventId, id, sessionId);
  const FREE = "NOT EXISTS (SELECT 1 FROM guest_sessions o WHERE o.event_id = ? AND o.reactor_id = ? AND o.id != ?)";
  const [, first] = await db.batch<{ reactor_id: string | null }>([
    db
      .prepare(`UPDATE guest_sessions SET reactor_id = ? WHERE id = ? AND reactor_id IS NULL AND ${FREE}`)
      .bind(reactorId, sessionId, eventId, reactorId, sessionId),
    db.prepare("SELECT reactor_id FROM guest_sessions WHERE id = ?").bind(sessionId),
  ]);
  const previous = first.results[0]?.reactor_id ?? null;
  if (previous === null || previous === reactorId) return reactorId;
  if (await heldElsewhere(reactorId).first()) return previous;
  // Each statement re-checks that the session is still bound to `previous`
  // and the new id is still free, so a lost race moves nothing.
  const STILL = `EXISTS (SELECT 1 FROM guest_sessions s WHERE s.id = ? AND s.reactor_id = ?) AND ${FREE}`;
  const guard = [sessionId, previous, eventId, reactorId, sessionId];
  const [, , , after] = await db.batch<{ reactor_id: string | null }>([
    // A moment hearted under both ids keeps one heart (UNIQUE moment+reactor).
    db
      .prepare(`UPDATE OR IGNORE moment_reactions SET reactor_id = ? WHERE event_id = ? AND reactor_id = ? AND ${STILL}`)
      .bind(reactorId, eventId, previous, ...guard),
    db
      .prepare(`DELETE FROM moment_reactions WHERE event_id = ? AND reactor_id = ? AND ${STILL}`)
      .bind(eventId, previous, ...guard),
    db
      .prepare(`UPDATE guest_sessions SET reactor_id = ? WHERE id = ? AND reactor_id = ? AND ${FREE}`)
      .bind(reactorId, sessionId, previous, eventId, reactorId, sessionId),
    db.prepare("SELECT reactor_id FROM guest_sessions WHERE id = ?").bind(sessionId),
  ]);
  return after.results[0]?.reactor_id ?? reactorId;
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

export const GUEST_REQUIRED = { error: "join the event first", code: "guest_required" } as const;
export const REACTION_RATE_LIMITED = { error: "too many reactions", code: "rate_limited" } as const;

export type ReactionGate =
  | { ok: true; reactorId: string }
  | { ok: false; status: 403; body: typeof GUEST_REQUIRED }
  | { ok: false; status: 429; body: typeof REACTION_RATE_LIMITED };

/**
 * Shared by the web toggle and the v1 add/remove routes, before any write:
 * the guest check (only when GUEST_TOKENS_ENFORCED), the rate limit (keyed on
 * the guest session when there is one, else the client IP), then binding the
 * session to the presented reactor id. On success, `reactorId` is the id to
 * write under: the session's bound id, which is the presented one except
 * after a lost race or when the presented id is held by another session.
 */
export async function gateReaction(
  env: { DB: D1Database; REACTION_LIMITER?: RateLimit; GUEST_TOKENS_ENFORCED?: string },
  input: { eventId: string; token: string | null | undefined; clientIp: string | null | undefined; reactorId: string }
): Promise<ReactionGate> {
  const session = await resolveGuestSession(env.DB, input.eventId, input.token);
  if (env.GUEST_TOKENS_ENFORCED === "true" && !session) return { ok: false, status: 403, body: GUEST_REQUIRED };
  if (env.REACTION_LIMITER) {
    const who = session ? `guest:${session.sessionId}` : `ip:${input.clientIp ?? "unknown"}`;
    const { success } = await env.REACTION_LIMITER.limit({ key: `${input.eventId}:${who}` });
    if (!success) return { ok: false, status: 429, body: REACTION_RATE_LIMITED };
  }
  if (!session) return { ok: true, reactorId: input.reactorId };
  const reactorId = await bindReactor(env.DB, { sessionId: session.sessionId, eventId: input.eventId, reactorId: input.reactorId });
  return { ok: true, reactorId };
}
