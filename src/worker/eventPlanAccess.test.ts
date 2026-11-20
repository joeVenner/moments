import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { canGuestsShare, eventPlanAccess, isPlanEvent, webUploaderEnv } from "./eventPlanAccess";
import { addDays, startPlan } from "./plans";
import { insertPlan } from "./plansRepo";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

const HOST = "aaaaaaaa-0000-4000-8000-000000000001";
let sqlite: SqliteD1;

type Kind = "legacy" | "operator" | "main" | "test";

function seedEvent(id: string, kind: Kind, owner: string | null = HOST) {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, kind, owner_user_id) VALUES (?, ?, 'E', 'Party', ?, ?)")
    .run(id, id, kind, owner);
}

function buyPlan() {
  return insertPlan(sqlite.db, HOST, startPlan("host_50", new Date(), addDays(new Date(), 30)));
}

const setPlanState = (id: string, state: string) =>
  sqlite.raw.prepare("UPDATE plans SET state = ? WHERE id = ?").run(state, id);

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(HOST);
});

describe("eventPlanAccess", () => {
  it("leaves events no plan pays for fully open", async () => {
    for (const kind of ["legacy", "operator"] as const) {
      expect(await canGuestsShare(sqlite.db, { kind, owner_user_id: null })).toBe(true);
    }
  });

  it("lets guests share in a plan event while the plan is paid", async () => {
    await buyPlan();
    for (const kind of ["main", "test"] as const) {
      expect(await canGuestsShare(sqlite.db, { kind, owner_user_id: HOST })).toBe(true);
    }
  });

  it("stops sharing but keeps viewing while a payment is being retried", async () => {
    const { id } = await buyPlan();
    setPlanState(id, "billing_retry");
    const access = await eventPlanAccess(sqlite.db, { kind: "main", owner_user_id: HOST });
    expect(access.guestsCanShare).toBe(false);
    expect(access.guestsCanView).toBe(true);
  });

  it("fails closed for a kind it doesn't know", async () => {
    const unknown = { kind: "future" as never, owner_user_id: HOST };
    expect((await eventPlanAccess(sqlite.db, unknown)).guestsCanView).toBe(false);
  });

  it("allows nothing in a plan event without a plan or an owner", async () => {
    expect((await eventPlanAccess(sqlite.db, { kind: "main", owner_user_id: HOST })).guestsCanView).toBe(false);
    expect(await canGuestsShare(sqlite.db, { kind: "test", owner_user_id: null })).toBe(false);
  });

  it("follows the plan's dates, not only its state", async () => {
    await buyPlan();
    const later = addDays(new Date(), 60);
    expect(await canGuestsShare(sqlite.db, { kind: "main", owner_user_id: HOST }, later)).toBe(false);
  });
});

describe("webUploaderEnv", () => {
  it("requires a guest token only in plan events", () => {
    const env = { GUEST_TOKENS_ENFORCED: undefined };
    expect(webUploaderEnv(env, { kind: "main" }).GUEST_TOKENS_ENFORCED).toBe("true");
    expect(webUploaderEnv(env, { kind: "test" }).GUEST_TOKENS_ENFORCED).toBe("true");
    expect(webUploaderEnv(env, { kind: "legacy" })).toBe(env);
    expect(isPlanEvent({ kind: "operator" })).toBe(false);
  });
});

describe("web upload routes", () => {
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

  function postMoment(slug: string) {
    const body = new FormData();
    body.set("uploader_name", "Sara");
    return worker.fetch(
      new Request(`https://moments.test/api/events/${slug}/moments`, {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.9" },
        body,
      }),
      env(),
      ctx()
    );
  }

  it("refuse new uploads once the plan stops paying for sharing", async () => {
    const { id } = await buyPlan();
    setPlanState(id, "billing_retry");
    seedEvent("main", "main");
    const response = await postMoment("main");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "uploads_closed" });
  });

  it("refuse a tokenless upload to a plan event, so skipping the join can't get past the guest cap", async () => {
    await buyPlan();
    seedEvent("main", "main");
    const response = await postMoment("main");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "guest_required" });
  });

  it("keep tokenless uploads to events from before plans unchanged", async () => {
    seedEvent("old", "legacy", null);
    const response = await postMoment("old");
    // Past the uploader check: refused only for the missing file.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "file is required" });
  });
});
