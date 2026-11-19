import { describe, expect, it } from "vitest";
import {
  addOneMonth,
  applyStoreEvent,
  overdueEvent,
  planAccess,
  startPlan,
  testEventDates,
  type Plan,
  type PlanState,
  type StoreEvent,
} from "./plans";

const bought = new Date("2026-11-20T10:00:00Z");
const firstPeriodEnd = new Date("2026-12-20T10:00:00Z");
const at = new Date("2026-12-01T00:00:00Z");

function planIn(state: PlanState, extra: Partial<Plan> = {}): Plan {
  const hasEnded = state === "lapsed" || state === "revoked";
  return {
    ...startPlan("tier_150", bought, firstPeriodEnd),
    state,
    graceEndsAt: state === "grace" ? new Date("2027-01-05T10:00:00Z") : null,
    readonlyUntil: hasEnded ? new Date("2027-01-01T00:00:00Z") : null,
    ...extra,
  };
}

const ALL_STATES: PlanState[] = ["active", "canceling", "grace", "billing_retry", "lapsed", "revoked", "purged"];

/** The state after each event from each state; "ignored" means the very same plan comes back. */
type Outcome = PlanState | "ignored";
const TRANSITIONS: Record<StoreEvent["kind"], Record<PlanState, Outcome>> = {
  renewed: { active: "active", canceling: "active", grace: "active", billing_retry: "active", lapsed: "active", revoked: "ignored", purged: "ignored" },
  upgraded: { active: "active", canceling: "canceling", grace: "ignored", billing_retry: "ignored", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  downgrade_scheduled: { active: "active", canceling: "canceling", grace: "grace", billing_retry: "billing_retry", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  auto_renew_off: { active: "canceling", canceling: "ignored", grace: "ignored", billing_retry: "ignored", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  auto_renew_on: { active: "ignored", canceling: "active", grace: "ignored", billing_retry: "ignored", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  billing_failed: { active: "grace", canceling: "grace", grace: "ignored", billing_retry: "ignored", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  grace_expired: { active: "ignored", canceling: "ignored", grace: "billing_retry", billing_retry: "ignored", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  expired: { active: "lapsed", canceling: "lapsed", grace: "lapsed", billing_retry: "lapsed", lapsed: "ignored", revoked: "ignored", purged: "ignored" },
  refunded: { active: "revoked", canceling: "revoked", grace: "revoked", billing_retry: "revoked", lapsed: "revoked", revoked: "ignored", purged: "ignored" },
  readonly_ended: { active: "ignored", canceling: "ignored", grace: "ignored", billing_retry: "ignored", lapsed: "purged", revoked: "purged", purged: "ignored" },
};

function eventOf(kind: StoreEvent["kind"]): StoreEvent {
  switch (kind) {
    case "renewed":
      return { kind, periodEndsAt: new Date("2027-01-20T10:00:00Z"), at };
    case "upgraded":
    case "downgrade_scheduled":
      return { kind, productId: "tier_300", at };
    case "billing_failed":
      return { kind, graceEndsAt: new Date("2027-01-05T10:00:00Z"), at };
    case "readonly_ended":
      return { kind, at: new Date("2027-01-01T00:00:00Z") };
    case "expired":
      return { kind, at: firstPeriodEnd };
    case "refunded":
      return { kind, periodEndsAt: firstPeriodEnd, at };
    default:
      return { kind, at };
  }
}

describe("applyStoreEvent", () => {
  for (const [kind, row] of Object.entries(TRANSITIONS) as [StoreEvent["kind"], Record<PlanState, Outcome>][]) {
    it.each(ALL_STATES)(`${kind} from %s`, (state) => {
      const plan = planIn(state);
      const next = applyStoreEvent(plan, eventOf(kind));
      if (row[state] === "ignored") expect(next).toBe(plan);
      else {
        expect(next).not.toBe(plan);
        expect(next.state).toBe(row[state]);
      }
    });
  }

  it("applies an upgrade at once and a downgrade only at the next renewal", () => {
    let plan = startPlan("tier_150", bought, firstPeriodEnd);
    plan = applyStoreEvent(plan, { kind: "upgraded", productId: "tier_300", at });
    expect(plan.productId).toBe("tier_300");

    plan = applyStoreEvent(plan, { kind: "downgrade_scheduled", productId: "tier_50", at });
    expect(plan).toMatchObject({ productId: "tier_300", pendingProductId: "tier_50" });

    plan = applyStoreEvent(plan, { kind: "renewed", periodEndsAt: new Date("2027-01-20T10:00:00Z"), at });
    expect(plan).toMatchObject({ productId: "tier_50", pendingProductId: null, periodEndsAt: new Date("2027-01-20T10:00:00Z") });
  });

  it("drops a waiting downgrade when the host upgrades instead", () => {
    let plan = applyStoreEvent(planIn("active"), { kind: "downgrade_scheduled", productId: "tier_50", at });
    plan = applyStoreEvent(plan, { kind: "upgraded", productId: "tier_600", at });
    expect(plan).toMatchObject({ productId: "tier_600", pendingProductId: null });
  });

  it("gives 30 days to download after the plan ends, 14 after a refund", () => {
    const lapsed = applyStoreEvent(planIn("active"), eventOf("expired")); // at the period end
    expect(lapsed.readonlyUntil).toEqual(new Date("2027-01-19T10:00:00Z"));
    const refunded = applyStoreEvent(planIn("active"), eventOf("refunded"));
    expect(refunded.readonlyUntil).toEqual(new Date("2026-12-15T00:00:00Z"));
  });

  it("lets a refund shorten a running download window but never lengthen it", () => {
    const lapsed = applyStoreEvent(planIn("active"), eventOf("expired")); // window ends 2027-01-19 10:00
    const refund = (at: string) => ({ kind: "refunded", periodEndsAt: firstPeriodEnd, at: new Date(at) }) as const;
    const early = applyStoreEvent(lapsed, refund("2026-12-21T00:00:00Z"));
    expect(early).toMatchObject({ state: "revoked", readonlyUntil: new Date("2027-01-04T00:00:00Z") });
    const late = applyStoreEvent(lapsed, refund("2027-01-10T00:00:00Z"));
    expect(late).toMatchObject({ state: "revoked", readonlyUntil: new Date("2027-01-19T10:00:00Z") });
  });

  it("never brings a refunded plan back, even if a renewal arrives late", () => {
    const refunded = applyStoreEvent(planIn("active"), eventOf("refunded"));
    expect(applyStoreEvent(refunded, eventOf("renewed"))).toBe(refunded);
  });

  it("ignores a stale or replayed renewal", () => {
    const renewed = applyStoreEvent(planIn("active"), eventOf("renewed"));
    expect(applyStoreEvent(renewed, eventOf("renewed"))).toBe(renewed);
    const older = { kind: "renewed", periodEndsAt: new Date("2026-12-25T00:00:00Z"), at } as const;
    expect(applyStoreEvent(renewed, older)).toBe(renewed);
    const alreadyOver = { kind: "renewed", periodEndsAt: new Date("2026-12-21T00:00:00Z"), at: new Date("2026-12-22T00:00:00Z") } as const;
    expect(applyStoreEvent(planIn("active"), alreadyOver).state).toBe("active");
    expect(applyStoreEvent(planIn("lapsed"), alreadyOver).state).toBe("lapsed");
  });

  it("ignores a late expiry of an earlier period once the plan has renewed", () => {
    const renewed = applyStoreEvent(planIn("active"), eventOf("renewed")); // now paid to 2027-01-20
    expect(applyStoreEvent(renewed, { kind: "expired", at: firstPeriodEnd })).toBe(renewed);
    expect(applyStoreEvent(renewed, { kind: "expired", at: new Date("2027-01-20T10:00:00Z") }).state).toBe("lapsed");
  });

  it("keeps the current period when an older period is refunded", () => {
    const renewed = applyStoreEvent(planIn("active"), eventOf("renewed"));
    expect(applyStoreEvent(renewed, { kind: "refunded", periodEndsAt: firstPeriodEnd, at })).toBe(renewed);
    const current = { kind: "refunded", periodEndsAt: new Date("2027-01-20T10:00:00Z"), at } as const;
    expect(applyStoreEvent(renewed, current).state).toBe("revoked");
  });

  it("doesn't raise the guest cap while a payment is failing", () => {
    expect(applyStoreEvent(planIn("grace"), eventOf("upgraded")).productId).toBe("tier_150");
    expect(applyStoreEvent(planIn("billing_retry"), eventOf("upgraded")).productId).toBe("tier_150");
  });

  it("keeps its own copy of the dates it is given", () => {
    const purchase = new Date(bought.getTime());
    const plan = startPlan("tier_50", purchase, firstPeriodEnd);
    purchase.setUTCFullYear(2000);
    expect(plan.startedAt).toEqual(bought);
  });

  it("restores an ended plan renewed before its data was deleted", () => {
    const lapsed = applyStoreEvent(planIn("active", { pendingProductId: "tier_50" }), eventOf("expired"));
    expect(lapsed.pendingProductId).toBeNull();
    const back = applyStoreEvent(lapsed, eventOf("renewed"));
    expect(back).toMatchObject({ state: "active", productId: "tier_150", readonlyUntil: null, startedAt: bought });
  });

  it("deletes only once the download window is over", () => {
    const lapsed = planIn("lapsed");
    expect(applyStoreEvent(lapsed, { kind: "readonly_ended", at: new Date("2026-12-31T23:59:59Z") }).state).toBe("lapsed");
    expect(applyStoreEvent(lapsed, { kind: "readonly_ended", at: new Date("2027-01-01T00:00:00Z") }).state).toBe("purged");
  });

  it("is safe to apply the same event twice", () => {
    const once = applyStoreEvent(planIn("active"), eventOf("expired"));
    expect(applyStoreEvent(once, { kind: "expired", at: new Date("2026-12-10T00:00:00Z") })).toBe(once);
  });

  it("walks a whole life: buy, cancel, fail, grace, retry, end, delete", () => {
    let plan = startPlan("tier_50", bought, firstPeriodEnd);
    const steps: [StoreEvent, PlanState][] = [
      [{ kind: "auto_renew_off", at }, "canceling"],
      [{ kind: "auto_renew_on", at }, "active"],
      [{ kind: "billing_failed", graceEndsAt: new Date("2027-01-05T10:00:00Z"), at }, "grace"],
      [{ kind: "grace_expired", at }, "billing_retry"],
      [{ kind: "expired", at: firstPeriodEnd }, "lapsed"],
      [{ kind: "readonly_ended", at: new Date("2027-01-19T10:00:00Z") }, "purged"],
    ];
    for (const [event, state] of steps) {
      plan = applyStoreEvent(plan, event);
      expect(plan.state, event.kind).toBe(state);
    }
  });
});

describe("planAccess", () => {
  const now = new Date("2026-12-10T00:00:00Z");

  it.each([
    ["active", true, true, true, true, true],
    ["canceling", true, true, true, true, true],
    ["grace", true, true, true, true, true],
    ["billing_retry", false, true, false, true, true],
    ["lapsed", false, false, false, false, true],
    ["revoked", false, false, false, false, true],
    ["purged", false, false, false, false, false],
  ] as const)("%s: share %s, view %s, edit %s, moderate %s, download %s", (state, share, view, edit, moderate, download) => {
    expect(planAccess(planIn(state), now)).toEqual({
      guestsCanShare: share,
      guestsCanView: view,
      hostCanEdit: edit,
      hostCanModerate: moderate,
      hostCanDownload: download,
    });
  });

  it("lets the host download until the window closes, even before the purge runs", () => {
    const lapsed = planIn("lapsed", { readonlyUntil: new Date("2026-12-31T00:00:00Z") });
    expect(planAccess(lapsed, new Date("2026-12-30T23:59:59Z")).hostCanDownload).toBe(true);
    expect(planAccess(lapsed, new Date("2026-12-31T00:00:00Z")).hostCanDownload).toBe(false);
  });

  it("stops a cancelled plan at the end of what was paid, even without an expiry notice", () => {
    const canceling = planIn("canceling");
    expect(planAccess(canceling, new Date("2026-12-20T09:59:59Z")).guestsCanShare).toBe(true);
    expect(planAccess(canceling, new Date("2026-12-20T10:00:00Z"))).toMatchObject({
      guestsCanShare: false,
      guestsCanView: false,
      hostCanDownload: true,
    });
  });

  it("stops full service when Apple's grace period ends, even without a notice", () => {
    const grace = planIn("grace");
    expect(planAccess(grace, new Date("2027-01-05T09:59:59Z")).guestsCanShare).toBe(true);
    expect(planAccess(grace, new Date("2027-01-05T10:00:00Z"))).toMatchObject({ guestsCanShare: false, guestsCanView: true });
  });

  it("waits a little for a renewal to be confirmed, then stops new uploads", () => {
    const active = planIn("active");
    expect(planAccess(active, new Date("2026-12-22T09:59:59Z")).guestsCanShare).toBe(true);
    expect(planAccess(active, new Date("2026-12-22T10:00:00Z"))).toMatchObject({ guestsCanShare: false, guestsCanView: true });
  });

  it("can't be changed by a caller", () => {
    const access = planAccess(planIn("active"), now);
    expect(() => Object.assign(access, { guestsCanShare: false })).toThrow();
  });
});

describe("dates", () => {
  it.each([
    ["2026-11-20T10:00:00Z", "2026-12-20T10:00:00Z"],
    ["2026-01-31T08:00:00Z", "2026-02-28T08:00:00Z"],
    ["2028-01-31T08:00:00Z", "2028-02-29T08:00:00Z"],
    ["2026-12-31T23:30:00Z", "2027-01-31T23:30:00Z"],
    ["2026-03-31T00:00:00Z", "2026-04-30T00:00:00Z"],
  ])("one month after %s is %s", (from, to) => {
    expect(addOneMonth(new Date(from))).toEqual(new Date(to));
  });

  it("keeps the test event live one month from purchase, its media a week longer", () => {
    expect(testEventDates(startPlan("tier_50", bought, firstPeriodEnd))).toEqual({
      closesAt: new Date("2026-12-20T10:00:00Z"),
      purgeAt: new Date("2026-12-27T10:00:00Z"),
    });
  });

  it("doesn't change the date it was given", () => {
    const date = new Date("2026-01-31T08:00:00Z");
    addOneMonth(date);
    expect(date).toEqual(new Date("2026-01-31T08:00:00Z"));
  });
});

describe("overdueEvent", () => {
  it("ends a cancelled plan at its period end when Apple's notice never came", () => {
    const canceling = planIn("canceling");
    expect(overdueEvent(canceling, new Date("2026-12-20T09:59:59Z"))).toBeNull();
    const event = overdueEvent(canceling, new Date("2026-12-25T00:00:00Z"));
    expect(event).toEqual({ kind: "expired", at: firstPeriodEnd });
    const lapsed = applyStoreEvent(canceling, event!);
    expect(lapsed).toMatchObject({ state: "lapsed", readonlyUntil: new Date("2027-01-19T10:00:00Z") });
  });

  it("deletes once the download window is over, so data never stays forever", () => {
    const lapsed = planIn("lapsed");
    expect(overdueEvent(lapsed, new Date("2026-12-31T23:59:59Z"))).toBeNull();
    const event = overdueEvent(lapsed, new Date("2027-01-02T00:00:00Z"));
    expect(event && applyStoreEvent(lapsed, event).state).toBe("purged");
  });

  it("leaves every other case to Apple", () => {
    const late = new Date("2027-06-01T00:00:00Z");
    for (const state of ["active", "grace", "billing_retry", "purged"] as const) {
      expect(overdueEvent(planIn(state), late), state).toBeNull();
    }
  });
});
