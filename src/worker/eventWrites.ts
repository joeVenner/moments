import { randomSuffix, slugify } from "./slugify";

/**
 * A date for an event column: "YYYY-MM-DD HH:MM:SS" in UTC, null to clear,
 * or undefined when the value can't be a date (callers answer 400).
 */
export function normalizeDate(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // Outside this range toISOString() is not "YYYY-..." and would compare as
  // already past against datetime('now'), purging the event immediately.
  const year = parsed.getUTCFullYear();
  if (year < 2000 || year > 2100) return undefined;
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

/** A slug from the title no other event uses (guests' links depend on it). */
export async function uniqueSlug(db: D1Database, title: string, isFirstChoiceAllowed = true): Promise<string> {
  const base = slugify(title) || "event";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 && isFirstChoiceAllowed ? base : `${base}-${randomSuffix()}`;
    const existing = await db.prepare("SELECT id FROM events WHERE slug = ?").bind(candidate).first();
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** What a new event starts with; dates already normalized. Always public. */
export interface NewEvent {
  title: string;
  type: string;
  mainCharacters: string | null;
  description: string | null;
  coverImageUrl: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  /** The host who owns it (`users.id`). */
  ownerUserId: string;
}

/** How often a create races another for the same slug before giving up. */
const SLUG_ATTEMPTS = 3;

/**
 * Creates an event (public, open for uploads) and returns its id. The slug
 * check and the insert aren't atomic: when another create took the same
 * slug in between (the UNIQUE constraint fires), it tries a suffixed one.
 */
export async function insertEvent(db: D1Database, event: NewEvent, id: string = crypto.randomUUID()): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const slug = await uniqueSlug(db, event.title, attempt === 0);
    try {
      await db
        .prepare(
          `INSERT INTO events (id, slug, title, type, main_characters, description, cover_image_url, starts_at, expires_at, owner_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          slug,
          event.title,
          event.type,
          event.mainCharacters,
          event.description,
          event.coverImageUrl,
          event.startsAt,
          event.expiresAt,
          event.ownerUserId
        )
        .run();
      return id;
    } catch (error) {
      if (attempt + 1 >= SLUG_ATTEMPTS || !isSlugTaken(error)) throw error;
    }
  }
}

function isSlugTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed: events.slug");
}

/**
 * The fields a host can change after creating an event. Omitted fields stay
 * as they are; null clears an optional one. The slug never changes: guests'
 * links and QR codes already point at it.
 */
export interface EventDetailsPatch {
  title?: string;
  type?: string;
  mainCharacters?: string | null;
  description?: string | null;
  startsAt?: string | null;
}

const PATCH_COLUMNS: Record<keyof EventDetailsPatch, string> = {
  title: "title",
  type: "type",
  mainCharacters: "main_characters",
  description: "description",
  startsAt: "starts_at",
};

/** Applies the patch; false when no event has this id. */
export async function updateEventDetails(db: D1Database, id: string, patch: EventDetailsPatch): Promise<boolean> {
  const changedKeys = (Object.keys(PATCH_COLUMNS) as (keyof EventDetailsPatch)[]).filter((key) => patch[key] !== undefined);
  if (changedKeys.length === 0) {
    return (await db.prepare("SELECT 1 FROM events WHERE id = ?").bind(id).first()) !== null;
  }
  // Column names come only from PATCH_COLUMNS; every value is bound.
  const assignments = changedKeys.map((key) => `${PATCH_COLUMNS[key]} = ?`).join(", ");
  const result = await db
    .prepare(`UPDATE events SET ${assignments} WHERE id = ?`)
    .bind(...changedKeys.map((key) => patch[key] ?? null), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
