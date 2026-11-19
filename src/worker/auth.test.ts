import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ADMIN_FAILURES_PER_CLIENT } from "./adminLogin";
import { requireAdmin } from "./auth";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;

function makeApp() {
  const env = { DB: sqlite.db, ADMIN_USER: "admin", ADMIN_PASSWORD: "secret" } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requireAdmin);
  app.get("/protected", (c) => c.json({ ok: true }));
  return { app, env };
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

function get(authorization?: string, ip = "198.51.100.4") {
  const { app, env } = makeApp();
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (authorization) headers.Authorization = authorization;
  return app.request("/protected", { headers }, env);
}

const failures = () => (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM admin_login_failures").get() as { n: number }).n;

beforeEach(() => {
  sqlite = createSqliteD1();
});

describe("requireAdmin", () => {
  it("lets valid credentials through and leaves no failure behind", async () => {
    const res = await get(basicAuth("admin", "secret"));
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
  });

  it("asks for credentials without counting a request that sent none", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Moments Admin"');
    expect(failures()).toBe(0);
  });

  it("counts wrong credentials", async () => {
    const res = await get(basicAuth("admin", "wrong"));
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
  });

  it("returns 401, not 500, for a malformed Basic header", async () => {
    expect((await get("Basic not-valid-base64!!!")).status).toBe(401);
    expect((await get(`Basic ${btoa("no-separator")}`)).status).toBe(401);
  });

  it("once locked, refuses the right password too, then counts nothing for it", async () => {
    for (let index = 0; index < MAX_ADMIN_FAILURES_PER_CLIENT; index++) {
      expect((await get(basicAuth("admin", `guess-${index}`))).status).toBe(401);
    }
    const right = await get(basicAuth("admin", "secret"));
    expect(right.status).toBe(429);
    expect(right.headers.get("Retry-After")).toBe("900");
    expect(failures()).toBe(MAX_ADMIN_FAILURES_PER_CLIENT);
    // Another client is unaffected below the overall limit.
    expect((await get(basicAuth("admin", "secret"), "203.0.113.9")).status).toBe(200);
  });
});
