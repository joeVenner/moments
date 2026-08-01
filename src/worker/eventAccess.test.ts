import { describe, expect, it } from "vitest";
import { accessCookieName, hashEventPin } from "./eventAccess";

describe("event access", () => {
  it("hashes PINs deterministically per salt", async () => {
    const first = await hashEventPin("4829", "salt-a");
    expect(first).toBe(await hashEventPin("4829", "salt-a"));
    expect(first).not.toBe(await hashEventPin("4829", "salt-b"));
  });

  it("creates a cookie-safe event-specific name", () => {
    expect(accessCookieName("abc-123")).toBe("moments_access_abc123");
  });
});
