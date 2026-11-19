import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { ErrorSchema, HostSessionSchema, HostSignInResponseSchema } from "./schemas";

let sqlite: SqliteD1;
let limiter: { limit: ReturnType<typeof vi.fn> };
let extraEnv: Partial<Env>;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret-password",
    ADMIN_AUTH_LIMITER: limiter as unknown as RateLimit,
    EVENT_ACCESS_SECRET: "test-access-secret-123",
    ...extraEnv,
  };
}

function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, init), env(), ctx);
}

function signIn(body: unknown, headers: Record<string, string> = {}) {
  return call("/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}

function withToken(token: string, method = "GET") {
  return call("/admin/session", { method, headers: { Authorization: `Bearer ${token}` } });
}

async function signedInToken(): Promise<string> {
  const response = await signIn({ username: "admin", password: "secret-password" });
  return HostSignInResponseSchema.parse(await response.json()).token;
}

beforeEach(() => {
  sqlite = createSqliteD1();
  limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
  extraEnv = {};
});

describe("POST /api/v1/admin/session", () => {
  it("signs in with the admin credentials and returns the token once", async () => {
    const response = await signIn({ username: "admin", password: "secret-password" });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(HostSignInResponseSchema.strict().parse(body)).toMatchObject({ token_type: "Bearer", subject: "operator" });
    expect(limiter.limit).toHaveBeenCalledWith({ key: "host-sign-in:203.0.113.7" });
  });

  it("refuses wrong credentials without saying which part was wrong", async () => {
    for (const body of [
      { username: "admin", password: "wrong" },
      { username: "root", password: "secret-password" },
    ]) {
      const response = await signIn(body);
      expect(response.status).toBe(401);
      expect(ErrorSchema.parse(await response.json())).toEqual({ error: "Wrong username or password.", code: "invalid_credentials" });
    }
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM host_sessions").get()).toEqual({ n: 0 });
  });

  it("is limited before the password is checked, so a limited client learns nothing", async () => {
    limiter.limit.mockResolvedValue({ success: false });
    const response = await signIn({ username: "admin", password: "secret-password" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(ErrorSchema.parse(await response.json()).code).toBe("rate_limited");
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM host_sessions").get()).toEqual({ n: 0 });
  });

  it.each([
    [{}],
    [{ username: "admin" }],
    [{ username: "", password: "x" }],
    [{ username: "admin", password: "x".repeat(1025) }],
    [{ username: 1, password: "x" }],
  ])("rejects a malformed body %j", async (body) => {
    const response = await signIn(body);
    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(await response.json()).code).toBe("invalid_request");
  });

  it("is unavailable, not open, when the secret is missing", async () => {
    extraEnv = { EVENT_ACCESS_SECRET: undefined };
    const response = await signIn({ username: "admin", password: "secret-password" });
    expect(response.status).toBe(503);
    expect(ErrorSchema.parse(await response.json()).code).toBe("sign_in_unavailable");
  });

  it("honours the app version gate", async () => {
    extraEnv = { MIN_IOS_BUILD: "10" };
    const response = await signIn({ username: "admin", password: "secret-password" }, { "X-Client": "ios/1.0(3)" });
    expect(response.status).toBe(426);
  });
});

describe("GET and DELETE /api/v1/admin/session", () => {
  it("reports the live session, then stops working after sign-out", async () => {
    const token = await signedInToken();
    const live = await withToken(token);
    expect(live.status).toBe(200);
    expect(HostSessionSchema.strict().parse(await live.json()).subject).toBe("operator");

    expect((await withToken(token, "DELETE")).status).toBe(204);
    const after = await withToken(token);
    expect(after.status).toBe(401);
    expect((await withToken(token, "DELETE")).status).toBe(401);
  });

  it("asks for a bearer token when none or a bad one is sent", async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: "Basic YWRtaW46c2VjcmV0LXBhc3N3b3Jk" }, { Authorization: "Bearer nope" }]) {
      const response = await call("/admin/session", { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="Moments"');
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(ErrorSchema.parse(await response.json()).code).toBe("host_auth_required");
    }
  });

  it("logs every session out when the admin password changes", async () => {
    const token = await signedInToken();
    extraEnv = { ADMIN_PASSWORD: "rotated-password" };
    expect((await withToken(token)).status).toBe(401);
  });

  it("doesn't treat another spelling of the sign-in path as sign-in", async () => {
    const response = await call("/admin/session/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret-password" }),
    });
    expect(response.status).toBe(401);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it("refuses sign-out without a session, with the bearer challenge", async () => {
    const response = await call("/admin/session", { method: "DELETE" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="Moments"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("guards every other /admin path too", async () => {
    const response = await call("/admin/events");
    expect(response.status).toBe(401);
    expect(ErrorSchema.parse(await response.json()).code).toBe("host_auth_required");
  });
});
