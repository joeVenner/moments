import { hashEventPin, MAX_PIN_LENGTH, MIN_PIN_LENGTH, randomAccessToken } from "./eventAccess";
import { isStreamConfigured } from "./stream";
import { isStreamSigningConfigured, syncStreamSigning } from "./streamSigning";
import { normalizeDate } from "./eventWrites";
import type { Env, EventRow } from "./types";

/** Why a settings change was refused; `error` is the message the web has always shown. */
export type SettingsRefusal =
  | { kind: "not_found" }
  | { kind: "invalid"; field: string; error: string };

export type SettingsResult = { kind: "ok" } | SettingsRefusal;

export type AccessMode = "public" | "private";

export interface AccessChange {
  mode: AccessMode;
  /** A new PIN (already trimmed); empty or missing keeps the current one. */
  pin?: string;
}

/**
 * Makes an event public or private and optionally sets a new PIN.
 *
 * A new PIN may mean the old one leaked, so it revokes every grant
 * (access_version) and every shared invite link. Making an event private
 * again also revokes grants from its earlier private period. Stream videos
 * are re-signed in the background via `waitUntil`.
 */
export async function updateEventAccess(
  env: Env,
  eventId: string,
  change: AccessChange,
  waitUntil: (work: Promise<unknown>) => void
): Promise<SettingsResult> {
  const event = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<EventRow>();
  if (!event) return { kind: "not_found" };

  let salt = event.access_pin_salt;
  let hash = event.access_pin_hash;
  let inviteToken = event.invite_token ?? randomAccessToken();
  // Added in SQL, so two saves at once each revoke the grants before them.
  let accessVersionBump = 0;
  const pin = change.pin ?? "";
  if (pin) {
    if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
      return { kind: "invalid", field: "pin", error: `PIN must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} characters` };
    }
    salt = randomAccessToken().slice(0, 32);
    hash = await hashEventPin(pin, salt);
    accessVersionBump = 1;
    inviteToken = randomAccessToken();
  } else if (change.mode === "private" && event.access_mode !== "private") {
    accessVersionBump = 1;
  }
  if (change.mode === "private" && !hash) {
    return { kind: "invalid", field: "pin", error: "a PIN is required for private events" };
  }
  await env.DB.prepare(
    `UPDATE events
        SET access_mode = ?, access_pin_hash = ?, access_pin_salt = ?, invite_token = ?, access_version = access_version + ?
      WHERE id = ?`
  )
    .bind(change.mode, hash, salt, inviteToken, accessVersionBump, event.id)
    .run();
  // Re-apply requireSignedURLs to the event's existing Stream videos: on every
  // private save (backfills older uploads) and when going public.
  const isModeChange = event.access_mode !== change.mode;
  if (isStreamConfigured(env) && isStreamSigningConfigured(env) && (change.mode === "private" || isModeChange)) {
    // Per-video failures are logged inside; this catches the sync failing outright.
    waitUntil(
      syncStreamSigning(env, event.id, change.mode === "private").catch((error: unknown) => {
        console.error(
          JSON.stringify({
            scope: "stream",
            event: "stream_signing_sync_failed",
            eventId: event.id,
            error: error instanceof Error ? error.name : "unknown",
          })
        );
      })
    );
  }
  return { kind: "ok" };
}

/**
 * New end dates, already normalized. A key that is undefined is not being
 * changed; null clears that date.
 */
export interface LifecycleChange {
  expiresAt?: string | null;
  uploadsCloseAt?: string | null;
  purgeAfter?: string | null;
}

const LIFECYCLE_FIELDS = [
  ["expires_at", "expiresAt"],
  ["uploads_close_at", "uploadsCloseAt"],
  ["purge_after", "purgeAfter"],
] as const;

export type LifecycleField = (typeof LIFECYCLE_FIELDS)[number][0];

/**
 * Normalizes the date fields a request sent (an undefined one wasn't sent),
 * or names the first one that isn't a date.
 */
export function lifecycleChangeFrom(
  body: Partial<Record<LifecycleField, unknown>>
): { kind: "ok"; change: LifecycleChange } | { kind: "invalid"; field: LifecycleField } {
  const entries: [keyof LifecycleChange, string | null][] = [];
  for (const [field, key] of LIFECYCLE_FIELDS) {
    if (body[field] === undefined) continue;
    const value = normalizeDate(body[field]);
    if (value === undefined) return { kind: "invalid", field };
    entries.push([key, value]);
  }
  return { kind: "ok", change: Object.fromEntries(entries) as LifecycleChange };
}

/**
 * Sets when uploads close and when the event is deleted, and un-archives it.
 *
 * Sending only `expiresAt` makes it the single end date again (the web admin
 * only knows that one), so a stale split date can't outlive it.
 */
export async function updateEventLifecycle(db: D1Database, eventId: string, change: LifecycleChange): Promise<SettingsResult> {
  const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<EventRow>();
  if (!event) return { kind: "not_found" };

  const isSingleDate = change.uploadsCloseAt === undefined && change.purgeAfter === undefined;
  const expiresAt = change.expiresAt === undefined ? event.expires_at : change.expiresAt;
  const uploadsCloseAt = change.uploadsCloseAt !== undefined ? change.uploadsCloseAt : isSingleDate ? null : event.uploads_close_at;
  const purgeAfter = change.purgeAfter !== undefined ? change.purgeAfter : isSingleDate ? null : event.purge_after;
  const effectiveClose = uploadsCloseAt ?? expiresAt;
  const effectivePurge = purgeAfter ?? expiresAt;
  if (effectiveClose && effectivePurge && effectiveClose > effectivePurge) {
    return { kind: "invalid", field: "uploads_close_at", error: "uploads must close before the event is purged" };
  }
  await db
    .prepare("UPDATE events SET expires_at = ?, uploads_close_at = ?, purge_after = ?, archived_at = NULL WHERE id = ?")
    .bind(expiresAt, uploadsCloseAt, purgeAfter, event.id)
    .run();
  return { kind: "ok" };
}
