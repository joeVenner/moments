import type { EventData, MomentData } from "./types";
import { getAdminAuthHeader } from "./adminAuth";

export class UnauthorizedError extends Error {}

async function asJson<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new UnauthorizedError("Unauthorized");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "request failed");
  return body as T;
}

function adminHeaders(): HeadersInit {
  const auth = getAdminAuthHeader();
  return auth ? { Authorization: auth } : {};
}

export function listEvents() {
  return fetch("/api/events", { headers: adminHeaders() }).then((r) =>
    asJson<{ events: EventData[] }>(r)
  );
}

export function createEvent(data: FormData) {
  return fetch("/api/events", { method: "POST", headers: adminHeaders(), body: data }).then((r) =>
    asJson<{ event: EventData }>(r)
  );
}

export function generateBanner(data: FormData) {
  return fetch("/api/admin/generate-banner", {
    method: "POST",
    headers: adminHeaders(),
    body: data,
  }).then((r) => asJson<{ banner_url: string }>(r));
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const res = await fetch("/api/events", {
    headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
  });
  return res.ok;
}

export function getEvent(slug: string) {
  return fetch(`/api/events/${slug}`).then((r) => asJson<{ event: EventData }>(r));
}

export function listMoments(slug: string, opts?: { limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return fetch(`/api/events/${slug}/moments${qs ? `?${qs}` : ""}`).then((r) =>
    asJson<{ moments: MomentData[]; hasMore: boolean }>(r)
  );
}

export function uploadMoment(slug: string, data: FormData) {
  return fetch(`/api/events/${slug}/moments`, { method: "POST", body: data }).then((r) =>
    asJson<{ moment: MomentData; points_awarded: number }>(r)
  );
}

/**
 * Files at or below this go through the native multipart route (`uploadMoment`);
 * larger ones bypass the Worker's request-body limit via `directUploadMoment`.
 * Mirrors the Worker's native cap (`storage.ts` MAX_UPLOAD_BYTES, 25MB).
 */
export const NATIVE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Hard ceiling for the presigned direct-to-R2 path. Mirrors the Worker's
 * `presign.ts` MAX_DIRECT_UPLOAD_BYTES — files above this are rejected at
 * presign with a 400, so we surface a clear message up front instead of
 * letting the upload start and fail with a generic error (common on mobile,
 * where cameras produce large videos).
 */
export const DIRECT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

/** PUTs the raw file straight to R2 via XHR so upload progress is observable. */
function putToR2(url: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // Unsigned header (presign signs host only) — R2 records it so register()'s
    // head() check sees the real content-type instead of application/octet-stream.
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

/**
 * Large-upload path (P3.1): ask the Worker for a presigned PUT URL, send the bytes
 * straight to R2 (the Worker never touches them), then register the object so it can
 * head()-validate size/type and write the moment row. `onProgress` feeds the upload
 * progress ring (P-A11). Throws if R2 isn't configured (presign returns 501).
 */
export async function directUploadMoment(
  slug: string,
  file: File,
  caption: string,
  uploaderName: string,
  onProgress?: (fraction: number) => void
) {
  const { upload_url, key } = await fetch(`/api/events/${slug}/moments/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uploader_name: uploaderName,
      content_type: file.type,
      size: file.size,
      filename: file.name,
    }),
  }).then((r) => asJson<{ upload_url: string; key: string }>(r));

  await putToR2(upload_url, file, onProgress);

  return fetch(`/api/events/${slug}/moments/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploader_name: uploaderName, key, caption: caption || null }),
  }).then((r) => asJson<{ moment: MomentData; points_awarded: number }>(r));
}

export function joinEvent(slug: string, nickname: string, avatarSeed: string) {
  const data = new URLSearchParams({ nickname, avatar_seed: avatarSeed });
  return fetch(`/api/events/${slug}/participants`, { method: "POST", body: data }).catch(() => {
    // Joining the participant roster is a nice-to-have for the leaderboard/avatar
    // strip — never block the guest from reaching the feed if this fails.
  });
}
