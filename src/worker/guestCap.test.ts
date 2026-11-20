import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { capWithGrace, eventGuestCap, TEST_EVENT_GUEST_CAP } from "./guestCap";
import { joinEventAsGuest } from "./guestIdentity";
import { upsertParticipant } from "./participants";
import { addDays, startPlan } from "./plans";
import { insertPlan } from "./plansRepo";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

const HOST = "aaaaaaaa-0000-4000-8000-000000000001";
let sqlite: SqliteD1;

function seedEvent(id: string, kind: "legacy" | "operator" | "main" | "test", owner: string | null = HOST) {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, kind, owner_user_id) VALUES (?, ?, 'E', 'Party', ?, ?)")
    .run(id, id, kind, kind === "legacy" ? null : owner);
}

/** Fills the event with `count` guests named g0, g1, … */
function seedGuests(eventId: string, count: number) {
  const insert = sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES (?, ?, ?)");
  for (let index = 0; index < count; index++) insert.run(`${eventId}-g${index}`, eventId, `g${index}`);
}

const guestCount = (eventId: string) =>
  (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM participants WHERE event_id = ?").get(eventId) as { n: number }).n;

function join(eventId: string, nickname: string) {
  return joinEventAsGuest(sqlite.db, { eventId, nickname, avatarSeed: null, presentedToken: null, enforceClaims: true });
}

function buyPlan(productId = "host_50") {
  return insertPlan(sqlite.db, HOST, startPlan(productId, new Date(), addDays(new Date(), 30)));
}

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(HOST);
});

describe("capWithGrace", () => {
  it("adds 10% to each tier, without floating-point surprises", () => {
    expect([50, 150, 300, 600].map(capWithGrace)).toEqual([55, 165, 330, 660]);
    expect(capWithGrace(15)).toBe(17);
  });
});

describe("eventGuestCap", () => {
  it("leaves events from before plans and the operator's own unlimited", async () => {
    seedEvent("old", "legacy");
    seedEvent("op", "operator");
    expect(await eventGuestCap(sqlite.db, "old")).toBeNull();
    expect(await eventGuestCap(sqlite.db, "op")).toBeNull();
  });

  it("gives a test event its fixed cap and a main event its plan's tier plus grace", async () => {
    await buyPlan("host_150");
    seedEvent("trial", "test");
    seedEvent("main", "main");
    expect(await eventGuestCap(sqlite.db, "trial")).toBe(TEST_EVENT_GUEST_CAP);
    expect(await eventGuestCap(sqlite.db, "main")).toBe(165);
  });

  it("follows an upgrade at once", async () => {
    const { id } = await buyPlan("host_50");
    seedEvent("main", "main");
    sqlite.raw.prepare("UPDATE plans SET product_id = 'host_300' WHERE id = ?").run(id);
    expect(await eventGuestCap(sqlite.db, "main")).toBe(330);
  });

  it("lets nobody new into a main event once its plan has ended", async () => {
    const { id } = await buyPlan();
    seedEvent("main", "main");
    for (const state of ["lapsed", "revoked"]) {
      sqlite.raw.prepare("UPDATE plans SET state = ? WHERE id = ?").run(state, id);
      expect(await eventGuestCap(sqlite.db, "main")).toBe(0);
    }
  });

  it("lets nobody new into a main event whose owner has no live plan, or an unknown event", async () => {
    const { id } = await buyPlan();
    seedEvent("main", "main");
    sqlite.raw.prepare("UPDATE plans SET state = 'purged' WHERE id = ?").run(id);
    expect(await eventGuestCap(sqlite.db, "main")).toBe(0);
    expect(await eventGuestCap(sqlite.db, "nope")).toBe(0);
  });
});

describe("joining a capped event", () => {
  it("lets guests in up to the cap, then answers guest_cap_reached and adds nobody", async () => {
    await buyPlan("host_50");
    seedEvent("main", "main");
    seedGuests("main", 54);
    expect((await join("main", "Sara")).ok).toBe(true);
    expect(await join("main", "Omar")).toEqual({ ok: false, error: "guest_cap_reached" });
    expect(guestCount("main")).toBe(55);
  });

  it("always lets a guest who is already in rejoin", async () => {
    seedEvent("trial", "test");
    seedGuests("trial", TEST_EVENT_GUEST_CAP);
    // g0 was added before guest tokens: joining claims it even though the event is full.
    const rejoined = await join("trial", "g0");
    expect(rejoined.ok).toBe(true);
    expect(guestCount("trial")).toBe(TEST_EVENT_GUEST_CAP);
  });

  it("still answers nickname_taken for someone else's name in a full event", async () => {
    seedEvent("trial", "test");
    seedGuests("trial", TEST_EVENT_GUEST_CAP - 1);
    expect((await join("trial", "Sara")).ok).toBe(true);
    expect(await join("trial", "Sara")).toEqual({ ok: false, error: "nickname_taken" });
  });

  // node:sqlite runs each statement at once, so this shows the count is taken
  // inside the insert (not from an earlier read); D1 serialises writes the same way.
  it("lets only one of two joins started together take the last seat", async () => {
    seedEvent("trial", "test");
    seedGuests("trial", TEST_EVENT_GUEST_CAP - 1);
    const results = await Promise.all([join("trial", "Sara"), join("trial", "Omar")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(guestCount("trial")).toBe(TEST_EVENT_GUEST_CAP);
  });

  it("never limits an event from before plans", async () => {
    seedEvent("old", "legacy");
    seedGuests("old", 700);
    expect((await join("old", "Sara")).ok).toBe(true);
  });
});

describe("web uploads", () => {
  it("add the uploader as a guest only while the event has room", async () => {
    seedEvent("trial", "test");
    seedGuests("trial", TEST_EVENT_GUEST_CAP - 1);
    await upsertParticipant(sqlite.db, "trial", "Sara");
    await upsertParticipant(sqlite.db, "trial", "Omar");
    expect(guestCount("trial")).toBe(TEST_EVENT_GUEST_CAP);
    expect(sqlite.raw.prepare("SELECT 1 FROM participants WHERE nickname = 'Omar'").get()).toBeUndefined();
  });
});

describe("join routes", () => {
  function env(): Env {
    return {
      DB: sqlite.db,
      BUCKET: {} as R2Bucket,
      ASSETS: {} as Fetcher,
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "secret",
      ADMIN_AUTH_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit,
    };
  }
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

  beforeEach(async () => {
    // The plan hosts the event, so the join reaches the cap check.
    await buyPlan();
    seedEvent("trial", "test");
    seedGuests("trial", TEST_EVENT_GUEST_CAP);
  });

  it("answer 409 guest_cap_reached on the web", async () => {
    const response = await worker.fetch(
      new Request("https://moments.test/api/events/trial/participants", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.9" },
        body: new URLSearchParams({ nickname: "Sara" }),
      }),
      env(),
      ctx()
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "guest_cap_reached" });
  });

  it("answer 409 guest_cap_reached in the app API", async () => {
    const response = await worker.fetch(
      new Request("https://moments.test/api/v1/events/trial/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify({ nickname: "Sara" }),
      }),
      env(),
      ctx()
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "guest_cap_reached" });
  });
});
