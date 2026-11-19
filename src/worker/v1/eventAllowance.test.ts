import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { OPERATOR_USER_ID } from "../hostSessions";
import { addDays, applyStoreEvent, startPlan } from "../plans";
import { insertPlan, loadLivePlan, updatePlan } from "../plansRepo";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { AdminEventDetailSchema, ErrorSchema, HostSignInResponseSchema } from "./schemas";

const HOST = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_HOST = "bbbbbbbb-0000-4000-8000-000000000002";
let sqlite: SqliteD1;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret-password",
    ADMIN_AUTH_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit,
    EVENT_ACCESS_SECRET: "test-access-secret-123",
  };
}

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

/** A live session for a user: the operator signs in, then it is handed over. */
async function sessionFor(userId: string): Promise<string> {
  const response = await worker.fetch(
    new Request("https://moments.test/api/v1/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ username: "admin", password: "secret-password" }),
    }),
    env(),
    ctx()
  );
  const { token } = HostSignInResponseSchema.parse(await response.json());
  sqlite.raw.prepare("UPDATE host_sessions SET user_id = ? WHERE user_id IS NOT ?").run(userId, userId);
  return token;
}

async function create(token: string, title = "Garden party", extra: Record<string, unknown> = {}) {
  return worker.fetch(
    new Request("https://moments.test/api/v1/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, type: "Party", ...extra }),
    }),
    env(),
    ctx()
  );
}

