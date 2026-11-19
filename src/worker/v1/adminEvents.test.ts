import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { AdminEventListSchema, ErrorSchema, HostSignInResponseSchema } from "./schemas";

let sqlite: SqliteD1;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret-password",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } as unknown as RateLimit,
    EVENT_ACCESS_SECRET: "test-access-secret-123",
  };
}

function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, init), env(), ctx);
}

async function token(): Promise<string> {
  const response = await call("/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ username: "admin", password: "secret-password" }),
  });
  return HostSignInResponseSchema.parse(await response.json()).token;
}

function insertEvent(id: string, createdAt: string, accessMode = "public", cover: string | null = null) {
  sqlite.raw
    .prepare(
      `INSERT INTO events (id, slug, title, type, access_mode, cover_image_url, created_at, invite_token, access_pin_hash)
       VALUES (?, ?, ?, 'Party', ?, ?, ?, 'invite-secret-' || ?, 'pin-hash')`
    )
    .run(id, `slug-${id}`, `Event ${id}`, accessMode, cover, createdAt, id);
}

beforeEach(() => {
  sqlite = createSqliteD1();
});

describe("GET /api/v1/admin/events", () => {
  it("needs a host session", async () => {
    const response = await call("/admin/events");
    expect(response.status).toBe(401);
    expect(ErrorSchema.parse(await response.json()).code).toBe("host_auth_required");
  });

  it("answers an empty list when there are no events", async () => {
    const response = await call("/admin/events", { headers: { Authorization: `Bearer ${await token()}` } });
    expect(AdminEventListSchema.parse(await response.json())).toEqual({ events: [], truncated: false });
  });

  it("counts hidden moments too", async () => {
    insertEvent("e", "2026-01-01 10:00:00");
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, moderation_status) VALUES ('h', 'e', 'Sara', '/media/h', 'hidden')")
      .run();
    const response = await call("/admin/events", { headers: { Authorization: `Bearer ${await token()}` } });
    expect(AdminEventListSchema.parse(await response.json()).events[0].moment_count).toBe(1);
  });

  it("lists every event newest first with counts, and no secrets", async () => {
    insertEvent("old", "2026-01-01 10:00:00");
    insertEvent("new", "2026-06-01 10:00:00");
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('m1', 'old', 'Sara', '/media/x')").run();
    sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES ('p1', 'old', 'Sara')").run();
    sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES ('p2', 'old', 'Omar')").run();

    const response = await call("/admin/events", { headers: { Authorization: `Bearer ${await token()}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toMatch(/invite-secret|pin-hash|access_version|invite_token/);
    const { events } = AdminEventListSchema.strict().parse(JSON.parse(raw));
    expect(events.map((event) => event.id)).toEqual(["new", "old"]);
    expect(events[1]).toMatchObject({ moment_count: 1, participant_count: 2 });
    expect(events[0]).toMatchObject({ moment_count: 0, participant_count: 0 });
  });

  it("signs a private event's cover so the app can load it", async () => {
    insertEvent("priv", "2026-06-01 10:00:00", "private", "/media/events/priv/cover");
    insertEvent("pub", "2026-05-01 10:00:00", "public", "/media/events/pub/cover");
    const response = await call("/admin/events", { headers: { Authorization: `Bearer ${await token()}` } });
    const { events } = AdminEventListSchema.parse(await response.json());
    expect(events[0].cover_image_url).toMatch(/^\/media\/events\/priv\/cover\?at=/);
    expect(events[1].cover_image_url).toBe("/media/events/pub/cover");
  });
});

describe("listAdminEvents", () => {
  it("says when the cap left events out", async () => {
    const { ADMIN_EVENTS_LIMIT, listAdminEvents } = await import("../adminEvents");
    const insert = sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_mode) VALUES (?, ?, 'E', 'Party', 'public')");
    for (let index = 0; index <= ADMIN_EVENTS_LIMIT; index++) insert.run(`e${index}`, `s${index}`);
    const result = await listAdminEvents(sqlite.db, undefined);
    expect(result.events).toHaveLength(ADMIN_EVENTS_LIMIT);
    expect(result.truncated).toBe(true);
  });
});
