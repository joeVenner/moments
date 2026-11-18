import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest } from "./guestIdentity";
import worker from "./index";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { Env } from "./types";
import { streamMediaUrl } from "./stream";
import { mayFinishUpload, resolveWebUploader } from "./webUploader";

let sqlite: SqliteD1;
let put: ReturnType<typeof vi.fn>;

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: sqlite.db,
    BUCKET: { put } as unknown as R2Bucket,
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

function call(path: string, init: RequestInit, overrides: Partial<Env> = {}) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://moments.test${path}`, init), env(overrides), ctx);
}

async function join(nickname: string): Promise<{ token: string; participantId: string }> {
  const result = await joinEventAsGuest(sqlite.db, {
    eventId: "ev1", nickname, avatarSeed: null, presentedToken: null, enforceClaims: true,
  });
  if (!result.ok || !result.guestToken) throw new Error("join failed");
  return { token: result.guestToken, participantId: result.participant.id };
}

const ENFORCED: Partial<Env> = { GUEST_TOKENS_ENFORCED: "true" };
const jsonPost = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { "X-Guest-Token": token } : {}) },
  body: JSON.stringify(body),
});
function directUpload(name: string, token?: string): RequestInit {
  const form = new FormData();
  form.set("uploader_name", name);
  form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "a.jpg", { type: "image/jpeg" }));
  return { method: "POST", headers: token ? { "X-Guest-Token": token } : {}, body: form };
}
const uploadRow = () =>
  sqlite.raw.prepare("SELECT uploader_name, participant_id FROM uploads").get() as { uploader_name: string; participant_id: string | null };
const momentRow = () =>
  sqlite.raw.prepare("SELECT uploader_name, participant_id FROM moments").get() as { uploader_name: string; participant_id: string | null };

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev1', 'party', 'Party', 'party')").run();
  put = vi.fn(async () => undefined);
  // S3 CreateMultipartUpload, the only outbound call these routes make.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<InitiateMultipartUploadResult><UploadId>mp-1</UploadId></InitiateMultipartUploadResult>")));
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveWebUploader", () => {
  const resolve = (token: string | null, clientName: unknown, enforced = false) =>
    resolveWebUploader(
      { DB: sqlite.db, GUEST_TOKENS_ENFORCED: enforced ? "true" : undefined },
      { eventId: "ev1", token, clientName: () => clientName }
    );

  it("is the token's guest, whatever name the body carries", async () => {
    const sara = await join("Sara");
    expect(await resolve(sara.token, "Mallory")).toEqual({ ok: true, uploaderName: "Sara", participantId: sara.participantId });
    expect(await resolve(sara.token, undefined, true)).toEqual({ ok: true, uploaderName: "Sara", participantId: sara.participantId });
  });

  it("takes the body's trimmed name without a token, until enforcement", async () => {
    expect(await resolve(null, "  Lina ")).toEqual({ ok: true, uploaderName: "Lina", participantId: null });
    expect(await resolve(null, "   ")).toMatchObject({ ok: false, status: 400 });
    expect(await resolve(null, "Lina", true)).toMatchObject({ ok: false, status: 403, body: { code: "guest_required" } });
  });

  it("never reads the body for an enforced tokenless request", async () => {
    const clientName = vi.fn(() => "Lina");
    const result = await resolveWebUploader({ DB: sqlite.db, GUEST_TOKENS_ENFORCED: "true" }, { eventId: "ev1", token: null, clientName });
    expect(result).toMatchObject({ status: 403 });
    expect(clientName).not.toHaveBeenCalled();
  });

  it("keeps a claimed nickname for its token, even before enforcement", async () => {
    await join("Sara");
    expect(await resolve(null, " Sara ")).toMatchObject({ ok: false, status: 403 });
    // An unclaimed (legacy) name is still free to use.
    sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES ('old', 'ev1', 'Lina')").run();
    expect(await resolve(null, "Lina")).toMatchObject({ ok: true, uploaderName: "Lina" });
  });

  it("treats another event's, a malformed or an unknown token as none", async () => {
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev2', 'other', 'Other', 'party')").run();
    const sara = await join("Sara");
    const enforced = { DB: sqlite.db, GUEST_TOKENS_ENFORCED: "true" };
    expect(await resolveWebUploader(enforced, { eventId: "ev2", token: sara.token, clientName: () => "Sara" })).toMatchObject({ status: 403 });
    for (const token of ["nope", "gt_" + "a".repeat(43)]) {
      expect(await resolveWebUploader(enforced, { eventId: "ev1", token, clientName: () => "Sara" })).toMatchObject({ status: 403 });
    }
  });
});

describe("mayFinishUpload", () => {
  const may = (row: { participant_id: string | null; uploader_name: string }, token: string | null, clientName: string, enforced = false) =>
    mayFinishUpload({ DB: sqlite.db, GUEST_TOKENS_ENFORCED: enforced ? "true" : undefined }, { eventId: "ev1", token, row, clientName });

  it("lets only the owner's token finish a guest's row", async () => {
    const sara = await join("Sara");
    const lina = await join("Lina");
    const row = { participant_id: sara.participantId, uploader_name: "Sara" };
    expect(await may(row, sara.token, "anything")).toBe(true);
    expect(await may(row, lina.token, "Sara")).toBe(false);
  });

  it("lets a guest's row finish tokenless (service worker) only until enforcement", async () => {
    const sara = await join("Sara");
    const row = { participant_id: sara.participantId, uploader_name: "Sara" };
    expect(await may(row, null, "Sara")).toBe(true);
    expect(await may(row, null, "Sara", true)).toBe(false);
  });

  it("needs the opening name for a tokenless row", async () => {
    const row = { participant_id: null, uploader_name: "Sara" };
    expect(await may(row, null, "Sara")).toBe(true);
    expect(await may(row, null, "Lina")).toBe(false);
  });
});

