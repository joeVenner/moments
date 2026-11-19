import { fromSqlTimestamp, sqlTimestamp } from "./events";
import type { Plan, PlanState } from "./plans";

/**
 * Loads and stores hosting plans. The rules live in plans.ts; this module
 * only moves a `Plan` in and out of D1 (dates as "YYYY-MM-DD HH:MM:SS" UTC,
 * so they keep whole seconds).
 */

interface PlanRow {
  id: string;
  state: PlanState;
  product_id: string;
  pending_product_id: string | null;
  started_at: string;
  test_window_ends_at: string;
  period_ends_at: string;
  grace_ends_at: string | null;
  readonly_until: string | null;
  version: number;
}

export interface StoredPlan {
  id: string;
  /** The row's version when it was read; updatePlan only writes over that one. */
  version: number;
  plan: Plan;
}

/** Someone else saved the plan since it was read (or it doesn't exist): reload and apply again. */
export class PlanConflictError extends Error {
  constructor(readonly planId: string) {
    super(`plan ${planId} changed since it was read`);
    this.name = "PlanConflictError";
  }
}

function optionalDate(value: string | null): Date | null {
  return value === null ? null : fromSqlTimestamp(value);
}

function optionalTimestamp(date: Date | null): string | null {
  return date === null ? null : sqlTimestamp(date);
}

function toPlan(row: PlanRow): Plan {
  return {
    state: row.state,
    productId: row.product_id,
    pendingProductId: row.pending_product_id,
    startedAt: fromSqlTimestamp(row.started_at),
    testWindowEndsAt: fromSqlTimestamp(row.test_window_ends_at),
    periodEndsAt: fromSqlTimestamp(row.period_ends_at),
    graceEndsAt: optionalDate(row.grace_ends_at),
    readonlyUntil: optionalDate(row.readonly_until),
  };
}

/** The user's plan that isn't purged yet, or null. */
export async function loadLivePlan(db: D1Database, userId: string): Promise<StoredPlan | null> {
  const row = await db
    .prepare(
      `SELECT id, state, product_id, pending_product_id, started_at, test_window_ends_at, period_ends_at,
              grace_ends_at, readonly_until, version
       FROM plans WHERE user_id = ? AND state != 'purged'`
    )
    .bind(userId)
    .first<PlanRow>();
  return row ? { id: row.id, version: row.version, plan: toPlan(row) } : null;
}

/**
 * Stores a newly bought plan with the events it includes, in one batch: a
 * main event always, the test event only if this is the host's first plan
 * (so letting a plan lapse and buying again doesn't mint free test events).
 * Fails (UNIQUE) when the user already has a live plan.
 */
export async function insertPlan(
  db: D1Database,
  userId: string,
  plan: Plan,
  id: string = crypto.randomUUID()
): Promise<StoredPlan> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO plans (id, user_id, state, product_id, pending_product_id, started_at, test_window_ends_at,
                            period_ends_at, grace_ends_at, readonly_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        userId,
        plan.state,
        plan.productId,
        plan.pendingProductId,
        sqlTimestamp(plan.startedAt),
        sqlTimestamp(plan.testWindowEndsAt),
        sqlTimestamp(plan.periodEndsAt),
        optionalTimestamp(plan.graceEndsAt),
        optionalTimestamp(plan.readonlyUntil)
      ),
    db
      .prepare("INSERT INTO event_allowances (id, plan_id, kind, source) VALUES (?, ?, 'main', 'included')")
      .bind(crypto.randomUUID(), id),
    db
      .prepare(
        `INSERT INTO event_allowances (id, plan_id, kind, source)
         SELECT ?1, ?2, 'test', 'included'
         WHERE NOT EXISTS (SELECT 1 FROM plans WHERE user_id = ?3 AND id != ?2)`
      )
      .bind(crypto.randomUUID(), id, userId),
  ]);
  return { id, version: 0, plan };
}

/**
 * Writes a plan's new state (from applyStoreEvent) and returns it with its
 * new version. The start and test window never change. Throws
 * PlanConflictError when the row changed since `stored` was read.
 */
export async function updatePlan(db: D1Database, stored: StoredPlan): Promise<StoredPlan> {
  const { plan } = stored;
  const result = await db
    .prepare(
      `UPDATE plans SET state = ?, product_id = ?, pending_product_id = ?, period_ends_at = ?, grace_ends_at = ?,
                        readonly_until = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ?`
    )
    .bind(
      plan.state,
      plan.productId,
      plan.pendingProductId,
      sqlTimestamp(plan.periodEndsAt),
      optionalTimestamp(plan.graceEndsAt),
      optionalTimestamp(plan.readonlyUntil),
      stored.id,
      stored.version
    )
    .run();
  if (result.meta.changes !== 1) throw new PlanConflictError(stored.id);
  return { ...stored, version: stored.version + 1 };
}
