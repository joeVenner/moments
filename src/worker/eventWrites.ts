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

/** Billing kind (migration 0026): the operator's own, or paid by a plan's main or test event. */
export type NewEventKind = "operator" | "main" | "test";

/**
 * A plan event's dates when the plan sets them (test events), else null:
 * then expires_at alone decides, as for any event.
 */
export interface PlanEventDates {
  uploadsCloseAt: string;
  purgeAfter: string;
}

// The order is the bind order: ?1 is id, ?10 owner_user_id, ?11 kind.
const EVENT_COLUMNS =
  "id, slug, title, type, main_characters, description, cover_image_url, starts_at, expires_at, owner_user_id, kind, uploads_close_at, purge_after";
const EVENT_PARAMS = "?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13";

function eventValues(
  event: NewEvent,
  id: string,
  slug: string,
  kind: NewEventKind,
  dates: PlanEventDates | null
): unknown[] {
  return [
    id,
    slug,
    event.title,
    event.type,
    event.mainCharacters,
    event.description,
    event.coverImageUrl,
    event.startsAt,
    event.expiresAt,
    event.ownerUserId,
    kind,
    dates?.uploadsCloseAt ?? null,
    dates?.purgeAfter ?? null,
  ];
}

/**
 * Runs `insert` with a free slug. The slug check and the insert aren't
 * atomic: when another create took the same slug in between (the UNIQUE
 * constraint fires), it tries a suffixed one.
 */
async function withFreeSlug<T>(db: D1Database, title: string, insert: (slug: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const slug = await uniqueSlug(db, title, attempt === 0);
    try {
      return await insert(slug);
    } catch (error) {
      if (attempt + 1 >= SLUG_ATTEMPTS || !isSlugTaken(error)) throw error;
    }
  }
}

/** Creates one of the operator's events (public, open for uploads, no plan) and returns its id. */
export async function insertEvent(db: D1Database, event: NewEvent, id: string = crypto.randomUUID()): Promise<string> {
  return withFreeSlug(db, event.title, async (slug) => {
    await db
      .prepare(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (${EVENT_PARAMS})`)
      .bind(...eventValues(event, id, slug, "operator", null))
      .run();
    return id;
  });
}

/** The plan that pays for an event, which of its events is used, and the dates it sets. */
export interface PlanEventSpec {
  id: string;
  kind: Exclude<NewEventKind, "operator">;
  dates: PlanEventDates | null;
}

/**
 * An unused allowance of the new event's kind (?11) on the plan in ?14,
 * which must belong to the event's owner (?10) and not be purged. Included
 * events go before bought ones (`source = 'addon'` sorts false, i.e.
 * included, first).
 */
const FREE_ALLOWANCE = `
  SELECT a.id FROM event_allowances a JOIN plans p ON p.id = a.plan_id
  WHERE p.id = ?14 AND p.user_id = ?10 AND p.state != 'purged' AND a.kind = ?11 AND a.consumed_event_id IS NULL
  ORDER BY a.source = 'addon', a.created_at, a.id
  LIMIT 1`;

/**
 * Creates an event paid for by one of the plan's allowances of that kind,
 * and marks the allowance used, in one batch: either both happen or
 * neither. Returns the id, or null when the plan has none left.
 */
export async function insertPlanEvent(
  db: D1Database,
  event: NewEvent,
  plan: PlanEventSpec,
  id: string = crypto.randomUUID()
): Promise<string | null> {
  return withFreeSlug(db, event.title, async (slug) => {
    // ?1–?13 are the event's columns, ?14 the plan.
    const values = [...eventValues(event, id, slug, plan.kind, plan.dates), plan.id];
    const [inserted, spent] = await db.batch([
      db
        .prepare(`INSERT INTO events (${EVENT_COLUMNS}) SELECT ${EVENT_PARAMS} WHERE EXISTS (${FREE_ALLOWANCE})`)
        .bind(...values),
      // Same transaction, so the allowance the insert saw is still free. It
      // binds the same list as the insert (it uses only ?1, ?10, ?11 and ?14).
      db
        .prepare(
          `UPDATE event_allowances SET consumed_event_id = ?1
           WHERE id = (${FREE_ALLOWANCE}) AND EXISTS (SELECT 1 FROM events WHERE id = ?1)`
        )
        .bind(...values),
    ]);
    // Can't happen inside one transaction; a guard in case the SQL changes.
    // The batch is committed by now, so an unpaid event is removed again.
    if (inserted.meta.changes !== spent.meta.changes) {
      await db.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
      throw new Error("event and allowance out of step");
    }
    return inserted.meta.changes === 1 ? id : null;
  });
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
