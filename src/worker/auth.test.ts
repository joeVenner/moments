import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireAdmin } from "./auth";
import type { Env } from "./types";

function makeApp(limiterSuccess = true) {
  const limit = vi.fn().mockResolvedValue({ success: limiterSuccess });
  const env: Partial<Env> = {
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit },
  };
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requireAdmin);
  app.get("/protected", (c) => c.json({ ok: true }));
  return { app, env: env as Env, limit };
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

describe("requireAdmin", () => {
  it("allows a request through with valid credentials, without touching the limiter", async () => {
    const { app, env, limit } = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { Authorization: basicAuth("admin", "secret") } },
      env,
    );
    expect(res.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });

  it("rejects a missing Authorization header with 401 and counts it against the limiter", async () => {
    const { app, env, limit } = makeApp();
    const res = await app.request("/protected", {}, env);
    expect(res.status).toBe(401);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong credentials with 401", async () => {
    const { app, env, limit } = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { Authorization: basicAuth("admin", "wrong") } },
      env,
    );
    expect(res.status).toBe(401);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("returns 401, not 500, for a malformed Basic header", async () => {
    const { app, env } = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { Authorization: "Basic not-valid-base64!!!" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 once the limiter rejects the client", async () => {
    const { app, env } = makeApp(false);
    const res = await app.request("/protected", {}, env);
    expect(res.status).toBe(429);
  });
});
