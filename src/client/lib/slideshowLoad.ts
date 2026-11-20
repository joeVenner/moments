import { AccessRequiredError } from "./api";

/** What the slideshow shows when loading fails. */
export type SlideshowLoadFailure = "access_required" | "not_found";

/**
 * A private event this browser hasn't unlocked answers `access_required`:
 * the slideshow then asks for the PIN rather than calling the event missing.
 * Anything else still reads as "not found".
 */
export function slideshowLoadFailure(error: unknown): SlideshowLoadFailure {
  return error instanceof AccessRequiredError ? "access_required" : "not_found";
}
