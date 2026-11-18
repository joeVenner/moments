import type { EventData, MomentData } from "./types";
import { getAdminAuthHeader } from "./adminAuth";
import { getReactionId } from "./reactionId";
import { getGuestToken, guestTokenHeaders, setGuestToken } from "./nickname";
import { joinOutcome, type JoinOutcome } from "./joinOutcome";

export class UnauthorizedError extends Error {}
export class AccessRequiredError extends Error {}

async function asJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (res.status === 401) {
    if (body.access_required) throw new AccessRequiredError("Event access required");
    throw new UnauthorizedError(body.error || "Unauthorized");
  }
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

export function updateEventLifecycle(
  id: string,
  input: { expires_at?: string | null; archive_now?: boolean }
) {
  return fetch(`/api/admin/events/${encodeURIComponent(id)}/lifecycle`, {
    method: "PATCH",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((response) => asJson<{ event: EventData }>(response));
}

export function updateEventAccess(id: string, input: { mode: "public" | "private"; pin?: string }) {
  return fetch(`/api/admin/events/${encodeURIComponent(id)}/access`, {
    method: "PATCH",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((response) => asJson<{ event: EventData }>(response));
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

export function unlockEvent(slug: string, input: { pin?: string; invite_token?: string }) {
  return fetch(`/api/events/${encodeURIComponent(slug)}/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((response) => asJson<{ unlocked: true }>(response));
}

export function listMoments(
  slug: string,
  opts?: { limit?: number; offset?: number; uploaderName?: string }
) {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  if (opts?.uploaderName) params.set("uploader_name", opts.uploaderName);
  params.set("reactor_id", getReactionId());
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

export function listHighlights(slug: string) {
  const params = new URLSearchParams({ reactor_id: getReactionId() });
  return fetch(`/api/events/${encodeURIComponent(slug)}/highlights?${params}`).then((response) =>
    asJson<{ moments: MomentData[] }>(response)
  );
}

export function toggleMomentReaction(slug: string, momentId: string) {
  return fetch(`/api/events/${encodeURIComponent(slug)}/moments/${encodeURIComponent(momentId)}/reactions`, {
    method: "POST",
    // The guest token ties this device's hearts to the guest (see worker reactions.ts).
    headers: { "Content-Type": "application/json", ...guestTokenHeaders(slug) },
    body: JSON.stringify({ reactor_id: getReactionId() }),
  }).then((response) => asJson<{ reacted: boolean; reaction_count: number }>(response));
}

export function listAdminMoments(slug: string) {
  return fetch(`/api/admin/events/${encodeURIComponent(slug)}/moments`, {
    headers: adminHeaders(),
  }).then((response) => asJson<{ moments: MomentData[] }>(response));
}

export interface EventAnalyticsData {
  summary: {
    total_moments: number;
    hidden_moments: number;
    videos: number;
    photos: number;
    storage_bytes: number;
    participants: number;
    reactions: number;
  };
  activity: { day: string; count: number }[];
  upload_states: { status: string; count: number }[];
}

export function getEventAnalytics(slug: string) {
  return fetch(`/api/admin/events/${encodeURIComponent(slug)}/analytics`, {
    headers: adminHeaders(),
  }).then((response) => asJson<EventAnalyticsData>(response));
}

export function setMomentModeration(id: string, status: "approved" | "hidden") {
  return fetch(`/api/admin/moments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).then((response) => asJson<{ moment: MomentData }>(response));
}

export function deleteAdminMoment(id: string) {
  return fetch(`/api/admin/moments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  }).then((response) => asJson<{ deleted: true }>(response));
}

export function uploadMoment(slug: string, data: FormData) {
  return fetch(`/api/events/${slug}/moments`, { method: "POST", body: data, headers: guestTokenHeaders(slug) }).then((r) =>
    asJson<{ moment: MomentData; points_awarded: number }>(r)
  );
}

export function getUploadCapabilities() {
  return fetch("/api/upload-capabilities").then((response) =>
    asJson<{ stream_tus: boolean }>(response)
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

/** Joins the roster and keeps the guest token. Never throws; see `JoinOutcome`. */
export function joinEvent(slug: string, nickname: string, avatarSeed: string): Promise<JoinOutcome> {
  const data = new URLSearchParams({ nickname, avatar_seed: avatarSeed });
  const token = getGuestToken(slug);
  const headers: Record<string, string> = token ? { "X-Guest-Token": token } : {};
  return fetch(`/api/events/${slug}/participants`, { method: "POST", body: data, headers })
    .then(async (res): Promise<JoinOutcome> => {
      const parsed: unknown = await res.json().catch(() => null);
      const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { guest_token?: unknown; code?: unknown };
      const outcome = joinOutcome(res.status, body.code);
      if (outcome === "joined" && typeof body.guest_token === "string") setGuestToken(slug, body.guest_token);
      return outcome;
    })
    // A network failure must not keep the guest out of the feed.
    .catch((): JoinOutcome => "unavailable");
}
