import type { MomentMedia } from "./media";
import { streamApiUrl, streamAuthHeaders } from "./stream";
import type { Env } from "./types";

/**
 * Signed playback for private-event Stream videos.
 *
 * Opt-in: nothing changes until STREAM_SIGNING_KEY_ID and STREAM_SIGNING_JWK
 * (the base64 `jwk` returned by POST /stream/keys) are set. Then private
 * events' videos are uploaded with requireSignedURLs, and every Stream URL we
 * return for a private event carries a short-lived RS256 token in place of the
 * video uid (iframe, HLS manifest and thumbnail paths alike).
 */

/** Tokens live 1-2 h: expiry is rounded up to the next hour boundary + 1 h. */
const TOKEN_BUCKET_SECONDS = 60 * 60;
const STREAM_UID = /^[a-f0-9]{32}$/;
const STREAM_HOST = /^https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\/([a-f0-9]{32})\//;
const TOKEN_CACHE_LIMIT = 1_000;

/**
 * Signing failed (malformed or revoked key). Routes fail closed with 503 rather
 * than leak the raw uid; app.onError maps it.
 */
export class StreamSigningError extends Error {
  constructor(cause: unknown) {
    super("Stream URL signing failed", { cause });
    this.name = "StreamSigningError";
  }
}

export const STREAM_SIGNING_UNAVAILABLE = {
  error: "Video playback is temporarily unavailable.",
  code: "stream_signing_unavailable",
} as const;

export function isStreamSigningConfigured(env: Env): boolean {
  return Boolean(env.STREAM_SIGNING_KEY_ID && env.STREAM_SIGNING_JWK);
}

/** Whether a private event's Stream URLs must be signed in this deployment. */
export function shouldSignStream(env: Env, event: { access_mode: string }): boolean {
  return event.access_mode === "private" && isStreamSigningConfigured(env);
}

