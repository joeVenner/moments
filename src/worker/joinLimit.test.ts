import { describe, expect, it, vi } from "vitest";
import { isJoinLimited } from "./joinLimit";

describe("isJoinLimited", () => {
  it("never limits without a limiter", async () => {
    expect(await isJoinLimited(undefined, "ev1", "1.2.3.4")).toBe(false);
  });

  it("keys by event and IP and follows the limiter", async () => {
    const limit = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const limiter = { limit } as unknown as RateLimit;
    expect(await isJoinLimited(limiter, "ev1", "1.2.3.4")).toBe(false);
    expect(await isJoinLimited(limiter, "ev1", undefined)).toBe(true);
    expect(limit.mock.calls.map(([arg]) => arg.key)).toEqual(["ev1:ip:1.2.3.4", "ev1:ip:unknown"]);
  });
});
