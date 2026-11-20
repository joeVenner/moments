import { FULL_ACCESS, NO_ACCESS, planAccess, type PlanAccess } from "./plans";
import { loadLivePlan } from "./plansRepo";
import type { LiveEventRef } from "./events";
import type { EventRow } from "./types";

type PlanEventRef = Pick<EventRow, "kind" | "owner_user_id">;

/** Whether a host's plan pays for this event (main or test), so its rules apply. */
export function isPlanEvent(event: Pick<EventRow, "kind">): boolean {
  return event.kind === "main" || event.kind === "test";
}

/**
 * What guests and the host may do in this event right now. Events no plan
 * pays for keep today's behaviour; a plan event follows its owner's plan,
 * and one whose plan is gone allows nothing.
 */
export async function eventPlanAccess(db: D1Database, event: PlanEventRef, now: Date = new Date()): Promise<PlanAccess> {
  if (event.kind === "legacy" || event.kind === "operator") return FULL_ACCESS;
  // Anything else is paid for by a plan; an unknown kind fails closed.
  if (!isPlanEvent(event) || !event.owner_user_id) return NO_ACCESS;
  const stored = await loadLivePlan(db, event.owner_user_id);
  return stored ? planAccess(stored.plan, now) : NO_ACCESS;
}

/** What guests get once the plan behind an event no longer lets them see it. */
export const EVENT_NOT_HOSTED = { error: "This event is no longer hosted.", code: "event_not_hosted" } as const;

/** Whether guests may open the event and see its moments now. */
export async function canGuestsView(db: D1Database, event: PlanEventRef, now: Date = new Date()): Promise<boolean> {
  return (await eventPlanAccess(db, event, now)).guestsCanView;
}

/** Whether guests may start sharing new moments now (the event's own dates are checked separately). */
export async function canGuestsShare(db: D1Database, event: PlanEventRef, now: Date = new Date()): Promise<boolean> {
  return (await eventPlanAccess(db, event, now)).guestsCanShare;
}

/** Whether a web guest may start a new upload: the event's dates, then its plan. */
export async function canStartWebUpload(db: D1Database, event: LiveEventRef): Promise<boolean> {
  return event.uploads_open === 1 && (await canGuestsShare(db, event));
}

/**
 * The settings to resolve a web uploader with. In a plan event only a guest
 * who joined (and so holds a token) may upload, as if GUEST_TOKENS_ENFORCED
 * were set: otherwise skipping the join step would get round the guest cap.
 * resolveWebUploader reads that flag, so this is how the requirement reaches it.
 */
export function webUploaderEnv<T extends { GUEST_TOKENS_ENFORCED?: string }>(env: T, event: Pick<EventRow, "kind">): T {
  return isPlanEvent(event) ? { ...env, GUEST_TOKENS_ENFORCED: "true" } : env;
}
