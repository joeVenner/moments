import type { Env } from "./types";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — images + short clips only, not long-form video

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

export async function putMedia(
  env: Env,
  folder: string,
  file: File
): Promise<{ key: string; url: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File too large (max 25MB)");
  }
  const key = `${folder}/${crypto.randomUUID()}-${sanitizeFilename(file.name || "upload")}`;
  await env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  return { key, url: `/media/${key}` };
}
