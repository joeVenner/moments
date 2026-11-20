import { AccessRequiredError, EventNotHostedError, NotFoundError } from "./api";

/** What the slideshow does when a load fails. */
export type SlideshowLoadFailure = "access_required" | "not_found" | "transient";

/**
 * A private event this browser hasn't unlocked answers `access_required`:
 * the slideshow then asks for the PIN. Only a real "missing" answer (404, or
 * an event no longer hosted) ends it; anything else (offline, a 5xx, a
 * garbled body) is transient, so the screen keeps what it shows and the
 * next poll tries again.
 */
export function slideshowLoadFailure(error: unknown): SlideshowLoadFailure {
  if (error instanceof AccessRequiredError) return "access_required";
  if (error instanceof NotFoundError || error instanceof EventNotHostedError) return "not_found";
  return "transient";
}

/** What the slideshow shows while it has no moment to display. */
export type SlideshowEmptyState = "loading" | "retrying" | "waiting";

/**
 * Before the first successful load the screen can't claim the event is
 * empty: it is still loading, or retrying after a transient failure. Once a
 * load succeeded, an empty slideshow is waiting for its first moment (and a
 * later failed poll keeps that state).
 */
export function slideshowEmptyState(hasLoaded: boolean, lastLoadFailed: boolean): SlideshowEmptyState {
  if (hasLoaded) return "waiting";
  return lastLoadFailed ? "retrying" : "loading";
}
