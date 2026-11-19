/**
 * The server's "join the event first" refusal (403, code `guest_required`):
 * the token this page sent is unknown (the guest left, or the event was
 * reset) or a token is needed. Requests that hit it raise this error and
 * announce it on the page, where EventPage sends the guest back to the gate.
 */
export class GuestRequiredError extends Error {
  constructor(
    readonly slug: string,
    /** The token the refused request carried, or null if it sent none. */
    readonly sentToken: string | null
  ) {
    super("join the event first");
    this.name = "GuestRequiredError";
  }
}

export const GUEST_REQUIRED_EVENT = "moments:guest-required";

export interface GuestRequiredDetail {
  slug: string;
  sentToken: string | null;
}

/** A well-formed refusal relayed by the upload service worker, or null. */
export function guestRequiredDetail(message: unknown): GuestRequiredDetail | null {
  const m = message as { type?: unknown; slug?: unknown; sentToken?: unknown } | null;
  if (m?.type !== GUEST_REQUIRED_EVENT || typeof m.slug !== "string") return null;
  if (m.sentToken !== null && typeof m.sentToken !== "string") return null;
  return { slug: m.slug, sentToken: m.sentToken };
}

/** Whether a response is the server's own guest_required refusal (not a proxy's 403). */
export function isGuestRequired(status: number, body: unknown): boolean {
  return status === 403 && (body as { code?: unknown } | null)?.code === "guest_required";
}

/** The event slug of an `/api/events/<slug>/...` URL. */
export function slugOfEventUrl(url: string): string {
  const match = /\/api\/events\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : "";
}

/** The `X-Guest-Token` a request carried. */
export function sentGuestToken(headers: HeadersInit | undefined): string | null {
  return new Headers(headers).get("X-Guest-Token");
}

/**
 * Tells the page (a window event EventPage listens to) and returns the error
 * to throw. In the upload service worker there is no window: the worker
 * relays the thrown error to open pages itself.
 */
export function announceGuestRequired(slug: string, headers: HeadersInit | undefined): GuestRequiredError {
  const error = new GuestRequiredError(slug, sentGuestToken(headers));
  if (typeof window !== "undefined" && typeof CustomEvent === "function") {
    const detail: GuestRequiredDetail = { slug, sentToken: error.sentToken };
    window.dispatchEvent(new CustomEvent(GUEST_REQUIRED_EVENT, { detail }));
  }
  return error;
}

/**
 * What a refusal means for this page:
 * - "forget": it refused the token stored now: drop the guest and show the gate;
 * - "gate": the token was already cleared (the guest left from another tab):
 *   just show the gate, nothing left to drop;
 * - "ignore": another tab has since joined again with a newer token, which
 *   must survive; the refused request simply failed.
 */
export function refusalAction(detail: GuestRequiredDetail, currentToken: string | null): "forget" | "gate" | "ignore" {
  if (detail.sentToken === currentToken) return "forget";
  return currentToken === null ? "gate" : "ignore";
}
