import type { EventRow } from "./types";

/**
 * Lifecycle (migration 0015). Each split column falls back to expires_at, so a
 * legacy event (only expires_at) closes uploads, disappears and is purged at
 * the same instant, exactly as before.
 */
export const PURGE_AT_SQL = "COALESCE(purge_after, expires_at)";
export const UPLOADS_CLOSE_AT_SQL = "COALESCE(uploads_close_at, expires_at)";

/** Visible until purged: archived or past the purge time means gone. */
const ACTIVE_EVENT_FILTER = `slug = ? AND archived_at IS NULL AND (${PURGE_AT_SQL} IS NULL OR ${PURGE_AT_SQL} > datetime('now'))`;

/** In-flight uploads may finish this long after uploads close. */
export const UPLOAD_FINISH_GRACE_MINUTES = 30;

const UPLOADS_OPEN_SQL = `CASE WHEN ${UPLOADS_CLOSE_AT_SQL} IS NULL OR ${UPLOADS_CLOSE_AT_SQL} > datetime('now') THEN 1 ELSE 0 END`;
const UPLOADS_FINISHING_SQL = `CASE WHEN ${UPLOADS_CLOSE_AT_SQL} IS NULL OR ${UPLOADS_CLOSE_AT_SQL} > datetime('now', '-${UPLOAD_FINISH_GRACE_MINUTES} minutes') THEN 1 ELSE 0 END`;

export interface LiveEventRef {
  id: string;
  /** 1 while new uploads are accepted, 0 once uploads_close_at (or expires_at) has passed. */
  uploads_open: number;
  /** 1 while sessions opened before the close may still finish (close + grace). */
  uploads_finishing: number;
}

/** Id of a live (not archived, not purged) event and whether it takes uploads, or null. */
export async function getEventBySlug(db: D1Database, slug: string): Promise<LiveEventRef | null> {
  return db
    .prepare(
      `SELECT id, ${UPLOADS_OPEN_SQL} AS uploads_open, ${UPLOADS_FINISHING_SQL} AS uploads_finishing
         FROM events WHERE ${ACTIVE_EVENT_FILTER}`
    )
    .bind(slug)
    .first<LiveEventRef>();
}

export const UPLOADS_CLOSED = {
  error: "Uploads are closed for this event.",
  code: "uploads_closed",
} as const;

/** `YYYY-MM-DD HH:MM:SS` in UTC, the format D1 stores and the API returns. */
export const sqlTimestamp = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

/** The inverse of sqlTimestamp: "YYYY-MM-DD HH:MM:SS" (UTC) as a Date; throws on anything else. */
export function fromSqlTimestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error(`not a stored timestamp: ${value}`);
  return new Date(`${value.replace(" ", "T")}Z`);
}

/** Whether an upload session opened before the close may still finish at `now`. */
export function canFinishUploads(
  event: Pick<EventRow, "uploads_close_at" | "expires_at">,
  now: Date = new Date()
): boolean {
  return areUploadsOpen(event, sqlTimestamp(new Date(now.getTime() - UPLOAD_FINISH_GRACE_MINUTES * 60_000)));
}

/** Whether new uploads are accepted at `now` (same rule as the SQL above). */
export function areUploadsOpen(
  event: Pick<EventRow, "uploads_close_at" | "expires_at">,
  now: string = new Date().toISOString().slice(0, 19).replace("T", " ")
): boolean {
  const closesAt = event.uploads_close_at ?? event.expires_at;
  return closesAt === null || closesAt > now;
}

/** Full row of a live event, or null. Contains secrets: never return it as-is. */
export async function getActiveEventBySlug(db: D1Database, slug: string): Promise<EventRow | null> {
  return db.prepare(`SELECT * FROM events WHERE ${ACTIVE_EVENT_FILTER}`).bind(slug).first<EventRow>();
}

export type PublicEvent = Omit<
  EventRow,
  "access_pin_hash" | "access_pin_salt" | "invite_token" | "access_version" | "owner_user_id" | "kind"
> & {
  /** Whether new uploads are accepted right now. */
  uploads_open: boolean;
};

/**
 * The event as guests may see it: PIN hash/salt, invite token and access
 * version removed, plus the computed uploads_open flag.
 */
export function toPublicEvent(event: EventRow): PublicEvent {
  const {
    access_pin_hash: _hash,
    access_pin_salt: _salt,
    invite_token: _token,
    access_version: _version,
    // Who hosts it is nobody else's business (it will be their App Store account token).
    owner_user_id: _owner,
    // Billing detail; the host API adds it back. Guests get a test badge later.
    kind: _kind,
    ...publicEvent
  } = event;
  return { ...publicEvent, uploads_open: areUploadsOpen(event) };
}
