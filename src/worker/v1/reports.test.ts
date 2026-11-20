import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { createSqliteD1, type SqliteD1 } from "../testing/sqliteD1";
import type { Env } from "../types";

let sqlite: SqliteD1;
let limiter: { limit: ReturnType<typeof vi.fn> } | undefined;

function env(): Env {
  return {
    DB: sqlite.db,
    BUCKET: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EVENT_ACCESS_SECRET: "test-access-secret-123",
    ...(limiter ? { REACTION_LIMITER: limiter as unknown as RateLimit } : {}),
  };
}

function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test/api/v1${path}`, init), env(), ctx);
}

async function joinAs(nickname: string, slug = "party"): Promise<string> {
  const response = await call(`/events/${slug}/participants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  return ((await response.json()) as { guest_token: string }).guest_token;
}

function report(momentId: string, token?: string, slug = "party") {
  return call(`/events/${slug}/moments/${momentId}/report`, {
    method: "POST",
    headers: token ? { "X-Guest-Token": token } : {},
  });
}

function reports() {
  return sqlite.raw.prepare("SELECT event_id, moment_id FROM moment_reports ORDER BY created_at").all();
}

function seedEvent(id: string, slug: string) {
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type, access_version) VALUES (?, ?, ?, 'Party', 1)").run(id, slug, slug);
}

function addMoment(id: string, eventId = "event-1", status = "approved") {
  sqlite.raw
    .prepare(
      "INSERT INTO moments (id, event_id, uploader_name, media_url, mime_type, moderation_status) VALUES (?, ?, 'Sara', ?, 'image/jpeg', ?)"
    )
    .run(id, eventId, `/media/events/${eventId}/moments/${id}.jpg`, status);
}

beforeEach(() => {
  sqlite = createSqliteD1();
  limiter = undefined;
  seedEvent("event-1", "party");
});

describe("POST /api/v1/events/:slug/moments/:id/report", () => {
  it("records one report per guest, however many times they send it", async () => {
    addMoment("m1");
    const token = await joinAs("Sara");
    expect((await report("m1", token)).status).toBe(204);
    expect((await report("m1", token)).status).toBe(204);
    expect(reports()).toEqual([{ event_id: "event-1", moment_id: "m1" }]);
  });

  it("counts each guest's report", async () => {
    addMoment("m1");
    await report("m1", await joinAs("Sara"));
    await report("m1", await joinAs("Omar"));
    expect(reports()).toHaveLength(2);
  });

  it("needs a joined guest", async () => {
    addMoment("m1");
    expect((await report("m1")).status).toBe(403);
    expect((await report("m1", "gt_" + "a".repeat(43))).status).toBe(403);
    expect(reports()).toEqual([]);
  });

  it("won't report a hidden moment, an unknown one, or one from another event", async () => {
    seedEvent("event-2", "other");
    addMoment("hidden", "event-1", "hidden");
    addMoment("elsewhere", "event-2");
    const token = await joinAs("Sara");
    for (const id of ["hidden", "missing", "elsewhere"]) {
      const response = await report(id, token);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "moment_not_found" });
    }
    expect(reports()).toEqual([]);
  });

  it("slows down a guest who reports too fast, before writing", async () => {
    addMoment("m1");
    const token = await joinAs("Sara");
    limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    expect((await report("m1", token)).status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^event-1:report:guest:/) });
    expect(reports()).toEqual([]);
  });

  it("goes with the moment when it is deleted", async () => {
    addMoment("m1");
    await report("m1", await joinAs("Sara"));
    sqlite.raw.prepare("DELETE FROM moments WHERE id = 'm1'").run();
    expect(reports()).toEqual([]);
  });
});
