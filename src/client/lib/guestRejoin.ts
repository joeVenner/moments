import type { JoinOutcome } from "./joinOutcome";

export interface RejoinDeps {
  getGuestToken: (slug: string) => string | null;
  join: (slug: string, nickname: string, avatarSeed: string) => Promise<JoinOutcome>;
  /** Whether this tab already tried (sessionStorage), so a reload loop can't hammer the server. */
  hasTried: (slug: string) => boolean;
  markTried: (slug: string) => void;
  clearTried: (slug: string) => void;
}

/**
 * A returning web guest with a saved nickname but no guest token (they joined
 * before tokens existed, or their join failed on the network) joins again in
 * the background, once per tab. If nobody owns the nickname yet, that claims
 * it for this device before guest tokens are enforced.
 *
 * Returns `nickname_taken` only when enforcement is on and another device owns
 * the name: the caller should then ask for a new nickname. Anything else needs
 * no action (null).
 */
export async function rejoinIfTokenless(
  slug: string,
  nickname: string,
  deps: RejoinDeps
): Promise<"nickname_taken" | null> {
  if (deps.getGuestToken(slug) || deps.hasTried(slug)) return null;
  // Marked before the request so a double mount sends one join, not two.
  deps.markTried(slug);
  // No avatar seed: an existing participant keeps its avatar.
  const outcome = await deps.join(slug, nickname, "").catch((): JoinOutcome => "unavailable");
  // An outage may be over by the next page load; a rate limit is left alone.
  if (outcome === "unavailable") deps.clearTried(slug);
  return outcome === "nickname_taken" ? "nickname_taken" : null;
}

const TRIED_KEY = (slug: string) => `moments:rejoin-tried:${slug}`;

/** sessionStorage-backed flags; storage errors (private mode) just mean "not tried". */
export const sessionRejoinFlags = {
  hasTried(slug: string): boolean {
    try {
      return sessionStorage.getItem(TRIED_KEY(slug)) === "1";
    } catch {
      return false;
    }
  },
  markTried(slug: string): void {
    try {
      sessionStorage.setItem(TRIED_KEY(slug), "1");
    } catch {
      // Storage blocked: at worst we try again on the next load.
    }
  },
  clearTried(slug: string): void {
    try {
      sessionStorage.removeItem(TRIED_KEY(slug));
    } catch {
      // Storage blocked: nothing was marked.
    }
  },
};
