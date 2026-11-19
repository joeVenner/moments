import { beforeEach, describe, expect, it } from "vitest";
import { applyStoreEvent, startPlan } from "./plans";
import { insertPlan, loadLivePlan, PlanConflictError, updatePlan } from "./plansRepo";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";

const HOST = "aaaaaaaa-0000-4000-8000-000000000001";
const bought = new Date("2026-11-20T10:00:00Z");
const periodEnd = new Date("2026-12-20T10:00:00Z");
let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(HOST);
});

describe("products", () => {
  it("offers the four tiers by guest count and the Extra event", () => {
    expect(sqlite.raw.prepare("SELECT id, kind, tier_rank, guest_cap FROM products ORDER BY id").all()).toEqual([
      { id: "extra_event", kind: "consumable", tier_rank: null, guest_cap: null },
      { id: "host_150", kind: "subscription", tier_rank: 2, guest_cap: 150 },
      { id: "host_300", kind: "subscription", tier_rank: 3, guest_cap: 300 },
      { id: "host_50", kind: "subscription", tier_rank: 1, guest_cap: 50 },
      { id: "host_600", kind: "subscription", tier_rank: 4, guest_cap: 600 },
    ]);
  });

  it("refuses a subscription without a guest cap", () => {
    expect(() => sqlite.raw.prepare("INSERT INTO products (id, kind) VALUES ('x', 'subscription')").run()).toThrow(/CHECK/);
  });
});

describe("plans", () => {
  it("stores a first plan with one test and one main event, and reads it back unchanged", async () => {
    const plan = startPlan("host_150", bought, periodEnd);
    const stored = await insertPlan(sqlite.db, HOST, plan, "plan-1");
    expect(await loadLivePlan(sqlite.db, HOST)).toEqual(stored);
    expect(
      sqlite.raw.prepare("SELECT kind, source, transaction_id, consumed_event_id FROM event_allowances ORDER BY kind").all()
    ).toEqual([
      { kind: "main", source: "included", transaction_id: null, consumed_event_id: null },
      { kind: "test", source: "included", transaction_id: null, consumed_event_id: null },
    ]);
  });

  it("saves every change the rules make", async () => {
    const stored = await insertPlan(sqlite.db, HOST, startPlan("host_150", bought, periodEnd), "plan-1");
    let plan = applyStoreEvent(stored.plan, { kind: "downgrade_scheduled", productId: "host_50", at: bought });
    plan = applyStoreEvent(plan, { kind: "billing_failed", graceEndsAt: new Date("2027-01-05T10:00:00Z"), at: periodEnd });
    const saved = await updatePlan(sqlite.db, { ...stored, plan });
    expect(await loadLivePlan(sqlite.db, HOST)).toEqual({ id: "plan-1", version: 1, plan });

    plan = applyStoreEvent(plan, { kind: "expired", at: periodEnd });
    await updatePlan(sqlite.db, { ...saved, plan });
    expect((await loadLivePlan(sqlite.db, HOST))?.plan).toMatchObject({ state: "lapsed", graceEndsAt: null });
  });

  it("allows one live plan per host, and a new one once the old one is purged", async () => {
    await insertPlan(sqlite.db, HOST, startPlan("host_50", bought, periodEnd), "plan-1");
    await expect(insertPlan(sqlite.db, HOST, startPlan("host_50", bought, periodEnd), "plan-2")).rejects.toThrow(/UNIQUE/);
    // The failed batch left nothing behind.
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM event_allowances").get()).toEqual({ n: 2 });

    sqlite.raw.prepare("UPDATE plans SET state = 'purged' WHERE id = 'plan-1'").run();
    expect(await loadLivePlan(sqlite.db, HOST)).toBeNull();
    await insertPlan(sqlite.db, HOST, startPlan("host_50", bought, periodEnd), "plan-2");
    expect((await loadLivePlan(sqlite.db, HOST))?.id).toBe("plan-2");
    // The test event came with the first plan only; every plan brings a main event.
    expect(sqlite.raw.prepare("SELECT kind FROM event_allowances WHERE plan_id = 'plan-2'").all()).toEqual([{ kind: "main" }]);
  });

  it("refuses an unknown product or state", async () => {
    await expect(insertPlan(sqlite.db, HOST, startPlan("host_9000", bought, periodEnd))).rejects.toThrow(/FOREIGN KEY/);
    await insertPlan(sqlite.db, HOST, startPlan("host_50", bought, periodEnd), "plan-1");
    expect(() => sqlite.raw.prepare("UPDATE plans SET state = 'paused' WHERE id = 'plan-1'").run()).toThrow(/CHECK/);
  });
});

describe("saving over a newer state", () => {
  it("fails instead of overwriting, so two notices at once can't undo each other", async () => {
    const read = await insertPlan(sqlite.db, HOST, startPlan("host_150", bought, periodEnd), "plan-1");
    const renewed = applyStoreEvent(read.plan, { kind: "renewed", periodEndsAt: new Date("2027-01-20T10:00:00Z"), at: periodEnd });
    await updatePlan(sqlite.db, { ...read, plan: renewed });

    // A second notice handled from the same, now stale, read.
    const lapsed = applyStoreEvent(read.plan, { kind: "expired", at: periodEnd });
    await expect(updatePlan(sqlite.db, { ...read, plan: lapsed })).rejects.toBeInstanceOf(PlanConflictError);
    expect((await loadLivePlan(sqlite.db, HOST))?.plan.state).toBe("active");
  });

  it("fails for a plan that doesn't exist", async () => {
    const ghost = { id: "nope", version: 0, plan: startPlan("host_50", bought, periodEnd) };
    await expect(updatePlan(sqlite.db, ghost)).rejects.toBeInstanceOf(PlanConflictError);
  });
});

describe("event allowances", () => {
  beforeEach(async () => {
    await insertPlan(sqlite.db, HOST, startPlan("host_50", bought, periodEnd), "plan-1");
  });

  it("gives each Extra event purchase exactly one main event", () => {
    const addon = sqlite.raw.prepare(
      "INSERT INTO event_allowances (id, plan_id, kind, source, transaction_id) VALUES (?, 'plan-1', ?, 'addon', ?)"
    );
    addon.run("a1", "main", "txn-1");
    expect(() => addon.run("a2", "main", "txn-1")).toThrow(/UNIQUE/);
    expect(() => addon.run("a3", "test", "txn-2")).toThrow(/CHECK/);
    expect(() =>
      sqlite.raw.prepare("INSERT INTO event_allowances (id, plan_id, kind, source) VALUES ('a4', 'plan-1', 'main', 'addon')").run()
    ).toThrow(/CHECK/);
  });

  it("lets one event use up only one allowance", () => {
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('e1', 'e1', 'E', 'Party')").run();
    const use = sqlite.raw.prepare("UPDATE event_allowances SET consumed_event_id = 'e1' WHERE plan_id = 'plan-1' AND kind = ?");
    use.run("main");
    expect(() => use.run("test")).toThrow(/UNIQUE/);
  });
});
