import { describe, expect, it, vi } from "vitest";
import type { JoinOutcome } from "./joinOutcome";
import { rejoinIfTokenless, type RejoinDeps } from "./guestRejoin";

function deps(overrides: Partial<RejoinDeps> & { outcome?: JoinOutcome } = {}) {
  const tried = new Set<string>();
  const join = vi.fn(async () => overrides.outcome ?? ("joined" as JoinOutcome));
  return {
    join,
    deps: {
      getGuestToken: () => null,
      join,
      hasTried: (slug: string) => tried.has(slug),
      markTried: (slug: string) => void tried.add(slug),
      clearTried: (slug: string) => void tried.delete(slug),
      ...overrides,
    } satisfies RejoinDeps,
  };
}

describe("rejoinIfTokenless", () => {
  it("does nothing when the device already has a token", async () => {
    const { join, deps: d } = deps({ getGuestToken: () => "tok" });
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it("joins once per tab, without changing the avatar", async () => {
    const { join, deps: d } = deps();
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith("party", "Sara", "");
  });

  it("tries each event separately", async () => {
    const { join, deps: d } = deps();
    await rejoinIfTokenless("party", "Sara", d);
    await rejoinIfTokenless("other", "Sara", d);
    expect(join).toHaveBeenCalledTimes(2);
  });

  it("reports a nickname owned by another device", async () => {
    const { deps: d } = deps({ outcome: "nickname_taken" });
    expect(await rejoinIfTokenless("party", "Sara", d)).toBe("nickname_taken");
  });

  it("does not retry after a rate limit in the same tab", async () => {
    const { join, deps: d } = deps({ outcome: "rate_limited" });
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("retries on the next load after an outage", async () => {
    const { join, deps: d } = deps({ outcome: "unavailable" });
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(join).toHaveBeenCalledTimes(2);
  });

  it("treats a failing join as an outage instead of throwing", async () => {
    const { deps: d } = deps({ join: vi.fn(async () => { throw new TypeError("offline"); }) });
    expect(await rejoinIfTokenless("party", "Sara", d)).toBeNull();
    expect(d.hasTried("party")).toBe(false);
  });
});