async function changeDates(token: string, id: string, body: Record<string, unknown>) {
  return worker.fetch(
    new Request(`https://moments.test/api/v1/admin/events/${id}/lifecycle`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    env(),
    ctx()
  );
}

const inAMonth = () => addDays(new Date(), 30).toISOString();

async function errorCode(response: Response) {
  return ErrorSchema.parse(await response.json()).code;
}

function allowances() {
  return sqlite.raw
    .prepare("SELECT kind, source, consumed_event_id IS NOT NULL AS used FROM event_allowances ORDER BY kind, source")
    .all();
}

const eventCount = () => (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

function buyPlan(userId = HOST, now = new Date()) {
  return insertPlan(sqlite.db, userId, startPlan("host_150", now, addDays(now, 30)));
}

beforeEach(() => {
  sqlite = createSqliteD1();
  const user = sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')");
  user.run(HOST);
  user.run(OTHER_HOST);
});

describe("creating an event uses up the plan's main event", () => {
  it("creates the first main event and marks it used", async () => {
    await buyPlan();
    const response = await create(await sessionFor(HOST));
    expect(response.status).toBe(201);
    const { event } = AdminEventDetailSchema.parse(await response.json());
    expect(sqlite.raw.prepare("SELECT kind FROM event_allowances WHERE consumed_event_id = ?").get(event.id)).toEqual({
      kind: "main",
    });
  });

  it("refuses a second event with no_events_left and creates nothing", async () => {
    await buyPlan();
    const token = await sessionFor(HOST);
    expect((await create(token)).status).toBe(201);
    const second = await create(token, "Another party");
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("no_events_left");
    expect(eventCount()).toBe(1);
  });

  it("uses an Extra event once the included one is gone, never the test event", async () => {
    const { id: planId } = await buyPlan();
    sqlite.raw
      .prepare("INSERT INTO event_allowances (id, plan_id, kind, source, transaction_id) VALUES ('x1', ?, 'main', 'addon', 'txn-1')")
      .run(planId);
    const token = await sessionFor(HOST);
    expect((await create(token, "One")).status).toBe(201);
    expect((await create(token, "Two")).status).toBe(201);
    expect((await create(token, "Three")).status).toBe(409);
    expect(allowances()).toEqual([
      { kind: "main", source: "addon", used: 1 },
      { kind: "main", source: "included", used: 1 },
      { kind: "test", source: "included", used: 0 },
    ]);
  });

  it("never spends another host's allowance", async () => {
    await buyPlan(OTHER_HOST);
    const response = await create(await sessionFor(HOST));
    expect(response.status).toBe(402);
    expect(await errorCode(response)).toBe("plan_required");
    expect(allowances().every((row) => (row as { used: number }).used === 0)).toBe(true);
  });
});

describe("without a plan that allows new events", () => {
  it("answers plan_required to a host who never bought one", async () => {
    const response = await create(await sessionFor(HOST));
    expect(response.status).toBe(402);
    expect(await errorCode(response)).toBe("plan_required");
    expect(eventCount()).toBe(0);
  });

  it("answers plan_required while a payment is failing", async () => {
    const stored = await buyPlan();
    const failing = applyStoreEvent(stored.plan, { kind: "billing_failed", graceEndsAt: new Date(), at: new Date() });
    await updatePlan(sqlite.db, { ...stored, plan: applyStoreEvent(failing, { kind: "grace_expired", at: new Date() }) });
    expect((await loadLivePlan(sqlite.db, HOST))?.plan.state).toBe("billing_retry");
    expect((await create(await sessionFor(HOST))).status).toBe(402);
  });

  it("answers plan_required once a cancelled plan's period is over, even before the cleanup job runs", async () => {
    const bought = addDays(new Date(), -40);
    const stored = await insertPlan(sqlite.db, HOST, startPlan("host_150", bought, addDays(bought, 30)));
    await updatePlan(sqlite.db, { ...stored, plan: applyStoreEvent(stored.plan, { kind: "auto_renew_off", at: bought }) });
    expect((await create(await sessionFor(HOST))).status).toBe(402);
    expect(allowances().every((row) => (row as { used: number }).used === 0)).toBe(true);
  });
});

describe("a purged plan", () => {
  it("can't be spent, even with unused events", async () => {
    await buyPlan();
    sqlite.raw.prepare("UPDATE plans SET state = 'purged'").run();
    expect((await create(await sessionFor(HOST))).status).toBe(402);
    expect(eventCount()).toBe(0);
  });
});

describe("the test event", () => {
  it("uses the test allowance and takes its dates from the plan", async () => {
    const bought = new Date(Date.UTC(2026, 10, 20, 10, 0, 0));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(addDays(bought, 3));
    try {
      await insertPlan(sqlite.db, HOST, startPlan("host_150", bought, addDays(bought, 30)));
      const response = await create(await sessionFor(HOST), "Trial run", { kind: "test" });
      expect(response.status).toBe(201);
      const { event } = AdminEventDetailSchema.parse(await response.json());
      expect(event.kind).toBe("test");
      expect(sqlite.raw.prepare("SELECT uploads_close_at, purge_after, expires_at FROM events WHERE id = ?").get(event.id)).toEqual({
        uploads_close_at: "2026-12-20 10:00:00",
        purge_after: "2026-12-27 10:00:00",
        expires_at: null,
      });
      expect(allowances()).toEqual([
        { kind: "main", source: "included", used: 0 },
        { kind: "test", source: "included", used: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be created once", async () => {
    await buyPlan();
    const token = await sessionFor(HOST);
    expect((await create(token, "One", { kind: "test" })).status).toBe(201);
    const second = await create(token, "Two", { kind: "test" });
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("no_events_left");
  });

  it("isn't offered once the plan's first month is over", async () => {
    // Renewed plan, bought 40 days ago: still active, test month gone.
    const bought = addDays(new Date(), -40);
    await insertPlan(sqlite.db, HOST, startPlan("host_150", bought, addDays(new Date(), 20)));
    const response = await create(await sessionFor(HOST), "Late", { kind: "test" });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("no_events_left");
    expect(eventCount()).toBe(0);
  });

  it("comes only with a host's first plan", async () => {
    const { id } = await buyPlan();
    sqlite.raw.prepare("UPDATE plans SET state = 'purged' WHERE id = ?").run(id);
    await buyPlan();
    expect((await create(await sessionFor(HOST), "Trial", { kind: "test" })).status).toBe(409);
  });

  it("refuses an end date of its own", async () => {
    await buyPlan();
    const response = await create(await sessionFor(HOST), "Trial", { kind: "test", expires_at: inAMonth() });
    expect(response.status).toBe(400);
    expect(allowances().every((row) => (row as { used: number }).used === 0)).toBe(true);
  });

  it("keeps its dates: the host can't move them", async () => {
    await buyPlan();
    const token = await sessionFor(HOST);
    const { event } = AdminEventDetailSchema.parse(await (await create(token, "Trial", { kind: "test" })).json());
    const before = sqlite.raw.prepare("SELECT uploads_close_at, purge_after FROM events WHERE id = ?").get(event.id);
    const response = await changeDates(token, event.id, { purge_after: addDays(new Date(), 365).toISOString() });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("test_event_dates_fixed");
    expect(sqlite.raw.prepare("SELECT uploads_close_at, purge_after FROM events WHERE id = ?").get(event.id)).toEqual(before);
  });

  it("keeps its dates in the web admin too", async () => {
    await buyPlan();
    const { event } = AdminEventDetailSchema.parse(await (await create(await sessionFor(HOST), "Trial", { kind: "test" })).json());
    const response = await worker.fetch(
      new Request(`https://moments.test/api/admin/events/${event.id}/lifecycle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa("admin:secret-password")}` },
        body: JSON.stringify({ expires_at: addDays(new Date(), 365).toISOString() }),
      }),
      env(),
      ctx()
    );
    expect(response.status).toBe(409);
  });

  it("is just not found for another host", async () => {
    await buyPlan();
    const { event } = AdminEventDetailSchema.parse(await (await create(await sessionFor(HOST), "Trial", { kind: "test" })).json());
    const response = await changeDates(await sessionFor(OTHER_HOST), event.id, { expires_at: inAMonth() });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("event_not_found");
  });

  it("leaves a main event's dates changeable", async () => {
    await buyPlan();
    const token = await sessionFor(HOST);
    const { event } = AdminEventDetailSchema.parse(await (await create(token)).json());
    expect(event.kind).toBe("main");
    expect((await changeDates(token, event.id, { expires_at: inAMonth() })).status).toBe(200);
  });
});

describe("the operator", () => {
  it("creates events without a plan", async () => {
    const token = await sessionFor(OPERATOR_USER_ID);
    const first = await create(token, "One");
    expect(first.status).toBe(201);
    expect(AdminEventDetailSchema.parse(await first.json()).event.kind).toBe("operator");
    expect((await create(token, "Two")).status).toBe(201);
    expect(allowances()).toEqual([]);
  });

  it("has no test event to create", async () => {
    const response = await create(await sessionFor(OPERATOR_USER_ID), "Trial", { kind: "test" });
    expect(response.status).toBe(400);
    expect(eventCount()).toBe(0);
  });
});

describe("events from before plans", () => {
  it("are legacy, and guests never see an event's kind", async () => {
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('old', 'old', 'Old', 'Party')").run();
    expect(sqlite.raw.prepare("SELECT kind FROM events WHERE id = 'old'").get()).toEqual({ kind: "legacy" });
    const response = await worker.fetch(new Request("https://moments.test/api/v1/events/old"), env(), ctx());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { event: Record<string, unknown> };
    expect(body.event).toMatchObject({ id: "old", title: "Old" });
    expect(body.event).not.toHaveProperty("kind");
    expect(body.event).not.toHaveProperty("owner_user_id");
  });
});
