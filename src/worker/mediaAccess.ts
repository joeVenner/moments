import { timingSafeEqual } from "./eventAccess";
import type { MomentMedia } from "./media";

/**
 * Access rules for /media objects beyond the private-event gate:
 * - objects belonging to a hidden moment are not served to guests;
 * - admins view them (and private-event media) through short-lived signed
 *   `?mv=` URLs that the admin moment responses carry, because <img>/<video>
 *   loads cannot send the admin Authorization header;
 * - native guests of a private event load media through signed `?at=` URLs
 *   that v1 feed responses carry, because AVPlayer and image loaders cannot
 *   send `X-Event-Access`. Each is bound to one key and the event's
 *   access_version, so a PIN change revokes them; hidden moments stay hidden.
 */

export const MEDIA_VIEW_PARAM = "mv";
const VIEW_BUCKET_SECONDS = 60 * 60;

/** Expiry shared within an hour so admin URLs stay cacheable: 1-2 h validity. */
export function mediaViewExpiry(nowSeconds: number): number {
  return Math.ceil((nowSeconds + 1) / VIEW_BUCKET_SECONDS) * VIEW_BUCKET_SECONDS + VIEW_BUCKET_SECONDS;
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function hmac(secret: string | CryptoKey, message: string): Promise<string> {
  const key = typeof secret === "string" ? await importHmacKey(secret) : secret;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Domain-separated from access grants, which use the same secret.
const viewMessage = (key: string, exp: number) => `media-view:v1:${exp}:${key}`;

/** `<exp>.<signature>` granting a view of exactly this R2 key until `exp`. */
export async function signMediaView(secret: string | CryptoKey, key: string, nowSeconds: number): Promise<string> {
  const exp = mediaViewExpiry(nowSeconds);
  return `${exp}.${await hmac(secret, viewMessage(key, exp))}`;
}

export async function verifyMediaView(
  secret: string,
  key: string,
  token: string | undefined,
  nowSeconds: number
): Promise<boolean> {
  const match = token ? /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token) : null;
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp <= nowSeconds || exp > nowSeconds + 2 * VIEW_BUCKET_SECONDS) return false;
  return timingSafeEqual(match[2], await hmac(secret, viewMessage(key, exp)));
}

/**
 * Adds `?mv=` to R2 media URLs so the admin dashboard can load hidden and
 * private-event moments. Without EVENT_ACCESS_SECRET, URLs are left as-is.
 */
export async function withAdminViewUrls<T extends { media_url: string }>(
  secret: string | undefined,
  moments: readonly T[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<T[]> {
  if (!secret) return [...moments];
  const hmacKey = await importHmacKey(secret);
  return Promise.all(
    moments.map(async (moment) => {
      if (!moment.media_url.startsWith("/media/") || moment.media_url.includes("?")) return moment;
      const key = moment.media_url.slice("/media/".length);
      const token = await signMediaView(hmacKey, key, nowSeconds);
      return { ...moment, media_url: `${moment.media_url}?${MEDIA_VIEW_PARAM}=${token}` };
    })
  );
}

/** True when `key` is the original or a derived object of a hidden moment. */
export async function isHiddenMomentMedia(db: D1Database, key: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM moments
        WHERE moderation_status = 'hidden'
          AND (media_url = ? OR thumb_key = ? OR display_key = ? OR poster_key = ?)
        LIMIT 1`
    )
    .bind(`/media/${key}`, key, key, key)
    .first();
  return row !== null;
}

export const MEDIA_GRANT_PARAM = "at";
const GRANT_BUCKET_SECONDS = 6 * 60 * 60;

/** Expiry shared within six hours so URLs stay cacheable: 6-12 h validity. */
export function mediaGrantExpiry(nowSeconds: number): number {
  return Math.ceil((nowSeconds + 1) / GRANT_BUCKET_SECONDS) * GRANT_BUCKET_SECONDS + GRANT_BUCKET_SECONDS;
}

// Domain-separated from admin views and access grants (same secret).
const grantMessage = (key: string, accessVersion: number, exp: number) =>
  `media-grant:v1:${exp}:${accessVersion}:${key}`;

/** `<exp>.<signature>` letting a guest load exactly this R2 key until `exp`. */
export async function signMediaGrant(
  secret: string | CryptoKey,
  key: string,
  accessVersion: number,
  nowSeconds: number
): Promise<string> {
  const exp = mediaGrantExpiry(nowSeconds);
  return `${exp}.${await hmac(secret, grantMessage(key, accessVersion, exp))}`;
}

export async function verifyMediaGrant(
  secret: string,
  key: string,
  accessVersion: number,
  token: string | undefined,
  nowSeconds: number
): Promise<boolean> {
  const match = token ? /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token) : null;
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp <= nowSeconds || exp > nowSeconds + 2 * GRANT_BUCKET_SECONDS) return false;
  return timingSafeEqual(match[2], await hmac(secret, grantMessage(key, accessVersion, exp)));
}

type GrantableMoment = { media_url: string; media?: MomentMedia };
type GrantableEvent = { access_mode: string; access_version: number };

/**
 * Signs one `/media/` URL for a private event's guests. Other URLs (Stream,
 * absolute, or already carrying a query: none are emitted today) are returned
 * unchanged.
 */
async function signGuestUrl(key: string | CryptoKey, event: GrantableEvent, url: string, nowSeconds: number): Promise<string> {
  if (!url.startsWith("/media/") || url.includes("?")) return url;
  const token = await signMediaGrant(key, url.slice("/media/".length), event.access_version, nowSeconds);
  return `${url}?${MEDIA_GRANT_PARAM}=${token}`;
}

/** `withGuestMediaGrants` for a single URL, such as the event cover. */
export async function withGuestMediaGrant(
  secret: string | undefined,
  event: GrantableEvent,
  url: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string | null> {
  if (!secret || event.access_mode !== "private" || url === null) return url;
  return signGuestUrl(secret, event, url, nowSeconds);
}

/**
 * For a private event, adds `?at=` to every R2 URL of each moment (the
 * original, thumb, display and poster). Call only for requests that already
 * passed the event's access check. Public events, Stream URLs and a missing
 * secret leave URLs as they are.
 */
export async function withGuestMediaGrants<T extends GrantableMoment>(
  secret: string | undefined,
  event: GrantableEvent,
  moments: readonly T[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<T[]> {
  if (!secret || event.access_mode !== "private") return [...moments];
  const hmacKey = await importHmacKey(secret);
  const sign = (url: string) => signGuestUrl(hmacKey, event, url, nowSeconds);
  const signOptional = async (url: string | null) => (url === null ? null : sign(url));
  return Promise.all(
    moments.map(async (moment) => {
      const mediaUrl = await sign(moment.media_url);
      if (!moment.media) return { ...moment, media_url: mediaUrl };
      const [url, thumb, display, poster] = await Promise.all([
        sign(moment.media.url),
        signOptional(moment.media.thumb_url),
        signOptional(moment.media.display_url),
        signOptional(moment.media.poster_url),
      ]);
      return { ...moment, media_url: mediaUrl, media: { ...moment.media, url, thumb_url: thumb, display_url: display, poster_url: poster } };
    })
  );
}
