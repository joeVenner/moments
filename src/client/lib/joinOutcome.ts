/**
 * What the web join form does with the server's answer.
 * - `joined`: continue to the feed.
 * - `rate_limited` / `nickname_taken` / `event_full`: keep the form open and
 *   say why; the guest has no token yet (and a full event added nobody), so
 *   continuing would leave them unable to take part.
 * - `unavailable`: anything else (network, 5xx). Joining is still best-effort
 *   then, so the guest continues as before.
 */
export type JoinOutcome = "joined" | "rate_limited" | "nickname_taken" | "event_full" | "unavailable";

export function joinOutcome(status: number, code: unknown): JoinOutcome {
  if (status >= 200 && status < 300) return "joined";
  if (status === 429) return "rate_limited";
  if (status === 409 && code === "nickname_taken") return "nickname_taken";
  if (status === 409 && code === "guest_cap_reached") return "event_full";
  return "unavailable";
}
