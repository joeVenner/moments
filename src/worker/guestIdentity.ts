import type { ParticipantRow } from "./types";

/** Header native and web clients send the per-device guest token in. */
export const GUEST_TOKEN_HEADER = "X-Guest-Token";
export const MAX_NICKNAME_LENGTH = 60;

const TOKEN_PREFIX = "gt_";
// "gt_" + 43 base64url chars (32 random bytes, unpadded).
const TOKEN_PATTERN = /^gt_[A-Za-z0-9_-]{43}$/;

export interface GuestSession {
  sessionId: string;
  participant: ParticipantRow;
}

export interface JoinInput {
  eventId: string;
  nickname: string;
  avatarSeed: string | null;
  presentedToken: string | null;
  /** When true, a claimed nickname can only be joined with its own token. */
  enforceClaims: boolean;
}

export type JoinResult =
  | { ok: true; participant: ParticipantRow; guestToken: string | null }
  | { ok: false; error: "nickname_taken" };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh 256-bit guest token. Shown to the client once; never stored raw. */
export function generateGuestToken(): string {
  return TOKEN_PREFIX + base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isWellFormedGuestToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * Unkeyed SHA-256 is enough here: the token carries 256 bits of entropy, so the
 * stored hash cannot be brute-forced back into a usable token.
 */
export async function hashGuestToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolves a presented token to its participant, scoped to one event. */
export async function resolveGuestSession(
  db: D1Database,
  eventId: string,
  token: string | null | undefined
): Promise<GuestSession | null> {
  if (!token || !isWellFormedGuestToken(token)) return null;
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, p.*
       FROM guest_sessions s JOIN participants p ON p.id = s.participant_id
       WHERE s.token_hash = ? AND s.event_id = ?`
    )
    .bind(await hashGuestToken(token), eventId)
    .first<ParticipantRow & { session_id: string }>();
  if (!row) return null;
  const { session_id: sessionId, ...participant } = row;
  return { sessionId, participant };
}

/** Participant fields safe to return to any guest. */
export const PUBLIC_PARTICIPANT_COLUMNS = "id, event_id, nickname, avatar_seed, joined_at";

export type PublicParticipant = Omit<ParticipantRow, "claimed_at">;

export function toPublicParticipant(row: ParticipantRow): PublicParticipant {
  const { claimed_at: _claimedAt, ...publicFields } = row;
  return publicFields;
}

async function findParticipant(db: D1Database, eventId: string, nickname: string): Promise<ParticipantRow | null> {
  return db
    .prepare("SELECT * FROM participants WHERE event_id = ? AND nickname = ?")
    .bind(eventId, nickname)
    .first<ParticipantRow>();
}

/**
 * Keep the avatar the guest first picked; only backfill a missing one (e.g. a
 * participant created by an upload before the nickname gate).
 */
async function backfillAvatar(
  db: D1Database,
  participant: ParticipantRow,
  avatarSeed: string | null
): Promise<ParticipantRow> {
  if (!avatarSeed || participant.avatar_seed) return participant;
  await db.prepare("UPDATE participants SET avatar_seed = ? WHERE id = ?").bind(avatarSeed, participant.id).run();
  return { ...participant, avatar_seed: avatarSeed };
}

/**
 * Joins an event under a nickname.
 *
 * A token is minted only for the request that wins the nickname: it either
 * created the participant or claimed a legacy (unclaimed) one. The claim and
 * the session insert run in one D1 batch (a transaction), so a nickname is
 * never left claimed without a token, and exactly one caller can win.
 *
 * Losing callers never get a token, so tokens minted before enforcement always
 * belong to the first claimant and cannot be farmed by impersonators. Before
 * enforcement a loser still joins (today's nickname-only behaviour), without a
 * token; with enforcement it gets `nickname_taken`.
 */
export async function joinEventAsGuest(db: D1Database, input: JoinInput): Promise<JoinResult> {
  const current = await resolveGuestSession(db, input.eventId, input.presentedToken);
  if (current && current.participant.nickname === input.nickname) {
    return { ok: true, participant: await backfillAvatar(db, current.participant, input.avatarSeed), guestToken: null };
  }

  const token = generateGuestToken();
  const [claim] = await db.batch([
    // Inserts a new claimed participant, or claims a legacy one. changes() is 1
    // exactly when this request won the nickname.
    db
      .prepare(
        `INSERT INTO participants (id, event_id, nickname, avatar_seed, claimed_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (event_id, nickname) DO UPDATE SET claimed_at = excluded.claimed_at
         WHERE participants.claimed_at IS NULL`
      )
      .bind(crypto.randomUUID(), input.eventId, input.nickname, input.avatarSeed),
    // changes() here still refers to the statement above.
    db
      .prepare(
        `INSERT INTO guest_sessions (id, event_id, participant_id, token_hash)
         SELECT ?, event_id, id, ? FROM participants
         WHERE event_id = ? AND nickname = ? AND changes() = 1`
      )
      .bind(crypto.randomUUID(), await hashGuestToken(token), input.eventId, input.nickname),
  ]);
  const wonNickname = claim.meta.changes === 1;

  if (!wonNickname && input.enforceClaims) return { ok: false, error: "nickname_taken" };

  const participant = await findParticipant(db, input.eventId, input.nickname);
  if (!participant) throw new Error("participant missing after join");
  return {
    ok: true,
    participant: await backfillAvatar(db, participant, input.avatarSeed),
    guestToken: wonNickname ? token : null,
  };
}
