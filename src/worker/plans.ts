/**
 * The rules of a host's hosting plan, as pure functions: no database, no
 * App Store calls. The billing code (later) turns Apple's verified state into
 * `StoreEvent`s and stores the resulting `Plan`.
 *
 * Apple sends notifications at least once and not always in order, so an
 * event that doesn't fit the current state returns the very same plan
 * (`next === plan`) instead of throwing: the next verified state brings it
 * back in line. Every event's `at` is Apple's effective date (expiry,
 * revocation, renewal), not when the notification arrived, so a late
 * notification never lengthens a window.
 */

export type PlanState =
  /** Paid and renewing. */
  | "active"
  /** Paid until the period ends, auto-renew turned off. */
  | "canceling"
  /** A renewal payment failed; Apple's grace period: full service. */
  | "grace"
  /** Grace over, Apple still retrying: guests view only, the host reads and moderates. */
  | "billing_retry"
  /** Ended: guests see "no longer hosted"; the host can download until `readonlyUntil`. */
  | "lapsed"
  /** Refunded: like lapsed, with a shorter download window; only a new purchase brings hosting back. */
  | "revoked"
  /** Everything deleted. Final: hosting again starts a new plan. */
  | "purged";

export interface Plan {
  readonly state: PlanState;
  /** The tier in force (decides the guest cap). */
  readonly productId: string;
  /** A downgrade waiting for the next renewal, or null. */
  readonly pendingProductId: string | null;
  /** When the plan was bought. */
  readonly startedAt: Date;
  /** The included test event stays live until then. */
  readonly testWindowEndsAt: Date;
  /** The end of the paid period. */
  readonly periodEndsAt: Date;
  /** While in grace: when Apple's grace period ends. */
  readonly graceEndsAt: Date | null;
  /** Set once the plan ends: downloads stop and data goes after this. */
  readonly readonlyUntil: Date | null;
}

export type StoreEvent =
  | { readonly kind: "renewed"; readonly periodEndsAt: Date; readonly at: Date }
  | { readonly kind: "upgraded"; readonly productId: string; readonly at: Date }
  | { readonly kind: "downgrade_scheduled"; readonly productId: string; readonly at: Date }
  | { readonly kind: "auto_renew_off"; readonly at: Date }
  | { readonly kind: "auto_renew_on"; readonly at: Date }
  | { readonly kind: "billing_failed"; readonly graceEndsAt: Date; readonly at: Date }
  | { readonly kind: "grace_expired"; readonly at: Date }
  | { readonly kind: "expired"; readonly at: Date }
  /** `periodEndsAt` is the end of the period that was paid back. */
  | { readonly kind: "refunded"; readonly periodEndsAt: Date; readonly at: Date }
  | { readonly kind: "readonly_ended"; readonly at: Date };

export const READONLY_DAYS_AFTER_LAPSE = 30;
export const READONLY_DAYS_AFTER_REFUND = 14;
/** A test event's media is deleted this long after its month ends. */
export const TEST_EVENT_PURGE_DAYS = 7;
/** How long past the period end an unconfirmed renewal keeps full service. */
export const RENEWAL_LAG_DAYS = 2;

const DAY_MS = 86_400_000;

/** States in which the host is paying (or Apple says they still are). */
const PAID: readonly PlanState[] = ["active", "canceling", "grace", "billing_retry"];

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** One calendar month later (UTC), kept within the month: Jan 31 → Feb 28/29. */
export function addOneMonth(date: Date): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(Math.min(day, daysInMonth(next.getUTCFullYear(), next.getUTCMonth())));
  return next;
}

function copy(date: Date): Date {
  return new Date(date.getTime());
}

function earlier(a: Date | null, b: Date): Date {
  return a && a < b ? a : b;
}

/** A newly bought plan: active, with its test event live for a month from now. */
export function startPlan(productId: string, purchasedAt: Date, periodEndsAt: Date): Plan {
  return {
    state: "active",
    productId,
    pendingProductId: null,
    startedAt: copy(purchasedAt),
    testWindowEndsAt: addOneMonth(purchasedAt),
    periodEndsAt: copy(periodEndsAt),
    graceEndsAt: null,
    readonlyUntil: null,
  };
}

