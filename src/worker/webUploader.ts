/**
 * Who is uploading through the web routes. With a guest token, the guest:
 * their own nickname and participant id, whatever name the body carries, so
 * nobody can upload under another guest's name. Without one, the body's name
 * (tokenless guests) until GUEST_TOKENS_ENFORCED, then a 403; and never a
 * nickname some guest already claimed with a token.
 */

import { resolveGuestSession } from "./guestIdentity";
import { GUEST_REQUIRED } from "./reactions";
import type { MomentRow } from "./types";

type GuestEnv = { DB: D1Database; GUEST_TOKENS_ENFORCED?: string };

export type WebUploader =
  | { ok: true; uploaderName: string; participantId: string | null }
  | { ok: false; status: 400; body: { error: string } }
  | { ok: false; status: 403; body: typeof GUEST_REQUIRED };

/**
 * `clientName` is read only on the tokenless path, so an enforced request
 * without a token is refused before its (possibly large) body is parsed.
 */
export async function resolveWebUploader(
  env: GuestEnv,
  input: { eventId: string; token: string | null | undefined; clientName: () => unknown }
): Promise<WebUploader> {
  const session = await resolveGuestSession(env.DB, input.eventId, input.token);
  if (session) return { ok: true, uploaderName: session.participant.nickname, participantId: session.participant.id };
  if (env.GUEST_TOKENS_ENFORCED === "true") return { ok: false, status: 403, body: GUEST_REQUIRED };
  const raw = await input.clientName();
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { ok: false, status: 400, body: { error: "uploader_name is required" } };
  const claimed = await env.DB.prepare(
    "SELECT 1 AS found FROM participants WHERE event_id = ? AND nickname = ? AND claimed_at IS NOT NULL"
  )
    .bind(input.eventId, name)
    .first<{ found: number }>();
  // That name belongs to a guest with a token: only their token may use it.
  if (claimed) return { ok: false, status: 403, body: GUEST_REQUIRED };
  return { ok: true, uploaderName: name, participantId: null };
}

/**
 * Whether a follow-up call (part URL, status, complete, abort) may act on this
 * row. A guest's row: their token, or, until enforcement, no token at all (an
 * old upload service worker that saved none); never another guest's. Rows
 * opened without a token have no owner to check here.
 */
export async function mayUseUpload(
  env: GuestEnv,
  input: { eventId: string; token: string | null | undefined; row: { participant_id: string | null } }
): Promise<boolean> {
  if (input.row.participant_id === null) return true;
  const session = await resolveGuestSession(env.DB, input.eventId, input.token);
  if (session) return session.participant.id === input.row.participant_id;
  return env.GUEST_TOKENS_ENFORCED !== "true";
}

/** mayUseUpload, and a tokenless row also needs the name it was opened with. */
export async function mayFinishUpload(
  env: GuestEnv,
  input: {
    eventId: string;
    token: string | null | undefined;
    row: { participant_id: string | null; uploader_name: string };
    clientName: string;
  }
): Promise<boolean> {
  if (input.row.participant_id === null) return input.row.uploader_name === input.clientName;
  return mayUseUpload(env, input);
}

/** A moment as guests may see it: without the owner's participant id. */
export function guestMoment<T extends Pick<MomentRow, "id">>(moment: T): Omit<T, "participant_id"> {
  const { participant_id: _owner, ...rest } = moment as T & { participant_id?: unknown };
  return rest;
}
