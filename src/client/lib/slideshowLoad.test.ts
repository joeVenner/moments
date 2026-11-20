import { describe, expect, it } from "vitest";
import { AccessRequiredError, EventNotHostedError } from "./api";
import { slideshowLoadFailure } from "./slideshowLoad";

describe("slideshowLoadFailure", () => {
  it("asks for the PIN when the event needs access", () => {
    expect(slideshowLoadFailure(new AccessRequiredError("Event access required"))).toBe("access_required");
  });

  it("calls anything else not found", () => {
    expect(slideshowLoadFailure(new Error("event not found"))).toBe("not_found");
    expect(slideshowLoadFailure(new EventNotHostedError("gone"))).toBe("not_found");
    expect(slideshowLoadFailure("boom")).toBe("not_found");
  });
});
