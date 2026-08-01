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
  const response = await fetch(streamApiUrl(env, `/${encodeURIComponent(uid)}`), {
    method: "DELETE",
    headers: streamAuthHeaders(env),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`unable to delete Stream video (${response.status})`);
  }
}
