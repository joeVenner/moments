/**
 * Heart reactions, set idempotently: adding twice or removing twice leaves
 * the same state, so a client can retry after a lost response without
 * flipping the heart (the web's toggle route can't offer that).
 *
 * Whose heart it is comes from the server: a guest who presents their token
 * reacts as `guest:<participant id>` (guestReactorId), on writes and on the
 * feed's `reacted`. Client-chosen ids (REACTOR_ID_PATTERN, which can't
 * contain ':') are only used by tokenless requests, which
 * GUEST_TOKENS_ENFORCED turns away.
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

/** The server's reactor id for a guest; never a value a client can send. */
export function guestReactorId(participantId: string): string {
  return `guest:${participantId}`;
}

/**
 * Whose hearts a read's `reacted` reflects: the token's guest; without a
 * token, the client's id while tokenless guests are still allowed, else
 * nobody ("", which matches no row).
 */
export async function viewerReactorId(
  env: { DB: D1Database; GUEST_TOKENS_ENFORCED?: string },
  input: { eventId: string; token: string | null | undefined; clientReactorId: string | null | undefined }
): Promise<string> {
  const session = await resolveGuestSession(env.DB, input.eventId, input.token);
  if (session) return guestReactorId(session.participant.id);
  if (env.GUEST_TOKENS_ENFORCED === "true") return "";
  const clientId = input.clientReactorId ?? "";
  return REACTOR_ID_PATTERN.test(clientId) ? clientId : "";
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
export const REACTOR_ID_REQUIRED = { error: "reactor_id is required without a guest token", code: "invalid_request" } as const;

export type ReactionGate =
  | { ok: true; reactorId: string }
  | { ok: false; status: 400; body: typeof REACTOR_ID_REQUIRED }
  | { ok: false; status: 403; body: typeof GUEST_REQUIRED }
  | { ok: false; status: 429; body: typeof REACTION_RATE_LIMITED };

/**
 * Shared by the web toggle and the v1 add/remove routes, before any write:
 * the guest check (an unknown token always; no token only when
 * GUEST_TOKENS_ENFORCED), the rate limit (keyed on
 * the guest session when there is one, else the client IP). On success,
 * `reactorId` is the id to write under: the guest's own (guestReactorId), or
 * for a tokenless request the client's id, which it then must send.
 */
export async function gateReaction(
  env: { DB: D1Database; REACTION_LIMITER?: RateLimit; GUEST_TOKENS_ENFORCED?: string },
  input: {
    eventId: string;
    token: string | null | undefined;
    clientIp: string | null | undefined;
    reactorId: string | null | undefined;
  }
): Promise<ReactionGate> {
  const session = await resolveGuestSession(env.DB, input.eventId, input.token);
  // A token we don't know means "join again", never the tokenless path.
  if (!session && (input.token || env.GUEST_TOKENS_ENFORCED === "true")) return { ok: false, status: 403, body: GUEST_REQUIRED };
  if (env.REACTION_LIMITER) {
    const who = session ? `guest:${session.sessionId}` : `ip:${input.clientIp ?? "unknown"}`;
    const { success } = await env.REACTION_LIMITER.limit({ key: `${input.eventId}:${who}` });
    if (!success) return { ok: false, status: 429, body: REACTION_RATE_LIMITED };
  }
  if (session) return { ok: true, reactorId: guestReactorId(session.participant.id) };
  const clientId = input.reactorId ?? "";
  if (!REACTOR_ID_PATTERN.test(clientId)) return { ok: false, status: 400, body: REACTOR_ID_REQUIRED };
  return { ok: true, reactorId: clientId };
}
