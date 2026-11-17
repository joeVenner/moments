import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, EventRow } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PIN_HASH_ITERATIONS = 100_000;

export const ACCESS_GRANT_TTL_SECONDS = 60 * 60 * 24 * 7;
/** Applies to newly set PINs only; existing shorter PINs keep verifying. */
export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 20;
export const PIN_FAILURE_WINDOW_MINUTES = 15;
/**
 * Per (event, client) cap. Generous enough that guests sharing a venue's NAT
 * can make a few typos; the invite link always bypasses it.
 */
export const MAX_PIN_FAILURES_PER_CLIENT = 10;
/** Event-wide: slow attempts first, and only reject once a distributed attack is obvious. */
export const EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD = 30;
export const EVENT_PIN_FAILURE_BLOCK_THRESHOLD = 200;
export const PIN_SLOWDOWN_MS = 1_000;
/**
 * Raw invite-token cookies issued before signed grants are accepted until this
 * date (unix seconds) so the deploy doesn't sign current guests out. Remove the
 * legacy path after it passes.
 */
export const LEGACY_RAW_TOKEN_ACCEPTED_UNTIL = Date.UTC(2027, 0, 15) / 1000;

type AccessEvent = Pick<EventRow, "id" | "access_mode" | "invite_token" | "access_version">;

export interface AccessGrantClaims {
  eventId: string;
  accessVersion: number;
  /** Unix seconds. */
  expiresAt: number;
}

export interface IssuedAccessGrant {
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type PinAttemptDecision = "allow" | "slow" | "block";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Constant-time comparison for equal-length secrets (invite tokens, PIN hashes). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function hashEventPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: PIN_HASH_ITERATIONS },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export function accessCookieName(eventId: string): string {
  return `moments_access_${eventId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

// Domain-separate the two uses of EVENT_ACCESS_SECRET (grants vs IP hashing).
function grantSigningInput(payload: string): Uint8Array {
  return encoder.encode(`grant:${payload}`);
}

/** Signs `{event, access_version, exp}` as `<base64url payload>.<base64url HMAC-SHA256>`. */
export async function signAccessGrant(secret: string, claims: AccessGrantClaims): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ e: claims.eventId, v: claims.accessVersion, x: claims.expiresAt }))
  );
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), grantSigningInput(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Returns the claims of a well-formed, correctly signed, unexpired grant; otherwise null. */
export async function verifyAccessGrant(
  secret: string,
  token: string,
  nowSeconds: number
): Promise<AccessGrantClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, encodedSignature] = parts;
  const signature = fromBase64Url(encodedSignature);
  const payloadBytes = fromBase64Url(payload);
  if (!signature || !payloadBytes) return null;

  // crypto.subtle.verify compares in constant time.
  const isAuthentic = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, grantSigningInput(payload));
  if (!isAuthentic) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { e, v, x } = parsed as Record<string, unknown>;
  if (typeof e !== "string" || !Number.isInteger(v) || !Number.isInteger(x)) return null;
  if ((x as number) <= nowSeconds) return null;
  return { eventId: e, accessVersion: v as number, expiresAt: x as number };
}

/**
 * Whether the request may read a private event: a signed grant for the
 * event's current access_version, or (legacy, access_version 1 only) the raw
 * invite token that older web sessions hold in their cookie. Bumping
 * access_version revokes both. Always await this; a bare Promise is truthy.
 */
export async function verifyEventAccess<E extends { Bindings: Env }>(
  c: Context<E>,
  event: AccessEvent,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  options: { signedGrantOnly?: boolean } = {}
): Promise<boolean> {
  if (event.access_mode !== "private") return true;
  // signedGrantOnly (native API): header only, no cookie, no raw invite token.
  const supplied = options.signedGrantOnly
    ? c.req.header("X-Event-Access")
    : c.req.header("X-Event-Access") ?? getCookie(c, accessCookieName(event.id));
  if (!supplied) return false;

  const secret = c.env.EVENT_ACCESS_SECRET;
  if (secret) {
    const claims = await verifyAccessGrant(secret, supplied, nowSeconds);
    if (claims) return claims.eventId === event.id && claims.accessVersion === event.access_version;
  }

  if (options.signedGrantOnly) return false;

  // Transition path for guests who unlocked before signed grants existed.
  // Any access_version bump (PIN change, going private again) revokes it.
  return (
    nowSeconds < LEGACY_RAW_TOKEN_ACCEPTED_UNTIL &&
    event.access_version === 1 &&
    Boolean(event.invite_token) &&
    timingSafeEqual(supplied, event.invite_token ?? "")
  );
}

/** Signs a grant for the event's current access_version (no cookie). */
export async function issueAccessGrant(
  secret: string,
  event: Pick<EventRow, "id" | "access_version">,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<IssuedAccessGrant> {
  const expiresAt = nowSeconds + ACCESS_GRANT_TTL_SECONDS;
  const accessToken = await signAccessGrant(secret, {
    eventId: event.id,
    accessVersion: event.access_version,
    expiresAt,
  });
  return { accessToken, expiresAt };
}

/**
 * Sets the access cookie and returns the grant so native clients can send it
 * as `X-Event-Access`.
 */
export async function grantEventAccess(
  c: Context<{ Bindings: Env }>,
  secret: string,
  event: Pick<EventRow, "id" | "access_version">,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<IssuedAccessGrant> {
  const { accessToken, expiresAt } = await issueAccessGrant(secret, event, nowSeconds);
  setCookie(c, accessCookieName(event.id), accessToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: ACCESS_GRANT_TTL_SECONDS,
  });
  return { accessToken, expiresAt };
}

/**
 * Throttling key for a client IP. IPv6 is truncated to its /64, because one
 * subscriber usually controls a whole /64 and could otherwise rotate freely.
 */
export function clientIpKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = ip.includes("::") ? [...headGroups, ...Array(missing).fill("0"), ...tailGroups] : headGroups;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Keyed hash of the client IP so throttling never stores raw addresses. */
export async function hashClientIp(secret: string, ip: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`ip:${clientIpKey(ip)}`));
  return bytesToHex(new Uint8Array(signature)).slice(0, 32);
}

/** Counts are failures recorded *before* the current attempt. */
export function decidePinAttempt(clientFailures: number, eventFailures: number): PinAttemptDecision {
  if (clientFailures >= MAX_PIN_FAILURES_PER_CLIENT) return "block";
  if (eventFailures >= EVENT_PIN_FAILURE_BLOCK_THRESHOLD) return "block";
  if (eventFailures >= EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD) return "slow";
  return "allow";
}

export function randomAccessToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}
