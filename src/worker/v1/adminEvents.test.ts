import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";
import { AdminEventDetailSchema, AdminEventListSchema, ErrorSchema, HostSignInResponseSchema } from "./schemas";

let sqlite: SqliteD1;
/** Keys the limiter refuses (everything else passes). */
let limitedKeys: RegExp | null = null;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret-password",
    ADMIN_AUTH_LIMITER: {
      limit: vi.fn(async ({ key }: { key: string }) => ({ success: !limitedKeys?.test(key) })),
    } as unknown as RateLimit,
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
  limitedKeys = null;
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

describe("GET /api/v1/admin/events/{id}", () => {
  const get = async (id: string, auth = true) =>
    call(`/admin/events/${encodeURIComponent(id)}`, auth ? { headers: { Authorization: `Bearer ${await token()}` } } : {});

  it("needs a host session", async () => {
    insertEvent("e", "2026-11-01 10:00:00");
    const response = await get("e", false);
    expect(response.status).toBe(401);
    expect(ErrorSchema.parse(await response.json()).code).toBe("host_auth_required");
  });

  it("answers event_not_found for an unknown id", async () => {
    const response = await get("missing");
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).code).toBe("event_not_found");
  });

  it("gives a public event its link, no invite, and its analytics", async () => {
    insertEvent("e", "2026-11-01 10:00:00");
    const moment = sqlite.raw.prepare(
      "INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type, size_bytes, moderation_status) VALUES (?, 'e', 'Sara', '/media/x', ?, ?, ?)"
    );
    moment.run("m1", "image/jpeg", 100, "approved");
    moment.run("m2", "video/mp4", 400, "hidden");
    sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES ('p1', 'e', 'Sara')").run();
    sqlite.raw.prepare("INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES ('r1', 'm1', 'e', 'p1')").run();
    sqlite.raw.prepare(
      "INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status) VALUES ('u1', 'e', 'Sara', 'k', 'x', 1, 'open')"
    ).run();

    const response = await get("e");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const detail = AdminEventDetailSchema.parse(await response.json());
    expect(detail.event).toMatchObject({ id: "e", moment_count: 2, participant_count: 1 });
    expect(detail.share).toEqual({ event_url: "https://moments.test/e/slug-e", invite_url: null });
    expect(detail.analytics.summary).toEqual({
      total_moments: 2, hidden_moments: 1, videos: 1, photos: 1, storage_bytes: 500, participants: 1, reactions: 1,
    });
    expect(detail.analytics.upload_states).toEqual([{ status: "open", count: 1 }]);
  });

  it("gives a private event its invite link, but never the PIN hash", async () => {
    insertEvent("p", "2026-11-01 10:00:00", "private");
    const response = await get("p");
    const body = await response.json();
    const detail = AdminEventDetailSchema.parse(body);
    expect(detail.share.invite_url).toBe("https://moments.test/e/slug-p?invite=invite-secret-p");
    expect(JSON.stringify(body)).not.toContain("pin-hash");
    expect(JSON.stringify(detail.event)).not.toContain("invite-secret");
  });

  it("refuses an id longer than 100 characters", async () => {
    const response = await get("x".repeat(101));
    expect(response.status).toBe(400);
  });

  it("encodes the slug in the links and never sends PIN or version fields", async () => {
    sqlite.raw
      .prepare("INSERT INTO events (id, slug, title, type, access_mode, invite_token, access_pin_hash, access_pin_salt) VALUES ('q', 'a b&c', 'Q', 'Party', 'private', 'tok+/=', 'pin-hash', 'pin-salt')")
      .run();
    const body = await (await get("q")).json();
    const detail = AdminEventDetailSchema.parse(body);
    expect(detail.share).toEqual({
      event_url: "https://moments.test/e/a%20b%26c",
      invite_url: "https://moments.test/e/a%20b%26c?invite=tok%2B%2F%3D",
    });
    const text = JSON.stringify(body);
    for (const field of ["access_pin_hash", "access_pin_salt", "access_version", "invite_token", "pin-hash", "pin-salt"]) {
      expect(text).not.toContain(field);
    }
  });

  it("counts activity per day over the last two weeks, oldest first", async () => {
    insertEvent("e", "2026-11-01 10:00:00");
    const moment = sqlite.raw.prepare(
      "INSERT INTO moments (id, event_id, uploader_name, media_url, created_at) VALUES (?, 'e', 'Sara', '/media/x', datetime('now', ?))"
    );
    moment.run("today-1", "-1 seconds");
    moment.run("today-2", "-2 seconds");
    moment.run("week", "-7 days");
    moment.run("old", "-20 days");
    const detail = AdminEventDetailSchema.parse(await (await get("e")).json());
    const day = (offset: string) =>
      (sqlite.raw.prepare("SELECT date('now', ?) AS d").get(offset) as { d: string }).d;
    expect(detail.analytics.activity).toEqual([
      { day: day("-7 days"), count: 1 },
      { day: day("-1 seconds"), count: 2 },
    ]);
    expect(detail.analytics.summary.total_moments).toBe(4);
  });

  it("answers zeros for an event with nothing in it", async () => {
    insertEvent("e", "2026-11-01 10:00:00");
    const detail = AdminEventDetailSchema.parse(await (await get("e")).json());
    expect(detail.analytics).toEqual({
      summary: { total_moments: 0, hidden_moments: 0, videos: 0, photos: 0, storage_bytes: 0, participants: 0, reactions: 0 },
      activity: [],
      upload_states: [],
    });
  });
});

