/**
 * The small JPEG the feed grid shows in place of the full file, made in the
 * page and sent before the upload's parts (see multipartUpload.ts).
 *
 * Always optional: every step returns null instead of failing, and the
 * upload goes ahead without one. Redrawing on a canvas keeps no metadata
 * (no GPS, no capture date). The server keeps only a whole JPEG of at most
 * MAX_THUMBNAIL_BYTES, so the result is checked against that here too.
 */

/** Longest side, as on iOS (a third of a phone screen at 3x). */
export const THUMBNAIL_MAX_PIXELS = 400;
/** The server's limit (`MAX_THUMBNAIL_BYTES` in worker/thumbnails.ts). */
export const MAX_THUMBNAIL_BYTES = 200 * 1024;
/** Tried in order until the JPEG fits. */
export const THUMBNAIL_QUALITIES = [0.75, 0.6, 0.45, 0.3] as const;
/** A video that can't give a frame by then gets no thumbnail. */
const VIDEO_FRAME_TIMEOUT_MS = 5000;
/** Each thumbnail request gives up after this, so complete never waits long. */
export const THUMBNAIL_REQUEST_TIMEOUT_MS = 15_000;

/** Fits width × height inside the longest-side limit; never upscales. */
export function thumbnailDimensions(
  width: number,
  height: number,
  maxPixels: number = THUMBNAIL_MAX_PIXELS
): { width: number; height: number } | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const scale = Math.min(1, maxPixels / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** True when the bytes are a whole JPEG: SOI marker at the start, EOI at the end. */
export function isWholeJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  // Same rule as the server (worker/thumbnails.ts).
  return n >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}

/**
 * Encodes at each quality until the JPEG fits; null if none does or the
 * encoder doesn't give a JPEG (a browser without JPEG output gives PNG).
 */
export async function encodeThumbnail(
  encode: (quality: number) => Promise<Blob | null>,
  maxBytes: number = MAX_THUMBNAIL_BYTES
): Promise<Blob | null> {
  for (const quality of THUMBNAIL_QUALITIES) {
    const blob = await encode(quality);
    if (!blob || blob.type !== "image/jpeg") return null;
    if (blob.size > maxBytes) continue;
    if (!isWholeJpeg(new Uint8Array(await blob.arrayBuffer()))) return null;
    return blob;
  }
  return null;
}

/** A thumbnail of a photo or a video's first frame; null if the browser can't. */
export async function makeThumbnail(file: File): Promise<Blob | null> {
  try {
    if (file.type.startsWith("image/")) return await fromImage(file);
    if (file.type.startsWith("video/")) return await fromVideo(file);
  } catch {
    // Unsupported format (some HEIC on Chrome), no canvas, a decoding error:
    // the moment just shows its file.
  }
  return null;
}

async function fromImage(file: File): Promise<Blob | null> {
  // Decoded straight at thumbnail scale: a 48 MP photo decoded whole is
  // ~190 MB, enough to kill a tab on a small phone. Width only keeps the
  // shape; draw() then fits the longest side. Browsers without resize
  // options decode whole.
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image", resizeWidth: THUMBNAIL_MAX_PIXELS, resizeQuality: "medium",
  }).catch(() => createImageBitmap(file, { imageOrientation: "from-image" }));
  try {
    return await draw(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function fromVideo(file: File): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame in time")), VIDEO_FRAME_TIMEOUT_MS);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error("video unreadable"));
      };
      // Seeking a hair past 0 makes Safari decode a frame it can draw.
      video.addEventListener("loadeddata", () => { video.currentTime = 0.1; }, { once: true });
      // Some Safari builds report the seek before the frame can be drawn.
      video.addEventListener("seeked", () => done(video.readyState >= 2), { once: true });
      video.addEventListener("error", () => done(false), { once: true });
      video.src = url;
    });
    return await draw(video, video.videoWidth, video.videoHeight);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function draw(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const size = thumbnailDimensions(width, height);
  if (!size || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // A transparent PNG would otherwise turn black in the JPEG.
  context.fillStyle = "#1a1a1a";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  try {
    return await encodeThumbnail((quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)));
  } finally {
    // Safari keeps a canvas's memory until it is sized down.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export interface ThumbnailTarget {
  slug: string;
  uploadId: string;
  key: string;
  /** The guest's token header, as for the upload's other calls. */
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Asks for the upload's thumbnail URL and PUTs the JPEG there. True when
 * storage took it. Never throws (an abort included): a thumbnail is never
 * worth failing or delaying the upload over. The URL is a bearer
 * credential and is never logged.
 */
export async function sendThumbnail(thumbnail: Blob, target: ThumbnailTarget): Promise<boolean> {
  // The caller's abort or our own timeout, whichever comes first (a timer,
  // not AbortSignal.any/timeout, which older Safari lacks).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMBNAIL_REQUEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  target.signal?.addEventListener("abort", cancel, { once: true });
  const signal = controller.signal;
  if (target.signal?.aborted) controller.abort();
  try {
    if (thumbnail.type !== "image/jpeg" || thumbnail.size <= 0 || thumbnail.size > MAX_THUMBNAIL_BYTES) return false;
    const response = await fetch(`/api/events/${encodeURIComponent(target.slug)}/moments/multipart/thumbnail-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...target.headers },
      body: JSON.stringify({ upload_id: target.uploadId, key: target.key, size: thumbnail.size }),
      signal,
    });
    if (!response.ok) return false;
    const { url } = (await response.json()) as { url?: unknown };
    if (typeof url !== "string" || !url.startsWith("https://")) return false;
    // Exactly the signed headers: Content-Type here, Content-Length from the body.
    const put = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: thumbnail,
      signal,
      credentials: "omit",
      redirect: "error",
    });
    return put.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    target.signal?.removeEventListener("abort", cancel);
  }
}
