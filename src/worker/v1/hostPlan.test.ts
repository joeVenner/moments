import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { OPERATOR_USER_ID } from "../hostSessions";
import { addDays, startPlan } from "../plans";
import { insertPlan } from "../plansRepo";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { HostPlanResponseSchema, HostSignInResponseSchema } from "./schemas";

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

async function getPlan(userId: string) {
  const token = await sessionFor(userId);
  const response = await worker.fetch(
    new Request("https://moments.test/api/v1/admin/plan", { headers: { Authorization: `Bearer ${token}` } }),
    env(),
    ctx()
  );
  expect(response.status).toBe(200);
  return HostPlanResponseSchema.parse(await response.json()).plan;
}

/** A host_150 plan bought `daysAgo` days ago, paid until 30 days from now. */
async function buyPlan(userId: string, daysAgo = 0) {
  return insertPlan(sqlite.db, userId, startPlan("host_150", addDays(new Date(), -daysAgo), addDays(new Date(), 30)));
}

function setState(planId: string, state: string, readonlyUntil: Date | null) {
  sqlite.raw
    .prepare("UPDATE plans SET state = ?, readonly_until = ? WHERE id = ?")
    .run(state, readonlyUntil ? readonlyUntil.toISOString().slice(0, 19).replace("T", " ") : null, planId);
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  sqlite = createSqliteD1();
  for (const id of [HOST, OTHER_HOST]) sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(id);
});

describe("GET /api/v1/admin/plan", () => {
  it("answers null for the operator, who hosts without a plan", async () => {
    expect(await getPlan(OPERATOR_USER_ID)).toBeNull();
  });

  it("answers null for a host without a plan", async () => {
    expect(await getPlan(HOST)).toBeNull();
  });

  it("describes a paid plan with its included events", async () => {
    await buyPlan(HOST);
    expect(await getPlan(HOST)).toMatchObject({
      state: "active",
      product_id: "host_150",
      guest_cap: 150,
      pending_product_id: null,
      grace_ends_at: null,
      readonly_until: null,
      can_edit: true,
      can_moderate: true,
      can_download: true,
      events_left: { main: 1, test: 1 },
    });
  });

  it("counts an event already created as used", async () => {
    const { id } = await buyPlan(HOST);
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, kind, owner_user_id) VALUES ('e1', 'p', 'P', 'P', 'main', ?)").run(HOST);
    sqlite.raw.prepare("UPDATE event_allowances SET consumed_event_id = 'e1' WHERE plan_id = ? AND kind = 'main'").run(id);
    expect((await getPlan(HOST))?.events_left).toEqual({ main: 0, test: 1 });
  });

  it("no longer offers the test event once the plan's first month is over", async () => {
    // Bought 40 days ago and renewed since: the test event's month has passed.
    await buyPlan(HOST, 40);
    expect((await getPlan(HOST))?.events_left).toEqual({ main: 1, test: 0 });
  });

  it("shows a lapsed plan as download-only with nothing left to create", async () => {
    const { id } = await buyPlan(HOST);
    setState(id, "lapsed", addDays(new Date(), 20));
    const plan = await getPlan(HOST);
    expect(plan).toMatchObject({ state: "lapsed", can_edit: false, can_moderate: false, can_download: true, events_left: { main: 0, test: 0 } });
    expect(plan?.readonly_until).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("shows a failed payment's grace period and a pending downgrade", async () => {
    const { id } = await buyPlan(HOST);
    const graceEnds = addDays(new Date(), 16).toISOString().slice(0, 19).replace("T", " ");
    sqlite.raw
      .prepare("UPDATE plans SET state = 'grace', grace_ends_at = ?, pending_product_id = 'host_50' WHERE id = ?")
      .run(graceEnds, id);
    expect(await getPlan(HOST)).toMatchObject({
      state: "grace",
      grace_ends_at: graceEnds,
      pending_product_id: "host_50",
      can_edit: true,
      events_left: { main: 1, test: 1 },
    });
  });

  it("logs a plan whose product has no guest cap and answers 500", async () => {
    // The schema keeps every subscription's cap; a plan pointing at the
    // consumable (which has none) is the data bug that's still possible.
    const { id } = await buyPlan(HOST);
    sqlite.raw.prepare("UPDATE plans SET product_id = 'extra_event' WHERE id = ?").run(id);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = await sessionFor(HOST);
    const response = await worker.fetch(
      new Request("https://moments.test/api/v1/admin/plan", { headers: { Authorization: `Bearer ${token}` } }),
      env(),
      ctx()
    );
    expect(response.status).toBe(500);
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({ scope: "plan", event: "product_guest_cap_missing", product_id: "extra_event" })
    );
  });

  it("never shows another host's plan", async () => {
    await buyPlan(OTHER_HOST);
    expect(await getPlan(HOST)).toBeNull();
  });

  it("needs a session", async () => {
    const response = await worker.fetch(new Request("https://moments.test/api/v1/admin/plan"), env(), ctx());
    expect(response.status).toBe(401);
  });
});