describe("POST /api/v1/admin/events", () => {
  async function create(body: unknown, auth = true) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = `Bearer ${await token()}`;
    return call("/admin/events", { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("needs a host session", async () => {
    const response = await create({ title: "Party", type: "Party" }, false);
    expect(response.status).toBe(401);
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  it("creates a public event with a slug from its title and answers its detail", async () => {
    const response = await create({
      title: "  Sara & Omar's wedding ",
      type: "Wedding",
      main_characters: "Sara & Omar",
      description: "",
      starts_at: "2026-12-05T18:00:00+01:00",
      expires_at: null,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const detail = AdminEventDetailSchema.parse(await response.json());
    expect(detail.event.title).toBe("Sara & Omar's wedding");
    expect(detail.event.slug).toMatch(/^sara-omar/);
    expect(detail.event.access_mode).toBe("public");
    expect(detail.event.main_characters).toBe("Sara & Omar");
    expect(detail.event.description).toBeNull();
    expect(detail.event.starts_at).toBe("2026-12-05 17:00:00");
    expect(detail.event.uploads_open).toBe(true);
    expect(detail.share.event_url).toBe(`https://moments.test/e/${detail.event.slug}`);
    expect(detail.share.invite_url).toBeNull();
    expect(detail.analytics.summary.total_moments).toBe(0);
  });

  it("gives a second event with the same title its own slug", async () => {
    const first = AdminEventDetailSchema.parse(await (await create({ title: "Party", type: "Party" })).json());
    const second = AdminEventDetailSchema.parse(await (await create({ title: "Party", type: "Party" })).json());
    expect(first.event.slug).toBe("party");
    expect(second.event.slug).not.toBe("party");
  });

  it.each([
    [{ type: "Party" }],
    [{ title: "   ", type: "Party" }],
    [{ title: "Party", type: "" }],
    [{ title: "x".repeat(121), type: "Party" }],
    [{ title: "Party", type: "Party", description: "x".repeat(1001) }],
    [{ title: "Party", type: "Party", expires_at: "tomorrow" }],
    [{ title: "Party", type: "Party", starts_at: "1999-12-31T00:00:00Z" }],
    // No time zone (it would be read as UTC and shift the host's time), or not a date-time.
    [{ title: "Party", type: "Party", starts_at: "2026-12-05T18:00:00" }],
    [{ title: "Party", type: "Party", starts_at: "2026-12-05" }],
    [{ title: "Party", type: "Party", starts_at: "Dec 5 2026" }],
    // An end in the past would purge the new event at the next cleanup.
    [{ title: "Party", type: "Party", expires_at: "2020-01-01T00:00:00Z" }],
    [{ title: "Party", type: "Party", starts_at: "2099-12-05T18:00:00Z", expires_at: "2099-12-01T00:00:00Z" }],
    [{ title: "Party", type: "Party", access_mode: "private" }],
    [{ title: "Party", type: "Party", invite_token: "mine" }],
  ])("refuses %j without creating anything", async (body) => {
    const response = await create(body);
    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(await response.json()).code).toBe("invalid_request");
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });
});

describe("POST /api/v1/admin/events limits", () => {
  it("names the bad field", async () => {
    const response = await call("/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ title: "Party", type: "Party", expires_at: "2020-01-01T00:00:00Z" }),
    });
    expect(ErrorSchema.parse(await response.json()).error).toBe("expires_at is invalid");
  });

  it("refuses a flood of new events with rate_limited", async () => {
    const bearer = `Bearer ${await token()}`;
    limitedKeys = /^host-create:/;
    const response = await call("/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: bearer },
      body: JSON.stringify({ title: "Party", type: "Party" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(ErrorSchema.parse(await response.json()).code).toBe("rate_limited");
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });
});

describe("PATCH /api/v1/admin/events/{id}", () => {
  async function update(id: string, body: unknown) {
    return call(`/admin/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
      body: JSON.stringify(body),
    });
  }

  it("changes only what it's sent and never the slug or access secrets", async () => {
    insertEvent("e", "2026-01-01 10:00:00", "private");
    sqlite.raw.prepare("UPDATE events SET description = 'Old', main_characters = 'Sara' WHERE id = 'e'").run();
    const response = await update("e", { title: "New title", description: null, starts_at: "2026-12-05T17:00:00Z" });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toMatch(/pin-hash|access_pin|access_version/);
    const detail = AdminEventDetailSchema.parse(JSON.parse(raw));
    expect(detail.event).toMatchObject({
      title: "New title", slug: "slug-e", type: "Party", main_characters: "Sara", description: null,
      starts_at: "2026-12-05 17:00:00", access_mode: "private",
    });
    expect(detail.share.invite_url).toContain("invite-secret-e");
    const row = sqlite.raw.prepare("SELECT access_pin_hash, invite_token FROM events WHERE id = 'e'").get();
    expect(row).toEqual({ access_pin_hash: "pin-hash", invite_token: "invite-secret-e" });
  });

  it("clears a date with null and changes the date alone", async () => {
    insertEvent("e", "2026-01-01 10:00:00");
    await update("e", { starts_at: "2026-12-05T18:00:00-05:00" });
    expect(sqlite.raw.prepare("SELECT starts_at, title FROM events WHERE id = 'e'").get()).toEqual({
      starts_at: "2026-12-05 23:00:00", title: "Event e",
    });
    await update("e", { starts_at: null });
    expect(sqlite.raw.prepare("SELECT starts_at FROM events WHERE id = 'e'").get()).toEqual({ starts_at: null });
  });

  it("needs a host session", async () => {
    insertEvent("e", "2026-01-01 10:00:00");
    const response = await call("/admin/events/e", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Hacked" }),
    });
    expect(response.status).toBe(401);
    expect(sqlite.raw.prepare("SELECT title FROM events WHERE id = 'e'").get()).toEqual({ title: "Event e" });
  });

  it("answers event_not_found for an unknown id", async () => {
    const response = await update("missing", { title: "x" });
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).code).toBe("event_not_found");
  });

  it.each([[{}], [{ title: "" }], [{ starts_at: "soon" }], [{ starts_at: "2026-12-05T18:00:00" }], [{ slug: "mine" }], [{ expires_at: null }], [{ access_mode: "public" }]])(
    "refuses %j and leaves the event as it was",
    async (body) => {
      insertEvent("e", "2026-01-01 10:00:00");
      const response = await update("e", body);
      expect(response.status).toBe(400);
      expect(sqlite.raw.prepare("SELECT title, slug FROM events WHERE id = 'e'").get()).toEqual({ title: "Event e", slug: "slug-e" });
    }
  );
});
