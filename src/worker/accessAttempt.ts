import {
  decidePinAttempt,
  hashClientIp,
  hashEventPin,
  MAX_PIN_LENGTH,
  PIN_FAILURE_WINDOW_MINUTES,
  PIN_SLOWDOWN_MS,
  timingSafeEqual,
} from "./eventAccess";
import type { EventRow } from "./types";

/**
 * Checks a PIN or invite token for a private event. Shared by the web route
 * (which then sets a cookie) and /api/v1 (which only returns the grant), so
 * both get the same lockout.
 */

export type AccessAttemptEvent = Pick<
  EventRow,
  "id" | "access_mode" | "invite_token" | "access_pin_hash" | "access_pin_salt"
>;

export interface AccessAttemptInput {
  pin: string;
  inviteToken: string;
  /** CF-Connecting-IP; only its keyed hash is stored. */
  clientIp: string;
}

export type AccessAttemptResult =
  | { kind: "granted" }
  | { kind: "invalid" }
  | { kind: "blocked"; retryAfterSeconds: number };

export const ACCESS_RETRY_AFTER_SECONDS = PIN_FAILURE_WINDOW_MINUTES * 60;

/**
 * Invite link first (never throttled: it's the host's escape hatch), then the
 * PIN with per-client and per-event lockout. The caller must have checked
 * that the event is private and that `secret` is set.
 */
export async function attemptEventAccess(
  db: D1Database,
  secret: string,
  event: AccessAttemptEvent,
  input: AccessAttemptInput,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<AccessAttemptResult> {
  const pin = input.pin.trim();
  if (input.inviteToken && event.invite_token && timingSafeEqual(input.inviteToken, event.invite_token)) {
    return { kind: "granted" };
  }
  if (!pin || pin.length > MAX_PIN_LENGTH || !event.access_pin_hash || !event.access_pin_salt) {
    return { kind: "invalid" };
  }

  // Record the attempt *before* checking it, so concurrent guesses count
  // each other; the row is removed again if the PIN turns out to be right.
  const ipHash = await hashClientIp(secret, input.clientIp);
  const attemptId = crypto.randomUUID();
  await db.prepare("INSERT INTO access_failures (id, event_id, ip_hash) VALUES (?, ?, ?)")
    .bind(attemptId, event.id, ipHash)
    .run();
  const counts = await db
    .prepare(
      `SELECT COALESCE(SUM(ip_hash = ?), 0) AS client_failures, COUNT(*) AS event_failures
         FROM access_failures
        WHERE event_id = ? AND created_at > datetime('now', ?)`
    )
    .bind(ipHash, event.id, `-${PIN_FAILURE_WINDOW_MINUTES} minutes`)
    .first<{ client_failures: number; event_failures: number }>();
  const decision = decidePinAttempt(
    Math.max(0, (counts?.client_failures ?? 1) - 1),
    Math.max(0, (counts?.event_failures ?? 1) - 1)
  );
  if (decision === "block") return { kind: "blocked", retryAfterSeconds: ACCESS_RETRY_AFTER_SECONDS };
  if (decision === "slow") await sleep(PIN_SLOWDOWN_MS);

  const isPinValid = timingSafeEqual(await hashEventPin(pin, event.access_pin_salt), event.access_pin_hash);
  if (!isPinValid) return { kind: "invalid" };

  await db.prepare("DELETE FROM access_failures WHERE id = ?").bind(attemptId).run();
  return { kind: "granted" };
}
