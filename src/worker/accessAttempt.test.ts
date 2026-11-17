import { beforeEach, describe, expect, it, vi } from "vitest";
import { attemptEventAccess, type AccessAttemptEvent } from "./accessAttempt";
import {
  EVENT_PIN_FAILURE_BLOCK_THRESHOLD,
  EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD,
  hashClientIp,
  hashEventPin,
  MAX_PIN_FAILURES_PER_CLIENT,
  PIN_SLOWDOWN_MS,
} from "./eventAccess";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

const SECRET = "test-access-secret-123";
const PIN = "482916";
let sqlite: SqliteD1;
let event: AccessAttemptEvent;

beforeEach(async () => {
  sqlite = createSqliteD1();
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, access_mode, access_version) VALUES ('e1', 'secret', 'S', 'Party', 'private', 1)")
    .run();
  event = {
    id: "e1",
    access_mode: "private",
    invite_token: "a".repeat(64),
    access_pin_hash: await hashEventPin(PIN, "salt"),
    access_pin_salt: "salt",
  };
});

const failures = () => (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM access_failures").get() as { n: number }).n;

async function seedFailures(count: number, ip: string) {
  const ipHash = await hashClientIp(SECRET, ip);
  const insert = sqlite.raw.prepare("INSERT INTO access_failures (id, event_id, ip_hash) VALUES (?, 'e1', ?)");
  for (let i = 0; i < count; i++) insert.run(crypto.randomUUID(), ipHash);
}

const attempt = (pin: string, clientIp = "203.0.113.7", sleep = vi.fn(async () => {})) =>
  attemptEventAccess(sqlite.db, SECRET, event, { pin, inviteToken: "", clientIp }, sleep);

describe("attemptEventAccess", () => {
  it("leaves earlier failures in place when the right PIN succeeds", async () => {
    await attempt("000000");
    await attempt("111111");
    expect(await attempt(PIN)).toEqual({ kind: "granted" });
    expect(failures()).toBe(2);
  });

  it("slows down, but still answers, once the event sees many failures", async () => {
    await seedFailures(EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD, "198.51.100.1");
    const sleep = vi.fn(async () => {});
    expect(await attempt(PIN, "203.0.113.7", sleep)).toEqual({ kind: "granted" });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(PIN_SLOWDOWN_MS);
    const wrongSleep = vi.fn(async () => {});
    expect(await attempt("000000", "203.0.113.7", wrongSleep)).toEqual({ kind: "invalid" });
    expect(wrongSleep).toHaveBeenCalledOnce();
  });

  it("does not slow down below the threshold", async () => {
    await seedFailures(EVENT_PIN_FAILURE_SLOWDOWN_THRESHOLD - 1, "198.51.100.1");
    const sleep = vi.fn(async () => {});
    await attempt(PIN, "203.0.113.7", sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("blocks everyone's PIN once the event-wide threshold is reached, but not the invite", async () => {
    await seedFailures(EVENT_PIN_FAILURE_BLOCK_THRESHOLD, "198.51.100.1");
    expect(await attempt(PIN, "192.0.2.50")).toMatchObject({ kind: "blocked", retryAfterSeconds: 900 });
    const invite = await attemptEventAccess(sqlite.db, SECRET, event, {
      pin: "",
      inviteToken: "a".repeat(64),
      clientIp: "192.0.2.50",
    });
    expect(invite).toEqual({ kind: "granted" });
  });

  it("counts concurrent guesses against each other", async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_PIN_FAILURES_PER_CLIENT + 3 }, (_, i) => attempt(String(100000 + i)))
    );
    expect(results.filter((result) => result.kind === "invalid").length).toBeLessThanOrEqual(MAX_PIN_FAILURES_PER_CLIENT);
    expect(results.some((result) => result.kind === "blocked")).toBe(true);
    expect(await attempt(PIN)).toMatchObject({ kind: "blocked" });
  });

  it("treats a missing PIN, an oversized PIN and an event without a PIN as invalid without recording", async () => {
    expect(await attempt("   ")).toEqual({ kind: "invalid" });
    expect(await attempt("1".repeat(21))).toEqual({ kind: "invalid" });
    event = { ...event, access_pin_hash: null, access_pin_salt: null };
    expect(await attempt(PIN)).toEqual({ kind: "invalid" });
    expect(failures()).toBe(0);
  });
});
