/**
 * Joining mints a guest (and a token), so joins that could mint one are
 * limited per event and IP. This slows guest minting; it does not by itself
 * stop one network from filling an event's open-upload cap (40 guests x 50
 * open uploads fit in one window): that needs a per-event guest or
 * per-source open-upload cap (follow-up).
 *
 * The limit is generous because a venue's Wi-Fi (or a carrier's NAT) puts
 * many real guests behind one address: 60 a minute per event.
 */
export const JOIN_RETRY_AFTER_SECONDS = 60;

export const JOIN_RATE_LIMITED = {
  error: "Too many people are joining from this network. Try again in a minute.",
  code: "rate_limited",
} as const;

/** True when this join should be refused. No limiter configured: never. */
export async function isJoinLimited(
  limiter: RateLimit | undefined,
  eventId: string,
  clientIp: string | undefined
): Promise<boolean> {
  if (!limiter) return false;
  // Cloudflare always sets the client IP; without it (local dev, odd
  // proxies) requests deliberately share one bucket per event.
  const { success } = await limiter.limit({ key: `${eventId}:ip:${clientIp ?? "unknown"}` });
  return !success;
}
