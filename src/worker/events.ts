import type { EventRow } from "./types";

const ACTIVE_EVENT_FILTER =
  "slug = ? AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))";

/** Id of a live (not archived, not expired) event, or null. */
export async function getEventBySlug(db: D1Database, slug: string): Promise<{ id: string } | null> {
  return db.prepare(`SELECT id FROM events WHERE ${ACTIVE_EVENT_FILTER}`).bind(slug).first<{ id: string }>();
}

/** Full row of a live event, or null. Contains secrets: never return it as-is. */
export async function getActiveEventBySlug(db: D1Database, slug: string): Promise<EventRow | null> {
  return db.prepare(`SELECT * FROM events WHERE ${ACTIVE_EVENT_FILTER}`).bind(slug).first<EventRow>();
}

export type PublicEvent = Omit<EventRow, "access_pin_hash" | "access_pin_salt" | "invite_token" | "access_version">;

/** The event as guests may see it: PIN hash/salt, invite token and access version removed. */
export function toPublicEvent(event: EventRow): PublicEvent {
  const {
    access_pin_hash: _hash,
    access_pin_salt: _salt,
    invite_token: _token,
    access_version: _version,
    ...publicEvent
  } = event;
  return publicEvent;
}
