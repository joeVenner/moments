import { timingSafeEqual } from "./eventAccess";
import { sqlTimestamp } from "./events";

/**
 * Sign-in sessions for hosts in the native app. The admin password is the
 * only method for now (Sign in with Apple and email codes come later, on the
 * same table). A session is an opaque bearer token: only its SHA-256 is
 * stored, so a database copy can't be replayed.
 */

export const HOST_SESSION_TTL_DAYS = 30;
export type HostSubject = "operator";
/** The operator's user row (seeded by migration 0023). */
export const OPERATOR_USER_ID = "00000000-0000-0000-0000-000000000001";

export interface HostCredentialsEnv {
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  /** Keys the credential tag; sessions are unavailable without it. */
  EVENT_ACCESS_SECRET?: string;
}

export interface HostSession {
  id: string;
  subject: HostSubject;
  /** Whose session it is (`users.id`). */
  userId: string;
  expiresAt: string;
}

const TOKEN_PREFIX = "hs_";
/** "hs_" + 32 random bytes as unpadded base64url (43 characters). */
const TOKEN_PATTERN = /^hs_[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The token has 256 bits of entropy, so unkeyed SHA-256 can't be reversed. */
async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

/**
 * HMAC of a username and password under the server secret. Length-prefixed
 * so no two pairs share an input; domain-separated from the secret's other
 * uses (access grants, media grants, IP hashing).
 */
async function credentialTag(secret: string, username: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = `host-credentials:${username.length}:${username}\0${password}`;
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** The secret and the configured credentials' tag; null when sign-in is not set up. */
async function configured(env: HostCredentialsEnv): Promise<{ secret: string; tag: string } | null> {
  if (!env.EVENT_ACCESS_SECRET || !env.ADMIN_USER || !env.ADMIN_PASSWORD) return null;
  const secret = env.EVENT_ACCESS_SECRET;
  return { secret, tag: await credentialTag(secret, env.ADMIN_USER, env.ADMIN_PASSWORD) };
}

export function isHostSignInConfigured(env: HostCredentialsEnv): boolean {
  return Boolean(env.EVENT_ACCESS_SECRET && env.ADMIN_USER && env.ADMIN_PASSWORD);
}

/** Opens a session for the operator. The raw token is returned once. */
export async function createHostSession(
  db: D1Database,
  env: HostCredentialsEnv,
  now: Date = new Date()
): Promise<{ token: string; session: HostSession }> {
  const tag = (await configured(env))?.tag;
  if (!tag) throw new Error("host sign-in is not configured");
  const token = TOKEN_PREFIX + base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const session: HostSession = {
    id: crypto.randomUUID(),
    subject: "operator",
    userId: OPERATOR_USER_ID,
    expiresAt: sqlTimestamp(new Date(now.getTime() + HOST_SESSION_TTL_DAYS * 86_400_000)),
  };
  await db.batch([
    db.prepare("DELETE FROM host_sessions WHERE expires_at <= ?").bind(sqlTimestamp(now)),
    db
      .prepare(
        "INSERT INTO host_sessions (id, token_hash, subject, user_id, credential_tag, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(session.id, await hashToken(token), session.subject, session.userId, tag, sqlTimestamp(now), session.expiresAt),
  ]);
  return { token, session };
}

/**
 * The live session for a presented token, or null: unknown, signed out,
 * expired, or opened with credentials that have since changed.
 */
export async function resolveHostSession(
  db: D1Database,
  env: HostCredentialsEnv,
  token: string,
  now: Date = new Date()
): Promise<HostSession | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tag = (await configured(env))?.tag;
  if (!tag) return null;
  // A deleted account's sessions stop working at once. A row without a user
  // came from code older than 0023 (during a deploy): it is the operator's.
  // Remove the fallback before any other host can sign in (it fails open).
  const row = await db
    .prepare(
      `SELECT s.id, s.subject, COALESCE(s.user_id, ?1) AS user_id, s.credential_tag, s.expires_at
       FROM host_sessions s JOIN users u ON u.id = COALESCE(s.user_id, ?1)
       WHERE s.token_hash = ?2 AND s.expires_at > ?3 AND u.status = 'active'`
    )
    .bind(OPERATOR_USER_ID, await hashToken(token), sqlTimestamp(now))
    .first<{ id: string; subject: HostSubject; user_id: string; credential_tag: string; expires_at: string }>();
  if (!row || !timingSafeEqual(row.credential_tag, tag)) return null;
  return { id: row.id, subject: row.subject, userId: row.user_id, expiresAt: row.expires_at };
}

export async function deleteHostSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM host_sessions WHERE id = ?").bind(sessionId).run();
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return match ? match[1] : null;
}
