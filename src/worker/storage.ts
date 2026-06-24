import type { Env } from "./types";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — images + short clips only, not long-form video

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase());
}

export async function putMedia(
  env: Env,
  folder: string,
  file: File
): Promise<{ key: string; url: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File too large (max 25MB)");
  }
  if (!isAllowedContentType(file.type)) {
    throw new Error("Unsupported file type");
  }
  const key = `${folder}/${crypto.randomUUID()}-${sanitizeFilename(file.name || "upload")}`;
  // Pass the Blob straight through so R2 can stream it instead of buffering
  // the whole upload in Worker memory first.
  await env.BUCKET.put(key, file, {
    httpMetadata: { contentType: file.type },
  });
  return { key, url: `/media/${key}` };
}
