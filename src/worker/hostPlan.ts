import { sqlTimestamp } from "./events";
import { planAccess, testEventDates, type PlanState } from "./plans";
import { loadLivePlan } from "./plansRepo";

/**
 * What a host's app shows about their hosting plan: its state and dates,
 * what the host may do now, and how many events of each kind they can still
 * create. Read-only; the rules live in plans.ts.
 */
export interface HostPlanView {
  state: Exclude<PlanState, "purged">;
  productId: string;
  /** The tier's guest limit per main event (before the 10% grace). */
  guestCap: number;
  /** A downgrade that applies at the next renewal, or null. */
  pendingProductId: string | null;
  periodEndsAt: string;
  testWindowEndsAt: string;
  graceEndsAt: string | null;
  readonlyUntil: string | null;
  canEdit: boolean;
  canModerate: boolean;
  canDownload: boolean;
  /** Events the host can create right now, by kind (0 when the plan doesn't allow creating). */
  eventsLeft: { main: number; test: number };
}

interface AllowanceCounts {
  main: number;
  test: number;
}

/** The user's live plan as the app shows it, or null when they have none. */
export async function loadHostPlanView(db: D1Database, userId: string, now: Date = new Date()): Promise<HostPlanView | null> {
  const stored = await loadLivePlan(db, userId);
  if (!stored) return null;
  const { plan } = stored;
  const state = plan.state;
  // loadLivePlan skips purged plans; the check also narrows the type.
  if (state === "purged") return null;
  // Two reads with different row shapes: run side by side, each typed.
  const [product, unused] = await Promise.all([
    db.prepare("SELECT guest_cap FROM products WHERE id = ?").bind(plan.productId).first<{ guest_cap: number | null }>(),
    db
      .prepare(
        `SELECT kind, COUNT(*) AS free FROM event_allowances
         WHERE plan_id = ? AND consumed_event_id IS NULL GROUP BY kind`
      )
      .bind(stored.id)
      .all<{ kind: string; free: number }>(),
  ]);
  const guestCap = product?.guest_cap;
  // Every plan's product is seeded with its cap; a missing one is a data bug.
  if (guestCap === null || guestCap === undefined) throw new Error(`product ${plan.productId} has no guest cap`);
  const access = planAccess(plan, now);
  const free = countByKind(unused.results);
  // Same rules as creating an event: the plan must allow editing, and the
  // test event can only be created during the plan's first month.
  const testStillOpen = now < testEventDates(plan).closesAt;
  return {
    state,
    productId: plan.productId,
    guestCap,
    pendingProductId: plan.pendingProductId,
    periodEndsAt: sqlTimestamp(plan.periodEndsAt),
    testWindowEndsAt: sqlTimestamp(plan.testWindowEndsAt),
    graceEndsAt: plan.graceEndsAt ? sqlTimestamp(plan.graceEndsAt) : null,
    readonlyUntil: plan.readonlyUntil ? sqlTimestamp(plan.readonlyUntil) : null,
    canEdit: access.hostCanEdit,
    canModerate: access.hostCanModerate,
    canDownload: access.hostCanDownload,
    eventsLeft: {
      main: access.hostCanEdit ? free.main : 0,
      test: access.hostCanEdit && testStillOpen ? free.test : 0,
    },
  };
}

function countByKind(rows: { kind: string; free: number }[]): AllowanceCounts {
  const counts: AllowanceCounts = { main: 0, test: 0 };
  for (const row of rows) {
    if (row.kind === "main" || row.kind === "test") counts[row.kind] = row.free;
  }
  return counts;
}