/** Expiry shared by every token minted in the same hour, so URLs stay stable (cacheable). */
export function tokenExpiry(nowSeconds: number): number {
  return Math.ceil((nowSeconds + 1) / TOKEN_BUCKET_SECONDS) * TOKEN_BUCKET_SECONDS + TOKEN_BUCKET_SECONDS;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encodeJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

// Per-isolate caches. The key is imported once; tokens are deterministic
// (RSASSA-PKCS1-v1_5) so caching by uid+expiry only saves CPU, never changes output.
let cachedKey: { id: string; jwk: string; key: Promise<CryptoKey> } | null = null;
const tokenCache = new Map<string, string>();

/**
 * Decodes STREAM_SIGNING_JWK. Throws a fixed message on any problem so no
 * fragment of the secret can reach logs (JSON.parse errors quote their input).
 */
function parsePrivateJwk(base64: string): JsonWebKey {
  let parsed: unknown;
  try {
    if (base64.length > 16_384) throw new Error();
    parsed = JSON.parse(atob(base64));
  } catch {
    throw new Error("stream signing key is not base64 JSON");
  }
  const jwk = parsed as JsonWebKey;
  if (typeof parsed !== "object" || parsed === null || jwk.kty !== "RSA" || typeof jwk.d !== "string") {
    throw new Error("stream signing key is not an RSA private JWK");
  }
  return jwk;
}

function signingKey(env: Env): Promise<CryptoKey> {
  const id = env.STREAM_SIGNING_KEY_ID ?? "";
  const jwk = env.STREAM_SIGNING_JWK ?? "";
  if (cachedKey?.id !== id || cachedKey.jwk !== jwk) {
    // Decoding inside the promise turns a malformed secret into a rejection.
    const key = Promise.resolve().then(() =>
      crypto.subtle.importKey(
        "jwk",
        parsePrivateJwk(jwk),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      )
    );
    // Do not keep a rejected import around; the next request retries.
    key.catch(() => {
      if (cachedKey?.key === key) cachedKey = null;
    });
    cachedKey = { id, jwk, key };
  }
  return cachedKey.key;
}

/**
 * RS256 Stream token for one video, valid until `exp` (unix seconds).
 * @throws StreamSigningError when the configured key cannot sign.
 */
export async function signStreamToken(env: Env, uid: string, exp: number): Promise<string> {
  if (!STREAM_UID.test(uid)) throw new Error("invalid Stream uid");
  try {
    return await signWithKey(env, uid, exp);
  } catch (error) {
    // Logged without key material: only the key id and the error class.
    console.error(
      JSON.stringify({
        event: "stream_signing_failed",
        keyId: env.STREAM_SIGNING_KEY_ID ?? null,
        error: error instanceof Error ? error.name : "unknown",
      })
    );
    throw new StreamSigningError(error);
  }
}

async function signWithKey(env: Env, uid: string, exp: number): Promise<string> {
  const keyId = env.STREAM_SIGNING_KEY_ID ?? "";
  const cacheKey = `${keyId}:${uid}:${exp}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const unsigned = `${encodeJson({ alg: "RS256", kid: keyId })}.${encodeJson({ sub: uid, kid: keyId, exp })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await signingKey(env),
    new TextEncoder().encode(unsigned)
  );
  const token = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
  tokenCache.set(cacheKey, token);
  return token;
}

/** Video uid of a Stream URL we generated (`https://customer-x.cloudflarestream.com/<uid>/...`). */
export function streamUidOf(url: string | null | undefined): string | null {
  return url ? (STREAM_HOST.exec(url)?.[1] ?? null) : null;
}

function withToken(url: string | null, uid: string, token: string): string | null {
  return url && streamUidOf(url) === uid ? url.replace(`/${uid}/`, `/${token}/`) : url;
}

type SignableMoment = { media_url: string; media?: MomentMedia };

/**
 * Returns the moments with Stream URLs (media_url and, when present, the media
 * object's url, hls_url and poster_url) carrying a playback token. Non-Stream
 * moments pass through untouched. Call only when shouldSignStream() is true.
 */
export async function signStreamMoments<T extends SignableMoment>(
  env: Env,
  moments: readonly T[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<T[]> {
  const exp = tokenExpiry(nowSeconds);
  return Promise.all(
    moments.map(async (moment) => {
      const uid = streamUidOf(moment.media_url);
      if (!uid) return moment;
      const token = await signStreamToken(env, uid, exp);
      const signed = { ...moment, media_url: withToken(moment.media_url, uid, token) ?? moment.media_url };
      if (!moment.media) return signed;
      return {
        ...signed,
        media: {
          ...moment.media,
          url: withToken(moment.media.url, uid, token) ?? moment.media.url,
          hls_url: withToken(moment.media.hls_url, uid, token),
          poster_url: withToken(moment.media.poster_url, uid, token),
        },
      };
    })
  );
}

/** Signs only when the event needs it; otherwise returns the moments as-is. */
export async function signMomentsForEvent<T extends SignableMoment>(
  env: Env,
  event: { access_mode: string },
  moments: readonly T[]
): Promise<T[]> {
  return shouldSignStream(env, event) ? signStreamMoments(env, moments) : [...moments];
}

// What the web uploader sends. Everything else (allowedorigins, expiry,
// scheduleddeletion, watermark, requiresignedurls, ...) is the server's call.
const ALLOWED_TUS_KEYS = new Set(["name", "filetype", "maxdurationseconds"]);
const TUS_VALUE = /^[A-Za-z0-9+/]{0,1024}={0,2}$/;
const MAX_TUS_METADATA_LENGTH = 4096;

/**
 * tus Upload-Metadata for a new Stream upload: keeps only allowlisted,
 * well-formed client entries and adds `requiresignedurls` when the server
 * requires it. Anything malformed or oversized is dropped, not forwarded.
 */
export function streamUploadMetadata(clientMetadata: string, requireSigned: boolean): string {
  const seen = new Set<string>();
  const entries =
    clientMetadata.length > MAX_TUS_METADATA_LENGTH
      ? []
      : clientMetadata.split(",").flatMap((raw) => {
          const parts = raw.trim().split(/\s+/);
          if (parts.length > 2) return [];
          const [key, value = ""] = parts;
          const normalized = key.toLowerCase();
          if (!ALLOWED_TUS_KEYS.has(normalized) || seen.has(normalized) || !TUS_VALUE.test(value)) return [];
          seen.add(normalized);
          return [value ? `${key} ${value}` : key];
        });
  if (requireSigned) entries.push("requiresignedurls");
  return entries.join(",");
}

/** Sets requireSignedURLs on one video. Partial update per Stream's edit-video API. */
export async function setRequireSignedUrls(env: Env, uid: string, requireSigned: boolean): Promise<void> {
  if (!STREAM_UID.test(uid)) throw new Error("invalid Stream uid");
  const response = await fetch(streamApiUrl(env, `/${uid}`), {
    method: "POST",
    headers: { ...streamAuthHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ uid, requireSignedURLs: requireSigned }),
  });
  if (!response.ok) throw new Error(`Stream returned ${response.status}`);
}

export interface SigningSyncResult {
  updated: number;
  failed: number;
}

/**
 * Sets requireSignedURLs on every Stream video of an event (after its access
 * mode is saved). Idempotent; failures are logged and counted, not thrown.
 */
export async function syncStreamSigning(
  env: Env,
  eventId: string,
  requireSigned: boolean,
  depth = 0
): Promise<SigningSyncResult> {
  // Stream rows only. Each video costs one subrequest: very large events can
  // exceed the per-invocation limit; failures are counted and a later save retries.
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT media_url FROM moments WHERE event_id = ? AND media_url LIKE 'https://customer-%'"
  )
    .bind(eventId)
    .all<{ media_url: string }>();
  const uids = [...new Set(results.map((row) => streamUidOf(row.media_url)).filter((uid): uid is string => uid !== null))];
  const result: SigningSyncResult = { updated: 0, failed: 0 };
  // Small batches keep us well under the Workers subrequest limits.
  for (let start = 0; start < uids.length; start += 6) {
    const batch = uids.slice(start, start + 6);
    const outcomes = await Promise.allSettled(batch.map((uid) => setRequireSignedUrls(env, uid, requireSigned)));
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") result.updated += 1;
      else result.failed += 1;
    }
  }
  // A later save may have flipped the mode while we ran; follow the final state.
  const current = await env.DB.prepare("SELECT access_mode FROM events WHERE id = ?")
    .bind(eventId)
    .first<{ access_mode: string }>();
  // Depth-capped: an admin flipping the mode during every run cannot loop us.
  if (current && (current.access_mode === "private") !== requireSigned && depth < 2) {
    return syncStreamSigning(env, eventId, current.access_mode === "private", depth + 1);
  }
  const log = result.failed > 0 ? console.error : console.log;
  log(JSON.stringify({ event: "stream_signing_synced", eventId, requireSigned, total: uids.length, ...result }));
  return result;
}
