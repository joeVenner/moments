/**
 * What the web join form does with the server's answer.
 * - `joined`: continue to the feed.
 * - `rate_limited` / `nickname_taken`: keep the form open and say why; the
 *   guest has no token yet, so continuing would leave them unable to upload
 *   once guest tokens are enforced.
 * - `unavailable`: anything else (network, 5xx). Joining is still best-effort
 *   then, so the guest continues as before.
 */
export type JoinOutcome = "joined" | "rate_limited" | "nickname_taken" | "unavailable";

export function joinOutcome(status: number, code: unknown): JoinOutcome {
  if (status >= 200 && status < 300) return "joined";
  if (status === 429) return "rate_limited";
  if (status === 409 && code === "nickname_taken") return "nickname_taken";
  return "unavailable";
}
