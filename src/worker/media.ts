/**
 * The `media` object native clients render from (iOS plan). Built purely from a
 * moment row, so it costs no extra queries. Optional fields are null until the
 * thumbnail pipeline (Phase 1) or the uploading client provides them; clients
 * then fall back to `url`.
 *
 * URL rules for clients:
 * - `/media/...` URLs are relative to the API origin; Stream URLs are absolute.
 * - R2 videos have no `hls_url`: play `url` directly (byte ranges supported).
 * - Stream `hls_url` / `poster_url` return 404 until Stream finishes
 *   processing; retry with backoff.
 * - Private-event Stream videos are not signed yet; treat them as unlisted,
 *   not confidential (fixed in the requireSignedURLs slice).
 */

export type MediaKind = "image" | "video";

export interface MomentMedia {
  kind: MediaKind;
  /** Original upload: a /media/ path (R2) or a Stream iframe URL. */
  url: string;
  /** ~400 px grid thumbnail. */
  thumb_url: string | null;
  /** ~1600 px viewer image. */
  display_url: string | null;
  /** Still frame for videos. */
  poster_url: string | null;
  /** HLS manifest for Stream videos (AVPlayer cannot play the iframe URL). */
  hls_url: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  blurhash: string | null;
}

export interface MediaSourceRow {
  media_url: string;
  mime_type: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  blurhash?: string | null;
  thumb_key?: string | null;
  display_key?: string | null;
  poster_key?: string | null;
}

const STREAM_IFRAME = /^https:\/\/(customer-[a-z0-9]+\.cloudflarestream\.com)\/([a-f0-9]{32})\/iframe$/;
const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|3gp)$/i;

/** Stream host and video uid for Stream-backed moments, otherwise null. */
export function parseStreamMediaUrl(mediaUrl: string): { host: string; uid: string } | null {
  const match = STREAM_IFRAME.exec(mediaUrl);
  return match ? { host: match[1], uid: match[2] } : null;
}

export function mediaKind(row: Pick<MediaSourceRow, "media_url" | "mime_type">): MediaKind {
  if (row.mime_type) return row.mime_type.startsWith("video/") ? "video" : "image";
  if (parseStreamMediaUrl(row.media_url) || VIDEO_EXTENSION.test(row.media_url)) return "video";
  return "image";
}

// Each segment after events/<id>/: safe characters only, never "." or "..".
const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

/**
 * Only well-formed keys under the moment's own event prefix are served, so the
 * /media gate (which derives the event from the key) always protects them.
 */
export function mediaKeyUrl(key: string | null | undefined, eventId: string): string | null {
  const prefix = `events/${eventId}/`;
  if (!key || !key.startsWith(prefix)) return null;
  const segments = key.slice(prefix.length).split("/");
  if (segments.length === 0 || !segments.every((segment) => SAFE_SEGMENT.test(segment))) return null;
  return `/media/${key}`;
}

/**
 * A web feed row with its grid thumbnail as `thumb_url` (null when it has
 * none) instead of the storage key. Additive: older web pages ignore it.
 */
export function withWebThumbnail<T extends { event_id: string; thumb_key?: string | null }>(
  row: T
): Omit<T, "thumb_key"> & { thumb_url: string | null } {
  const { thumb_key: thumbKey, ...rest } = row;
  return { ...rest, thumb_url: mediaKeyUrl(thumbKey, row.event_id) };
}

export function buildMomentMedia(row: MediaSourceRow & { event_id: string }): MomentMedia {
  const stream = parseStreamMediaUrl(row.media_url);
  const streamBase = stream ? `https://${stream.host}/${stream.uid}` : null;
  return {
    kind: mediaKind(row),
    url: row.media_url,
    thumb_url: mediaKeyUrl(row.thumb_key, row.event_id),
    display_url: mediaKeyUrl(row.display_key, row.event_id),
    poster_url: mediaKeyUrl(row.poster_key, row.event_id) ?? (streamBase ? `${streamBase}/thumbnails/thumbnail.jpg` : null),
    hls_url: streamBase ? `${streamBase}/manifest/video.m3u8` : null,
    width: row.width ?? null,
    height: row.height ?? null,
    duration_ms: row.duration_ms ?? null,
    blurhash: row.blurhash ?? null,
  };
}
