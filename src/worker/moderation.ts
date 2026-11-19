import type { Env } from "./types";
import { isStreamConfigured, streamApiUrl, streamAuthHeaders } from "./stream";

/** A moment's stored files: its media plus any derived images. */
export interface MomentMedia {
  media_url: string;
  thumb_key?: string | null;
  display_key?: string | null;
  poster_key?: string | null;
}

/** Deletes a moment's media and every derived image (thumbnail, display, poster). */
export async function deleteMomentMedia(env: Env, moment: MomentMedia): Promise<void> {
  const derived = [moment.thumb_key, moment.display_key, moment.poster_key].filter((key): key is string => !!key);
  if (derived.length > 0) await env.BUCKET.delete(derived);
  const mediaUrl = moment.media_url;
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
