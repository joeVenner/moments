import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { OPERATOR_USER_ID } from "../hostSessions";
import { addDays, startPlan } from "../plans";
import { insertPlan } from "../plansRepo";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { ErrorSchema, HostSignInResponseSchema } from "./schemas";

const HOST = "aaaaaaaa-0000-4000-8000-000000000001";
let sqlite: SqliteD1;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: { delete: vi.fn(async () => undefined) } as unknown as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret-password",
    ADMIN_AUTH_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit,
    EVENT_ACCESS_SECRET: "test-access-secret-123",
  };
}

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

function call(path: string, token: string, init: RequestInit = {}) {
  const headers = { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` };
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, { ...init, headers }), env(), ctx());
}

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

function seedEvent(kind: "legacy" | "main") {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, kind, owner_user_id) VALUES ('e1', 'party', 'Party', 'Party', ?, ?)")
    .run(kind, HOST);
  sqlite.raw
    .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('m1', 'e1', 'Sara', '/media/events/e1/m')")
    .run();
}

/** A plan in the given state; `readonlyUntil` only matters once it has ended. */
async function plan(state: string, readonlyUntil: Date | null = null) {
  const { id } = await insertPlan(sqlite.db, HOST, startPlan("host_50", new Date(), addDays(new Date(), 30)));
  sqlite.raw
    .prepare("UPDATE plans SET state = ?, readonly_until = ? WHERE id = ?")
    .run(state, readonlyUntil ? readonlyUntil.toISOString().slice(0, 19).replace("T", " ") : null, id);
}

const ROUTES = {
  read: ["/admin/events/e1", {}],
  moments: ["/admin/events/e1/moments", {}],
  edit: ["/admin/events/e1", { method: "PATCH", body: JSON.stringify({ title: "New" }) }],
  access: ["/admin/events/e1/access", { method: "PATCH", body: JSON.stringify({ mode: "public" }) }],
  dates: ["/admin/events/e1/lifecycle", { method: "PATCH", body: JSON.stringify({ purge_after: "2099-01-01T00:00:00Z" }) }],
  hide: ["/admin/moments/m1", { method: "PATCH", body: JSON.stringify({ status: "hidden" }) }],
  delete: ["/admin/moments/m1", { method: "DELETE" }],
} satisfies Record<string, [string, RequestInit]>;
type RouteName = keyof typeof ROUTES;

/** Status of each route, called in this order (delete last: it removes the moment). */
async function statuses(token: string, names: RouteName[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const name of names) {
    const [path, init] = ROUTES[name];
    const response = await call(path, token, init);
    result[name] = response.status;
    if (response.status === 402) expect(ErrorSchema.parse(await response.json()).code).toBe("plan_required");
  }
  return result;
}

const ALL: RouteName[] = ["read", "moments", "edit", "access", "dates", "hide", "delete"];

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')").run(HOST);
});

describe("host routes on a plan event follow the host's plan", () => {
  it("allow everything while the plan is paid", async () => {
    await plan("active");
    seedEvent("main");
    expect(await statuses(await sessionFor(HOST), ALL)).toEqual({
      read: 200, moments: 200, edit: 200, access: 200, dates: 200, hide: 200, delete: 204,
    });
  });

  it("keep reading and moderating, but not editing, while a payment is retried", async () => {
    await plan("billing_retry");
    seedEvent("main");
    expect(await statuses(await sessionFor(HOST), ALL)).toEqual({
      read: 200, moments: 200, edit: 402, access: 402, dates: 402, hide: 200, delete: 204,
    });
  });

  it("only let a lapsed host download until the read-only window ends", async () => {
    await plan("lapsed", addDays(new Date(), 10));
    seedEvent("main");
    expect(await statuses(await sessionFor(HOST), ALL)).toEqual({
      read: 200, moments: 200, edit: 402, access: 402, dates: 402, hide: 402, delete: 402,
    });
  });

  it("refuse everything once the read-only window is over", async () => {
    await plan("lapsed", addDays(new Date(), -1));
    seedEvent("main");
    expect(await statuses(await sessionFor(HOST), ALL)).toEqual({
      read: 402, moments: 402, edit: 402, access: 402, dates: 402, hide: 402, delete: 402,
    });
    expect(sqlite.raw.prepare("SELECT title FROM events WHERE id = 'e1'").get()).toEqual({ title: "Party" });
  });

  it("refuse everything to a host with no plan at all", async () => {
    seedEvent("main");
    expect(await statuses(await sessionFor(HOST), ["read", "edit", "hide"])).toEqual({ read: 402, edit: 402, hide: 402 });
  });

  it("leave events from before plans alone", async () => {
    seedEvent("legacy");
    expect(await statuses(await sessionFor(HOST), ["read", "edit", "hide"])).toEqual({ read: 200, edit: 200, hide: 200 });
  });

  it("let the operator act on any event, whatever its plan", async () => {
    seedEvent("main");
    expect(await statuses(await sessionFor(OPERATOR_USER_ID), ["read", "edit", "hide"])).toEqual({
      read: 200, edit: 200, hide: 200,
    });
  });

  it("still answer 404 for another host's event before looking at any plan", async () => {
    sqlite.raw.prepare("INSERT INTO users (id, role) VALUES ('bbbbbbbb-0000-4000-8000-000000000002', 'host')").run();
    seedEvent("main");
    const token = await sessionFor("bbbbbbbb-0000-4000-8000-000000000002");
    expect(await statuses(token, ["read", "hide"])).toEqual({ read: 404, hide: 404 });
  });
});
