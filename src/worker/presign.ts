import type { Env } from "./types";

/**
 * Shared R2-direct-upload primitives used by the resumable multipart path
 * (multipartPresign.ts + the /moments/multipart/* routes). The original
 * single-PUT presign helper (`presignPutUrl`) and its `/presign` + `/register`
 * routes were removed once multipart superseded them — kept here are only the
 * constants + validation gates the multipart flow still depends on.
 */

/** Ceiling for large direct-to-R2 uploads. Mirrored on the client
 *  (`lib/api.ts` DIRECT_UPLOAD_MAX_BYTES) so an over-cap file is rejected up
 *  front with a clear message instead of starting and failing generically. */
export const MAX_DIRECT_UPLOAD_BYTES = 512 * 1024 * 1024; // 512MB

/** Presigned UploadPart URL lifetime — long enough for one chunk on slow mobile. */
export const PRESIGN_EXPIRY_SECONDS = 600; // 10 minutes

/** Whether the R2 S3 credentials needed for presigning are all configured. */
export function isR2Configured(env: Env): boolean {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_S3_ENDPOINT);
}

/**
 * Security gate for upload registration. The client tells us which R2 object key
 * it just PUT to, so before trusting that key we must confirm it lives under THIS
 * event's moments prefix — otherwise a caller could register an object from
 * another event, or an arbitrary key. The presign endpoint only ever issues keys
 * of exactly this shape (`events/<id>/moments/<uuid>-<name>`).
 */
export function registrationKeyBelongsToEvent(eventId: string, key: string): boolean {
  const prefix = `events/${eventId}/moments/`;
  return key.startsWith(prefix) && key.length > prefix.length && !key.includes("..");
}