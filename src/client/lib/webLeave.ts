import { clearGuestToken, clearNickname, guestTokenHeaders } from "./nickname";
import { deleteUpload, listUploads } from "./uploadStore";

/** How a leave ended; on anything but "left" the guest keeps their identity and can retry. */
export type LeaveOutcome = "left" | "rate_limited" | "failed";

/**
 * Calls before giving up. The server does a bounded batch per call (a few
 * hundred moments at most per guest), so this covers any real guest; a
 * guest beyond it simply taps again.
 */
export const MAX_LEAVE_CALLS = 30;

export interface LeaveDeps {
  /** One `POST /api/events/:slug/leave` with the guest's token. */
  post(slug: string): Promise<Response>;
  /** Drops everything this browser keeps for the event's guest. */
  forget(slug: string): Promise<void>;
}

/**
 * "Leave and delete what I shared": repeats the server's resumable leave
 * until it is done, then forgets the guest here. Local data is kept on any
 * failure, so the token still works for a retry.
 */
export async function leaveEvent(slug: string, deps: LeaveDeps = browserLeaveDeps): Promise<LeaveOutcome> {
  for (let call = 0; call < MAX_LEAVE_CALLS; call += 1) {
    let res: Response;
    try {
      res = await deps.post(slug);
    } catch {
      return "failed";
    }
    const body = (await res.json().catch(() => null)) as { done?: unknown; code?: unknown } | null;
    // The server's own refusal of the token: it was revoked by a call whose
    // response got lost, so the leave already finished. Any other 403 (a
    // proxy, a firewall) proves nothing and must not wipe the guest here.
    if (res.status === 403 && body?.code === "guest_required") break;
    if (res.status === 429) return "rate_limited";
    if (!res.ok) return "failed";
    if (body?.done === true) break;
    // Anything but an explicit "not yet" (an HTML page from a portal, say) stops here.
    if (body?.done !== false || call === MAX_LEAVE_CALLS - 1) return "failed";
  }
  await deps.forget(slug);
  return "left";
}

/**
 * Removes the event's saved uploads (IndexedDB rows and their staged files)
 * and the guest's nickname and token. The server has already cancelled those
 * uploads; a service-worker run still holding one gets a 404 and stops.
 * Identity is cleared even if browser storage fails, so the page can't keep
 * acting as a guest who no longer exists.
 */
export async function forgetGuest(slug: string): Promise<void> {
  try {
    const uploads = await listUploads(slug);
    // One failing delete must not keep the others.
    const results = await Promise.allSettled(uploads.map((upload) => deleteUpload(upload.id)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) warn("Could not delete every saved upload after leaving", failed.reason);
  } catch (error) {
    warn("Could not read saved uploads after leaving", error);
  } finally {
    forgetTusResumes(slug);
    clearGuestToken(slug);
    clearNickname(slug);
  }
}

/**
 * tus-js-client keeps resume entries (`tus::<fingerprint>::<n>`) in
 * localStorage; the fingerprint holds the file name and this event's
 * endpoint, so the event's entries go with the guest.
 */
function forgetTusResumes(slug: string): void {
  const endpoint = `/api/events/${encodeURIComponent(slug)}/`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith("tus::") && key.includes(endpoint)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage blocked: tus couldn't have saved anything either.
  }
}

/** Error name only: messages can echo file names. */
function warn(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.name : "unknown");
}

const browserLeaveDeps: LeaveDeps = {
  post: (slug) =>
    fetch(`/api/events/${encodeURIComponent(slug)}/leave`, { method: "POST", headers: guestTokenHeaders(slug) }),
  forget: forgetGuest,
};
