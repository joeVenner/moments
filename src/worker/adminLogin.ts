import { clientIpKey, hashClientIp, timingSafeEqual } from "./eventAccess";

/**
 * One check for every admin login: the web dashboard's Basic auth and the
 * app's sign-in. Failures are counted in D1 per client and in all, and the
 * lockout is decided before the password is compared, so while it holds a
 * right guess gets the same answer as a wrong one.
 */

export const ADMIN_FAILURE_WINDOW_MINUTES = 15;
export const MAX_ADMIN_FAILURES_PER_CLIENT = 10;
/** Across all clients, so many addresses together can't keep guessing. */
export const MAX_ADMIN_FAILURES_TOTAL = 100;
export const ADMIN_RETRY_AFTER_SECONDS = ADMIN_FAILURE_WINDOW_MINUTES * 60;

export type AdminLoginResult = "ok" | "invalid" | "locked";

export interface AdminLoginEnv {
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  /** Keys the stored IP hash when set (unkeyed SHA-256 otherwise). */
  EVENT_ACCESS_SECRET?: string;
}

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Length-prefixed, so moving the separator between the two can't match. */
function credentialInput(username: string, password: string): string {
  return `admin-credentials:${username.length}:${username}\0${password}`;
}

/**
 * Constant-time: both sides are compared as SHA-256 digests, so neither the
 * username nor the password length leaks. Never matches when either is unset.
 */
export async function adminCredentialsMatch(env: AdminLoginEnv, username: string, password: string): Promise<boolean> {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return false;
  const [given, expected] = await Promise.all([
    sha256Hex(credentialInput(username, password)),
    sha256Hex(credentialInput(env.ADMIN_USER, env.ADMIN_PASSWORD)),
  ]);
  return timingSafeEqual(given, expected);
}

/**
 * Keyed hash of the client IP, never the address. Keyed with the access
 * secret, or with the admin password where that isn't set (local dev): an
 * unkeyed IPv4 hash could be reversed by trying every address.
 */
async function ipHash(env: AdminLoginEnv, clientIp: string): Promise<string> {
  if (env.EVENT_ACCESS_SECRET) return hashClientIp(env.EVENT_ACCESS_SECRET, clientIp);
  const key = await crypto.subtle.importKey(
    "raw",
    // HMAC refuses an empty key; nothing can log in then anyway.
    encoder.encode(env.ADMIN_PASSWORD || "moments-admin-ip"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`admin-ip:${clientIpKey(clientIp)}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

const WINDOW = `-${ADMIN_FAILURE_WINDOW_MINUTES} minutes`;

/**
 * The password is compared first (constant time); then every attempt makes
 * the same single D1 round trip:
 *
 * 1. A conditional insert: a failure row, only for a wrong password and only
 *    while neither limit is reached, so one client can add at most 10 rows
 *    and every locked attempt is read-only, whether right or wrong. D1 runs writes one at a time, so a burst of
 *    guesses counts each other. A right password runs the same statement
 *    with its condition false, keeping the timing alike.
 * 2. The counts, from which the failures *before* this attempt are decided.
 *
 * While locked, right and wrong get the same answer from the same work. A
 * right password writes nothing, so the host's own (parallel) requests never
 * count against them. Old rows are pruned by the hourly job (lifecycle.ts).
 */
export async function attemptAdminLogin(
  db: D1Database,
  env: AdminLoginEnv,
  attempt: { username: string; password: string; clientIp: string }
): Promise<AdminLoginResult> {
  const isMatch = await adminCredentialsMatch(env, attempt.username, attempt.password);
  const client = await ipHash(env, attempt.clientIp);
  const [insert, countResult] = await db.batch<{ client_failures: number; total_failures: number }>([
    db
      .prepare(
        `INSERT INTO admin_login_failures (id, ip_hash)
         SELECT ?, ?
          WHERE ? = 0
            AND (SELECT COUNT(*) FROM admin_login_failures WHERE ip_hash = ? AND created_at > datetime('now', ?)) < ?
            AND (SELECT COUNT(*) FROM admin_login_failures WHERE created_at > datetime('now', ?)) < ?`
      )
      .bind(
        crypto.randomUUID(),
        client,
        isMatch ? 1 : 0,
        client,
        WINDOW,
        MAX_ADMIN_FAILURES_PER_CLIENT,
        WINDOW,
        MAX_ADMIN_FAILURES_TOTAL
      ),
    db
      .prepare(
        `SELECT COALESCE(SUM(ip_hash = ?), 0) AS client_failures, COUNT(*) AS total_failures
           FROM admin_login_failures
          WHERE created_at > datetime('now', ?)`
      )
      .bind(client, WINDOW),
  ]);
  const inserted = insert.meta.changes ?? 0;
  const counts = countResult.results[0];
  const isLocked =
    (counts?.client_failures ?? 0) - inserted >= MAX_ADMIN_FAILURES_PER_CLIENT ||
    (counts?.total_failures ?? 0) - inserted >= MAX_ADMIN_FAILURES_TOTAL;
  if (isLocked) return "locked";
  return isMatch ? "ok" : "invalid";
}

/** Failures only matter inside the window; run hourly. */
export async function pruneAdminLoginFailures(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM admin_login_failures WHERE created_at <= datetime('now', ?)").bind(WINDOW).run();
}
