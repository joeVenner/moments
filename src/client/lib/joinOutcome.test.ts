import { describe, expect, it } from "vitest";
import { joinOutcome } from "./joinOutcome";

describe("joinOutcome", () => {
  it("continues on success", () => {
    expect(joinOutcome(200, undefined)).toBe("joined");
  });

  it("stops on a rate limit, whatever the body says", () => {
    expect(joinOutcome(429, "rate_limited")).toBe("rate_limited");
    expect(joinOutcome(429, undefined)).toBe("rate_limited");
  });

  it("stops when the nickname is taken", () => {
    expect(joinOutcome(409, "nickname_taken")).toBe("nickname_taken");
  });

  it("stops when the event is full", () => {
    expect(joinOutcome(409, "guest_cap_reached")).toBe("event_full");
  });

  it("treats anything else as unavailable", () => {
    expect(joinOutcome(409, "other")).toBe("unavailable");
    expect(joinOutcome(500, undefined)).toBe("unavailable");
    expect(joinOutcome(404, undefined)).toBe("unavailable");
    expect(joinOutcome(400, undefined)).toBe("unavailable");
  });
});

describe("joinOutcome edges", () => {
  it("accepts any 2xx and nothing else", () => {
    expect(joinOutcome(201, undefined)).toBe("joined");
    expect(joinOutcome(299, undefined)).toBe("joined");
    expect(joinOutcome(300, undefined)).toBe("unavailable");
    expect(joinOutcome(409, 7)).toBe("unavailable");
  });
});
