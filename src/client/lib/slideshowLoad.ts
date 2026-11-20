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
