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
  // A token we don't know (the guest left, or it is another event's) means
  // "join again", never the tokenless name path.
  if (input.token || env.GUEST_TOKENS_ENFORCED === "true") return { ok: false, status: 403, body: GUEST_REQUIRED };
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

/** How a follow-up call (part URL, status, complete, abort) may treat an upload row. */
export type UploadAccess = "ok" | "not_found" | "guest_required";

/**
 * A guest's row: their token, or, until enforcement, no token at all (an old
 * upload service worker that saved none); never another guest's, which reads
 * as not found so rows don't leak. Rows opened without a token have no owner
 * to check. A token we don't know is refused as guest_required on any row, so
 * the client can send its guest back to join.
 */
export async function uploadAccess(
  env: GuestEnv,
  input: { eventId: string; token: string | null | undefined; row: { participant_id: string | null } }
): Promise<UploadAccess> {
  const session = input.token ? await resolveGuestSession(env.DB, input.eventId, input.token) : null;
  if (input.token && !session) return "guest_required";
  if (input.row.participant_id === null) return "ok";
  if (session) return session.participant.id === input.row.participant_id ? "ok" : "not_found";
  return env.GUEST_TOKENS_ENFORCED === "true" ? "guest_required" : "ok";
}

/** uploadAccess, and a tokenless row also needs the name it was opened with. */
export async function finishAccess(
  env: GuestEnv,
  input: {
    eventId: string;
    token: string | null | undefined;
    row: { participant_id: string | null; uploader_name: string };
    clientName: string;
  }
): Promise<UploadAccess> {
  const access = await uploadAccess(env, input);
  if (access !== "ok") return access;
  return input.row.participant_id === null && input.row.uploader_name !== input.clientName ? "not_found" : "ok";
}

export type UploadRefusal =
  | { body: typeof GUEST_REQUIRED; status: 403 }
  | { body: { error: "upload not found" }; status: 404 };

/** The response for a refused follow-up call. */
export function uploadRefusal(access: Exclude<UploadAccess, "ok">): UploadRefusal {
  return access === "guest_required"
    ? ({ body: GUEST_REQUIRED, status: 403 } as const)
    : ({ body: { error: "upload not found" }, status: 404 } as const);
}

type ServerOnlyColumn = "participant_id" | "thumb_key" | "display_key" | "poster_key";

/**
 * A moment as guests may see it: without the owner's participant id or raw
 * storage keys (guests get URLs, e.g. `withWebThumbnail`'s `thumb_url`).
 */
export function guestMoment<T extends Pick<MomentRow, "id">>(moment: T): Omit<T, ServerOnlyColumn> {
  const {
    participant_id: _owner,
    thumb_key: _thumb,
    display_key: _display,
    poster_key: _poster,
    ...rest
  } = moment as T & Partial<Record<ServerOnlyColumn, unknown>>;
  return rest;
}
