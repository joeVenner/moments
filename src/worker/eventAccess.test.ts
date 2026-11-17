import { describe, expect, it } from "vitest";
import {
  EVENT_PIN_FAILURE_BLOCK_THRESHOLD,
  EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD,
  LEGACY_RAW_TOKEN_ACCEPTED_UNTIL,
  MAX_PIN_FAILURES_PER_CLIENT,
  accessCookieName,
  clientIpKey,
  decidePinAttempt,
  hashClientIp,
  hashEventPin,
  signAccessGrant,
  verifyAccessGrant,
} from "./eventAccess";

const SECRET = "test-access-secret-123";
const NOW = 1_800_000_000;
const CLAIMS = { eventId: "event-1", accessVersion: 3, expiresAt: NOW + 60 };

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

describe("signed access grants", () => {
  it("round-trips valid claims", async () => {
    const token = await signAccessGrant(SECRET, CLAIMS);
    expect(await verifyAccessGrant(SECRET, token, NOW)).toEqual(CLAIMS);
  });

  it("rejects a grant signed with another secret", async () => {
    const token = await signAccessGrant("other-secret", CLAIMS);
    expect(await verifyAccessGrant(SECRET, token, NOW)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signAccessGrant(SECRET, CLAIMS);
    const [, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ e: "event-1", v: 99, x: NOW + 60 })).replace(/=+$/, "");
    expect(await verifyAccessGrant(SECRET, `${forged}.${signature}`, NOW)).toBeNull();
  });

  it("rejects an expired grant", async () => {
    const token = await signAccessGrant(SECRET, CLAIMS);
    expect(await verifyAccessGrant(SECRET, token, CLAIMS.expiresAt)).toBeNull();
  });

  it.each(["", "no-dot", "a.b.c", "!!!.???", "e30.e30"])("rejects malformed token %j", async (token) => {
    expect(await verifyAccessGrant(SECRET, token, NOW)).toBeNull();
  });
});

describe("PIN attempt throttling", () => {
  it("allows normal traffic", () => {
    expect(decidePinAttempt(0, 0)).toBe("allow");
    expect(decidePinAttempt(MAX_PIN_FAILURES_PER_CLIENT - 1, EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD - 1)).toBe("allow");
  });

  it("blocks a client at the per-client limit", () => {
    expect(decidePinAttempt(MAX_PIN_FAILURES_PER_CLIENT, 0)).toBe("block");
  });

  it("slows first, then blocks, when the whole event is under attack", () => {
    expect(decidePinAttempt(0, EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD)).toBe("slow");
    expect(decidePinAttempt(0, EVENT_PIN_FAILURE_BLOCK_THRESHOLD - 1)).toBe("slow");
    expect(decidePinAttempt(0, EVENT_PIN_FAILURE_BLOCK_THRESHOLD)).toBe("block");
  });

  it("groups IPv6 clients by /64 and leaves IPv4 alone", () => {
    expect(clientIpKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientIpKey("2001:db8:aa:1::1")).toBe("2001:db8:aa:1::/64");
    expect(clientIpKey("2001:0db8:00aa:0001:ffff:1:2:3")).toBe("2001:db8:aa:1::/64");
    expect(clientIpKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("sunsets the legacy raw-token path", () => {
    expect(LEGACY_RAW_TOKEN_ACCEPTED_UNTIL).toBeGreaterThan(Date.UTC(2026, 10, 16) / 1000);
  });

  it("hashes client IPs without exposing them", async () => {
    const hashed = await hashClientIp(SECRET, "203.0.113.7");
    expect(hashed).toBe(await hashClientIp(SECRET, "203.0.113.7"));
    expect(hashed).not.toContain("203");
    expect(hashed).toHaveLength(32);
    expect(await hashClientIp("other", "203.0.113.7")).not.toBe(hashed);
  });
});
