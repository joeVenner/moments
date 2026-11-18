import type { Env } from "./types";
import { isStreamConfigured, streamApiUrl, streamAuthHeaders } from "./stream";

export async function deleteMomentMedia(env: Env, mediaUrl: string): Promise<void> {
  if (mediaUrl.startsWith("/media/")) {
    await env.BUCKET.delete(mediaUrl.slice("/media/".length));
    return;
  }

  if (!isStreamConfigured(env) || !mediaUrl.includes("cloudflarestream.com/")) return;
  const uid = new URL(mediaUrl).pathname.split("/").filter(Boolean)[0];
  if (!uid) return;
  await deleteStreamVideo(env, uid);
}

/** Deletes a Stream video; one already gone counts as deleted. A no-op without Stream. */
export async function deleteStreamVideo(env: Env, uid: string): Promise<void> {
  if (!isStreamConfigured(env)) return;
  const response = await fetch(streamApiUrl(env, `/${encodeURIComponent(uid)}`), {
    method: "DELETE",
    headers: streamAuthHeaders(env),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`unable to delete Stream video (${response.status})`);
  }
}
