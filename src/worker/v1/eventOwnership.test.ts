import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { ADMIN_EVENTS_LIMIT } from "../adminEvents";
import { OPERATOR_USER_ID } from "../hostSessions";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { OPENAPI_CONFIG, v1 } from "./index";
import { AdminEventDetailSchema, AdminEventListSchema, ErrorSchema, HostSignInResponseSchema } from "./schemas";

const HOST_A = "aaaaaaaa-0000-4000-8000-000000000001";
const HOST_B = "bbbbbbbb-0000-4000-8000-000000000002";
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

function call(path: string, token: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const headers = { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` };
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, { ...init, headers }), env(), ctx);
}

/** A live session for a user: the operator signs in, then it is handed over. */
async function sessionFor(userId: string): Promise<string> {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const response = await worker.fetch(
    new Request("https://moments.test/api/v1/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ username: "admin", password: "secret-password" }),
    }),
    env(),
    ctx
  );
  const { token } = HostSignInResponseSchema.parse(await response.json());
  sqlite.raw.prepare("UPDATE host_sessions SET user_id = ? WHERE user_id IS NOT ?").run(userId, userId);
  return token;
}

function seedEvent(id: string, owner: string) {
  sqlite.raw
    .prepare("INSERT INTO events (id, slug, title, type, owner_user_id) VALUES (?, ?, ?, 'Party', ?)")
    .run(id, `slug-${id}`, `Event ${id}`, owner);
  sqlite.raw
    .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES (?, ?, 'Sara', ?)")
    .run(`m-${id}`, id, `/media/events/${id}/m`);
}

beforeEach(() => {
  sqlite = createSqliteD1();
  const user = sqlite.raw.prepare("INSERT INTO users (id, role) VALUES (?, 'host')");
  user.run(HOST_A);
  user.run(HOST_B);
  seedEvent("a1", HOST_A);
  seedEvent("b1", HOST_B);
  seedEvent("op", OPERATOR_USER_ID);
});

describe("event ownership on the host API", () => {
  it("lists only the host's own events", async () => {
    const response = await call("/admin/events", await sessionFor(HOST_A));
    expect(AdminEventListSchema.parse(await response.json()).events.map((event) => event.id)).toEqual(["a1"]);
  });

  it("lets the operator see every event", async () => {
    const response = await call("/admin/events", await sessionFor(OPERATOR_USER_ID));
    const ids = AdminEventListSchema.parse(await response.json()).events.map((event) => event.id);
    expect(ids.sort()).toEqual(["a1", "b1", "op"]);
    expect((await call("/admin/events/b1", await sessionFor(OPERATOR_USER_ID))).status).toBe(200);
  });

  it("opens the host's own event", async () => {
    const response = await call("/admin/events/a1", await sessionFor(HOST_A));
    expect(response.status).toBe(200);
    expect(AdminEventDetailSchema.parse(await response.json()).event).not.toHaveProperty("owner_user_id");
  });

  const foreignEventRoutes: [string, string, RequestInit][] = [
    ["read the event", "/admin/events/b1", {}],
    ["list its moments", "/admin/events/b1/moments", {}],
    ["edit it", "/admin/events/b1", { method: "PATCH", body: JSON.stringify({ title: "Mine now" }) }],
    ["make it public", "/admin/events/b1/access", { method: "PATCH", body: JSON.stringify({ mode: "public" }) }],
    [
      "change its dates",
      "/admin/events/b1/lifecycle",
      { method: "PATCH", body: JSON.stringify({ purge_after: "2099-01-01 00:00:00" }) },
    ],
  ];

  it.each(foreignEventRoutes)("refuses to %s for another host, as if it didn't exist", async (_name, path, init) => {
    const response = await call(path, await sessionFor(HOST_A), init);
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).code).toBe("event_not_found");
    expect(sqlite.raw.prepare("SELECT title, purge_after FROM events WHERE id = 'b1'").get()).toEqual({
      title: "Event b1",
      purge_after: null,
    });
  });

  const foreignMomentRoutes: [string, RequestInit][] = [
    ["hide", { method: "PATCH", body: JSON.stringify({ status: "hidden" }) }],
    ["delete", { method: "DELETE" }],
  ];

  it.each(foreignMomentRoutes)("refuses to %s another host's moment", async (_name, init) => {
    const response = await call("/admin/moments/m-b1", await sessionFor(HOST_A), init);
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).code).toBe("moment_not_found");
    expect(sqlite.raw.prepare("SELECT moderation_status FROM moments WHERE id = 'm-b1'").get()).toEqual({
      moderation_status: "approved",
    });
  });

  it("lets a host moderate their own moment", async () => {
    const response = await call("/admin/moments/m-a1", await sessionFor(HOST_A), {
      method: "PATCH",
      body: JSON.stringify({ status: "hidden" }),
    });
    expect(response.status).toBe(200);
  });

  it("gives a new event to the host who created it", async () => {
    const response = await call("/admin/events", await sessionFor(HOST_A), {
      method: "POST",
      body: JSON.stringify({ title: "Garden party", type: "Party" }),
    });
    expect(response.status).toBe(201);
    const { event } = AdminEventDetailSchema.parse(await response.json());
    expect(sqlite.raw.prepare("SELECT owner_user_id FROM events WHERE id = ?").get(event.id)).toEqual({ owner_user_id: HOST_A });
  });

  it("keeps an event without an owner to the operator", async () => {
    sqlite.raw.prepare("UPDATE events SET owner_user_id = NULL WHERE id = 'a1'").run();
    expect((await call("/admin/events/a1", await sessionFor(HOST_A))).status).toBe(404);
    expect((await call("/admin/events/a1", await sessionFor(OPERATOR_USER_ID))).status).toBe(200);
  });

  it("checks the owner on every host route that takes an id, including new ones", async () => {
    const token = await sessionFor(HOST_A);
    const paths = v1.getOpenAPI31Document(OPENAPI_CONFIG).paths ?? {};
    const checked: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      if (!path.includes("/admin/") || !path.includes("{id}")) continue;
      const foreignId = path.includes("/moments/{id}") && !path.includes("/events/") ? "m-b1" : "b1";
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        if (!item?.[method]) continue;
        const url = path.replace(/^\/api\/v1/, "").replace("{id}", foreignId);
        const init: RequestInit = { method: method.toUpperCase() };
        if (method !== "get" && method !== "delete") init.body = "{}";
        const response = await call(url, token, init);
        expect(response.status, `${method.toUpperCase()} ${path}`).toBe(404);
        checked.push(`${method} ${path}`);
      }
    }
    // Guards the guard: the walk must actually find the routes.
    expect(checked.length).toBeGreaterThanOrEqual(7);
  });

  it("still answers 400 for an id too long to be one", async () => {
    const response = await call(`/admin/events/${"x".repeat(101)}`, await sessionFor(HOST_A));
    expect(response.status).toBe(400);
  });

  it("lets any host read their own session", async () => {
    expect((await call("/admin/session", await sessionFor(HOST_A))).status).toBe(200);
  });

  it("counts only the host's own events toward the list cap", async () => {
    const insert = sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, owner_user_id) VALUES (?, ?, 'E', 'Party', ?)");
    for (let index = 0; index <= ADMIN_EVENTS_LIMIT; index++) insert.run(`x${index}`, `sx${index}`, HOST_B);
    const response = await call("/admin/events", await sessionFor(HOST_A));
    expect(AdminEventListSchema.parse(await response.json())).toMatchObject({ truncated: false, events: [{ id: "a1" }] });
  });
});