describe("web upload routes", () => {
  it("record the guest on a direct upload", async () => {
    const sara = await join("Sara");
    const res = await call("/api/events/party/moments", directUpload("Mallory", sara.token));
    expect(res.status).toBe(201);
    expect(momentRow()).toEqual({ uploader_name: "Sara", participant_id: sara.participantId });
  });

  it("record the guest on multipart and Stream sessions", async () => {
    const sara = await join("Sara");
    const init = await call(
      "/api/events/party/moments/multipart/init",
      jsonPost({ uploader_name: "Mallory", content_type: "image/jpeg", size: 10, filename: "a.jpg" }, sara.token)
    );
    expect(init.status).toBe(200);
    expect(uploadRow()).toEqual({ uploader_name: "Sara", participant_id: sara.participantId });

    sqlite.raw.prepare("DELETE FROM uploads").run();
    const stream = await call(
      "/api/events/party/moments/stream/session",
      jsonPost({ content_type: "video/mp4", size: 10 }, sara.token)
    );
    expect(stream.status).toBe(200);
    expect(uploadRow()).toEqual({ uploader_name: "Sara", participant_id: sara.participantId });
  });

  it("refuse a tokenless direct upload without a name", async () => {
    expect((await call("/api/events/party/moments", directUpload(""))).status).toBe(400);
  });

  it("still take tokenless uploads until enforcement, without an owner", async () => {
    expect((await call("/api/events/party/moments", directUpload("Lina"))).status).toBe(201);
    expect(momentRow()).toEqual({ uploader_name: "Lina", participant_id: null });
  });

  it("refuse tokenless uploads once enforced, before storing anything", async () => {
    const starts: Array<[string, RequestInit]> = [
      ["/api/events/party/moments", directUpload("Lina")],
      ["/api/events/party/moments/multipart/init", jsonPost({ uploader_name: "Lina", content_type: "image/jpeg", size: 10 })],
      ["/api/events/party/moments/stream/session", jsonPost({ uploader_name: "Lina", content_type: "video/mp4", size: 10 })],
    ];
    for (const [path, init] of starts) {
      const res = await call(path, init, ENFORCED);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "guest_required" });
    }
    expect(put).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(sqlite.raw.prepare("SELECT COUNT(*) AS n FROM uploads").get()).toEqual({ n: 0 });
  });
});

describe("web complete routes", () => {
  const KEY = "events/ev1/moments/a.jpg";
  /** An upload row, finished already (its moment exists): complete replays it without R2 or Stream. */
  function finished(participantId: string | null, kind: "multipart" | "stream", hidden = false) {
    const [uploadId, key, mediaUrl] =
      kind === "multipart" ? ["mp-1", KEY, `/media/${KEY}`] : ["uid1", "stream/uid1", streamMediaUrl(env(), "uid1")];
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, participant_id)
         VALUES ('row1', 'ev1', 'Sara', ?, ?, 10, 'completed', ?)`
      )
      .run(key, uploadId, participantId);
    sqlite.raw
      .prepare(
        `INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id, moderation_status)
         VALUES ('m1', 'ev1', 'Sara', ?, ?, ?)`
      )
      .run(mediaUrl, participantId, hidden ? "hidden" : "approved");
  }
  const complete = (kind: "multipart" | "stream", name: string, token?: string) =>
    kind === "multipart"
      ? call("/api/events/party/moments/multipart/complete", jsonPost({ upload_id: "mp-1", key: KEY, uploader_name: name, parts: [] }, token))
      : call("/api/events/party/moments/stream/complete", jsonPost({ stream_uid: "uid1", uploader_name: name }, token));

  for (const kind of ["multipart", "stream"] as const) {
    it(`${kind}: the owner finishes, another guest can't, and guests never see the owner id`, async () => {
      const sara = await join("Sara");
      const lina = await join("Lina");
      finished(sara.participantId, kind);
      expect((await complete(kind, "Sara", lina.token)).status).toBe(404);
      const res = await complete(kind, "whatever", sara.token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { moment: Record<string, unknown> };
      expect(body.moment.id).toBe("m1");
      expect(body.moment).not.toHaveProperty("participant_id");
      // Tokenless (the upload service worker) only until enforcement.
      expect((await complete(kind, "Sara")).status).toBe(200);
      expect((await call(
        kind === "multipart" ? "/api/events/party/moments/multipart/complete" : "/api/events/party/moments/stream/complete",
        jsonPost(kind === "multipart" ? { upload_id: "mp-1", key: KEY, uploader_name: "Sara", parts: [] } : { stream_uid: "uid1", uploader_name: "Sara" }),
        ENFORCED
      )).status).toBe(404);
    });

    it(`${kind}: a tokenless row needs its own name, and a hidden moment isn't replayed`, async () => {
      finished(null, kind, true);
      expect((await complete(kind, "Lina")).status).toBe(404);
      expect((await complete(kind, "Sara")).status).toBe(404);
      sqlite.raw.prepare("UPDATE moments SET moderation_status = 'approved'").run();
      expect((await complete(kind, "Sara")).status).toBe(200);
    });
  }
});