/** The plan after one store event; the same plan object when the event doesn't apply. */
export function applyStoreEvent(plan: Plan, event: StoreEvent): Plan {
  const isPaid = PAID.includes(plan.state);
  switch (event.kind) {
    case "renewed": {
      // A lapsed plan comes back if renewed before deletion; a refunded one
      // never does. Only a newer period counts: a stale or replayed renewal
      // must not undo what came after it.
      if (!isPaid && plan.state !== "lapsed") return plan;
      if (event.periodEndsAt <= plan.periodEndsAt || event.periodEndsAt <= event.at) return plan;
      return {
        ...plan,
        state: "active",
        productId: plan.pendingProductId ?? plan.productId,
        pendingProductId: null,
        periodEndsAt: copy(event.periodEndsAt),
        graceEndsAt: null,
        readonlyUntil: null,
      };
    }
    case "upgraded":
      // At once, but only while payments go through: a bigger guest cap
      // isn't granted during a failed payment. Replaces a waiting downgrade.
      return plan.state === "active" || plan.state === "canceling"
        ? { ...plan, productId: event.productId, pendingProductId: null }
        : plan;
    case "downgrade_scheduled":
      return isPaid ? { ...plan, pendingProductId: event.productId } : plan;
    case "auto_renew_off":
      return plan.state === "active" ? { ...plan, state: "canceling" } : plan;
    case "auto_renew_on":
      return plan.state === "canceling" ? { ...plan, state: "active" } : plan;
    case "billing_failed":
      return plan.state === "active" || plan.state === "canceling"
        ? { ...plan, state: "grace", graceEndsAt: copy(event.graceEndsAt) }
        : plan;
    case "grace_expired":
      return plan.state === "grace" ? { ...plan, state: "billing_retry", graceEndsAt: null } : plan;
    case "expired":
      // Only once the current period is over: a late expiry of an earlier
      // period must not end a plan that has renewed since.
      return isPaid && event.at >= plan.periodEndsAt
        ? {
            ...plan,
            state: "lapsed",
            pendingProductId: null,
            graceEndsAt: null,
            readonlyUntil: addDays(event.at, READONLY_DAYS_AFTER_LAPSE),
          }
        : plan;
    case "refunded":
      // A refund ends the plan whatever it was doing. It can only shorten a
      // download window that had already started, never lengthen it.
      if (plan.state === "purged" || plan.state === "revoked") return plan;
      // Paying back an older period leaves the current, paid one alone.
      if (event.periodEndsAt < plan.periodEndsAt) return plan;
      return {
        ...plan,
        state: "revoked",
        pendingProductId: null,
        graceEndsAt: null,
        readonlyUntil: earlier(plan.readonlyUntil, addDays(event.at, READONLY_DAYS_AFTER_REFUND)),
      };
    case "readonly_ended":
      if ((plan.state !== "lapsed" && plan.state !== "revoked") || !plan.readonlyUntil) return plan;
      return event.at >= plan.readonlyUntil ? { ...plan, state: "purged" } : plan;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/**
 * The event the cleanup job applies itself when Apple's notice is overdue
 * and nothing else can happen: a cancelled plan past its end, or a download
 * window that is over. Null otherwise; every other case asks Apple first.
 */
export function overdueEvent(plan: Plan, now: Date): StoreEvent | null {
  if (plan.state === "canceling" && now >= plan.periodEndsAt) {
    return { kind: "expired", at: copy(plan.periodEndsAt) };
  }
  if ((plan.state === "lapsed" || plan.state === "revoked") && plan.readonlyUntil && now >= plan.readonlyUntil) {
    return { kind: "readonly_ended", at: copy(now) };
  }
  return null;
}

export interface PlanAccess {
  /** Guests may join and share new moments. */
  readonly guestsCanShare: boolean;
  /** Guests may open the event and see its moments. */
  readonly guestsCanView: boolean;
  /** The host may create events and change settings. */
  readonly hostCanEdit: boolean;
  /** The host may hide or delete moments. */
  readonly hostCanModerate: boolean;
  /** The host may open the event and download everything. */
  readonly hostCanDownload: boolean;
}

/** Everything allowed (also events no plan pays for). */
export const FULL_ACCESS: PlanAccess = Object.freeze({
  guestsCanShare: true,
  guestsCanView: true,
  hostCanEdit: true,
  hostCanModerate: true,
  hostCanDownload: true,
});
/** Payment failing: guests still see the event, nothing new goes in. */
const VIEW_ONLY: PlanAccess = Object.freeze({
  guestsCanShare: false,
  guestsCanView: true,
  hostCanEdit: false,
  hostCanModerate: true,
  hostCanDownload: true,
});
const HOST_DOWNLOAD_ONLY: PlanAccess = Object.freeze({
  guestsCanShare: false,
  guestsCanView: false,
  hostCanEdit: false,
  hostCanModerate: false,
  hostCanDownload: true,
});
/** Nothing allowed. */
export const NO_ACCESS: PlanAccess = Object.freeze({
  guestsCanShare: false,
  guestsCanView: false,
  hostCanEdit: false,
  hostCanModerate: false,
  hostCanDownload: false,
});

/**
 * What guests and the host may do under this plan right now. Dates are
 * checked as well as the state, so a lost or late notification never keeps
 * service going past what was paid for.
 */
export function planAccess(plan: Plan, now: Date): PlanAccess {
  switch (plan.state) {
    case "active":
      // A renewal can be confirmed a little after the period ends.
      return now < addDays(plan.periodEndsAt, RENEWAL_LAG_DAYS) ? FULL_ACCESS : VIEW_ONLY;
    case "canceling":
      return now < plan.periodEndsAt ? FULL_ACCESS : HOST_DOWNLOAD_ONLY;
    case "grace":
      return plan.graceEndsAt && now < plan.graceEndsAt ? FULL_ACCESS : VIEW_ONLY;
    case "billing_retry":
      return VIEW_ONLY;
    case "lapsed":
    case "revoked":
      // The download window can run out before the purge job has caught up.
      return plan.readonlyUntil && now < plan.readonlyUntil ? HOST_DOWNLOAD_ONLY : NO_ACCESS;
    case "purged":
      return NO_ACCESS;
    default: {
      const unhandled: never = plan.state;
      return unhandled;
    }
  }
}

/** When a plan's test event stops taking uploads and when its media goes. */
export function testEventDates(plan: Plan): { closesAt: Date; purgeAt: Date } {
  return { closesAt: copy(plan.testWindowEndsAt), purgeAt: addDays(plan.testWindowEndsAt, TEST_EVENT_PURGE_DAYS) };
}
