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

export function listMoments(
  slug: string,
  opts?: { limit?: number; offset?: number; uploaderName?: string }
) {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  if (opts?.uploaderName) params.set("uploader_name", opts.uploaderName);
  const qs = params.toString();
  return fetch(`/api/events/${slug}/moments${qs ? `?${qs}` : ""}`).then((r) =>
    asJson<{
      moments: MomentData[];
      hasMore: boolean;
      total: number;
      your_points: number;
    }>(r)
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

// NOTE: large (>25MB) uploads no longer use a single presigned PUT — they go
// through the resumable S3 multipart path in `lib/multipartUpload.ts` (8 MiB
// parts, resume from R2 ListParts). The old `directUploadMoment` / `putToR2`
// helpers and the worker `/presign` + `/register` routes were removed with it.

export function joinEvent(slug: string, nickname: string, avatarSeed: string) {
  const data = new URLSearchParams({ nickname, avatar_seed: avatarSeed });
  return fetch(`/api/events/${slug}/participants`, { method: "POST", body: data }).catch(() => {
    // Joining the participant roster is a nice-to-have for the leaderboard/avatar
    // strip — never block the guest from reaching the feed if this fails.
  });
}
