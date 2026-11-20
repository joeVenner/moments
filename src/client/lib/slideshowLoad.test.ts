import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessRequiredError, EventNotHostedError, NotFoundError, getEvent } from "./api";
import { slideshowLoadFailure } from "./slideshowLoad";

describe("slideshowLoadFailure", () => {
  it("asks for the PIN when the event needs access", () => {
    expect(slideshowLoadFailure(new AccessRequiredError("Event access required"))).toBe("access_required");
  });

  it("ends only on a real missing or no-longer-hosted event", () => {
    expect(slideshowLoadFailure(new NotFoundError("event not found"))).toBe("not_found");
    expect(slideshowLoadFailure(new EventNotHostedError("gone"))).toBe("not_found");
  });

  it("treats network trouble, server errors and bad bodies as transient", () => {
    expect(slideshowLoadFailure(new TypeError("Failed to fetch"))).toBe("transient");
    expect(slideshowLoadFailure(new Error("request failed"))).toBe("transient");
    expect(slideshowLoadFailure(new SyntaxError("Unexpected token <"))).toBe("transient");
    expect(slideshowLoadFailure("boom")).toBe("transient");
  });
});

describe("getEvent errors", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("tells a missing event from a server error", async () => {
    answer(404, { error: "Event not found" });
    await expect(getEvent("party")).rejects.toBeInstanceOf(NotFoundError);
    answer(500, { error: "boom" });
    const failure = await getEvent("party").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NotFoundError);
    expect(slideshowLoadFailure(failure)).toBe("transient");
  });

  it("reads a non-JSON 404 as missing, and keeps polling on a plain 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Not Found</html>", { status: 404 })));
    await expect(getEvent("party")).rejects.toBeInstanceOf(NotFoundError);
    answer(401, { error: "Unauthorized" });
    const failure = await getEvent("party").catch((error: unknown) => error);
    expect(slideshowLoadFailure(failure)).toBe("transient");
  });

  it("still rejects a garbled success body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(getEvent("party")).rejects.toBeInstanceOf(SyntaxError);
  });
});
