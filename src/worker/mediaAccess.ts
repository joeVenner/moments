import { timingSafeEqual } from "./eventAccess";

/**
 * Access rules for /media objects beyond the private-event gate:
 * - objects belonging to a hidden moment are not served to guests;
 * - admins view them (and private-event media) through short-lived signed
 *   `?mv=` URLs that the admin moment responses carry, because <img>/<video>
 *   loads cannot send the admin Authorization header.
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
