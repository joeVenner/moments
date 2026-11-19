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

async function create(token: string, title = "Garden party") {
  return worker.fetch(
    new Request("https://moments.test/api/v1/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, type: "Party" }),
    }),
    env(),
    ctx()
  );
}

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

describe("the operator", () => {
  it("creates events without a plan", async () => {
    const token = await sessionFor(OPERATOR_USER_ID);
    expect((await create(token, "One")).status).toBe(201);
    expect((await create(token, "Two")).status).toBe(201);
    expect(allowances()).toEqual([]);
  });
});
