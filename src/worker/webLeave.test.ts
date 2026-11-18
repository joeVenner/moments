import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest, resolveGuestSession } from "./guestIdentity";
import worker from "./index";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";

let sqlite: SqliteD1;
let bucketDelete: ReturnType<typeof vi.fn<(keys: string | string[]) => Promise<void>>>;

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: sqlite.db,
    BUCKET: { delete: bucketDelete } as unknown as R2Bucket,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_S3_ENDPOINT: "https://r2.example.com",
    R2_BUCKET_NAME: "moments-media",
    STREAM_ACCOUNT_ID: "acct",
    STREAM_API_TOKEN: "token",
    STREAM_CUSTOMER_CODE: "abc",
    ...overrides,
  };
}

function leave(token?: string, overrides: Partial<Env> = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const init: RequestInit = { method: "POST", headers: token ? { "X-Guest-Token": token } : {} };
  return worker.fetch(new Request("https://moments.test/api/events/party/leave", init), env(overrides), ctx);
}

async function join(nickname: string): Promise<{ token: string; participantId: string }> {
  const result = await joinEventAsGuest(sqlite.db, {
    eventId: "ev1", nickname, avatarSeed: null, presentedToken: null, enforceClaims: true,
  });
  if (!result.ok || !result.guestToken) throw new Error("join failed");
  return { token: result.guestToken, participantId: result.participant.id };
}

function moment(id: string, participantId: string | null) {
  sqlite.raw
    .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id) VALUES (?, 'ev1', 'Sara', ?, ?)")
    .run(id, `/media/events/ev1/moments/${id}.jpg`, participantId);
}
const momentIds = () => (sqlite.raw.prepare("SELECT id FROM moments ORDER BY id").all() as { id: string }[]).map((m) => m.id);

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev1', 'party', 'Party', 'party')").run();
  bucketDelete = vi.fn(async () => undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/events/:slug/leave", () => {
  it("deletes the token's guest's moments only, then the token stops working", async () => {
    const sara = await join("Sara");
    const lina = await join("Lina");
    moment("m-sara", sara.participantId);
    moment("m-lina", lina.participantId);
    moment("m-tokenless", null);

    const res = await leave(sara.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ done: true });

    expect(momentIds()).toEqual(["m-lina", "m-tokenless"]);
    expect(bucketDelete).toHaveBeenCalledWith(["events/ev1/moments/m-sara.jpg"]);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).toBeNull();
    // Leaving again with the dead token is refused, and touches nothing.
    expect((await leave(sara.token)).status).toBe(403);
    expect(bucketDelete).toHaveBeenCalledTimes(1);
    expect(momentIds()).toEqual(["m-lina", "m-tokenless"]);
  });

  it("needs a guest token, enforced or not", async () => {
    const sara = await join("Sara");
    moment("m-sara", sara.participantId);
    for (const overrides of [{}, { GUEST_TOKENS_ENFORCED: "true" }]) {
      const res = await leave(undefined, overrides);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "guest_required" });
      expect((await leave("gt_not-a-real-token", overrides)).status).toBe(403);
    }
    expect(momentIds()).toEqual(["m-sara"]);
  });

  it("is rate limited per guest", async () => {
    const sara = await join("Sara");
    moment("m-sara", sara.participantId);
    const limit = vi.fn().mockResolvedValue({ success: false });
    const res = await leave(sara.token, { UPLOAD_LIMITER: { limit } });
    expect(res.status).toBe(429);
    expect(limit.mock.calls[0]?.[0]).toEqual({ key: expect.stringMatching(/^ev1:guest:/) });
    expect(momentIds()).toEqual(["m-sara"]);
  });

  it("answers 502 when storage fails, keeping the guest so a retry can finish", async () => {
    const sara = await join("Sara");
    moment("m-sara", sara.participantId);
    bucketDelete.mockRejectedValueOnce(new Error("R2 down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await leave(sara.token);
    expect(res.status).toBe(502);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();
    expect(await (await leave(sara.token)).json()).toEqual({ done: true });
  });

  it("is 404 for an unknown event", async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://moments.test/api/events/nope/leave", { method: "POST" }), env(), ctx);
    expect(res.status).toBe(404);
  });
});

describe("Stream tus create racing a leave", () => {
  it("deletes the new video when the session was closed meanwhile", async () => {
    const sara = await join("Sara");
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, participant_id)
         VALUES ('s1', 'ev1', 'Sara', 'stream-session/s1', 's1', 1000, 'open', ?)`
      )
      .run(sara.participantId);
    const uid = "e".repeat(32);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      // The guest leaves while Stream creates the video.
      sqlite.raw.prepare("UPDATE uploads SET status = 'aborted' WHERE id = 's1'").run();
      return new Response(null, { status: 201, headers: { Location: "https://upload.example/x", "stream-media-id": uid } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://moments.test/api/events/party/moments/stream/tus?session=s1", {
        method: "POST",
        headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "1000", "Upload-Metadata": "filetype dmlkZW8vbXA0" },
      }),
      env(),
      ctx
    );
    expect(res.status).toBe(409);
    const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => String(url));
    expect(deletes).toEqual([expect.stringContaining(`/${uid}`)]);
  });
});
