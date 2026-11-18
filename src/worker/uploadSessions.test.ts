import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import {
  getOwnedUpload,
  MAX_OPEN_UPLOADS_PER_GUEST,
  type MultipartBackend,
  PART_URL_TTL_SECONDS,
  partCount,
  presignPartUrls,
  startUpload,
  abortUpload,
  MAX_OPEN_UPLOADS_PER_EVENT,
  type StartUploadHooks,
  type StartUploadInput,
} from "./uploadSessions";
import { MULTIPART_PART_BYTES, R2RequestError } from "./multipartPresign";

let sqlite: SqliteD1;

function fakeBackend() {
  let next = 0;
  const calls = { create: [] as string[], abort: [] as string[], presign: [] as number[] };
  const backend: MultipartBackend = {
    async create(key) { calls.create.push(key); return `mp-${++next}`; },
    async presignPart(key, uploadId, part, ttl) { calls.presign.push(part); return `https://r2.test/${key}?uploadId=${uploadId}&partNumber=${part}&ttl=${ttl}`; },
    async listParts() { return []; },
    async abort(_key, uploadId) { calls.abort.push(uploadId); },
  };
  return { backend, calls };
}

const CLIENT_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const cleanupErrors: unknown[] = [];
const HOOKS: StartUploadHooks = { canStartNew: async () => "ok", onCleanupError: (err) => cleanupErrors.push(err) };

function input(overrides: Partial<StartUploadInput> = {}): StartUploadInput {
  return {
    eventId: "event-1",
    participantId: "p1",
    nickname: "Sara",
    clientUploadId: CLIENT_ID,
    contentType: "image/jpeg",
    size: 20 * 1024 * 1024,
    caption: "Cake!",
    filename: "IMG 1.jpg",
    ...overrides,
  };
}

const PARTICIPANTS = [
  ["p1", "event-1", "Sara"],
  ["p2", "event-1", "Lina"],
  ["p3", "event-2", "Sara"],
] as const;

beforeEach(() => {
  cleanupErrors.length = 0;
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('event-1', 'party', 'Party', 'Party')").run();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('event-2', 'other', 'Other', 'Party')").run();
  // startUpload only serves guests that still exist in the event.
  for (const [id, eventId, nickname] of PARTICIPANTS) {
    sqlite.raw.prepare("INSERT INTO participants (id, event_id, nickname) VALUES (?, ?, ?)").run(id, eventId, nickname);
  }
});

describe("startUpload", () => {
  it("opens a session that stores the owner, caption and part size", async () => {
    const { backend, calls } = fakeBackend();
    const result = await startUpload(sqlite.db, backend, input(), HOOKS);
    expect(result.kind).toBe("started");
    if (result.kind !== "started") return;
    expect(result.session).toMatchObject({
      participant_id: "p1",
      client_upload_id: CLIENT_ID,
      caption: "Cake!",
      part_size: MULTIPART_PART_BYTES,
      status: "open",
      upload_id: "mp-1",
    });
    expect(result.session.key).toMatch(/^events\/event-1\/moments\/[0-9a-f-]+-IMG_1\.jpg$/);
    expect(partCount(result.session)).toBe(3);
    expect(calls.create).toHaveLength(1);
  });

  it("returns the same session for a retried init without opening another", async () => {
    const { backend, calls } = fakeBackend();
    const first = await startUpload(sqlite.db, backend, input(), HOOKS);
    const again = await startUpload(sqlite.db, backend, input({ caption: "ignored on retry" }), HOOKS);
    expect(again.kind).toBe("existing");
    if (first.kind !== "started" || again.kind !== "existing") return;
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.caption).toBe("Cake!");
    expect(calls.create).toHaveLength(1);
  });

  it("refuses a reused client id for a different file", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input(), HOOKS);
    expect((await startUpload(sqlite.db, backend, input({ size: 1234 }), HOOKS)).kind).toBe("conflict");
    expect((await startUpload(sqlite.db, backend, input({ contentType: "video/mp4" }), HOOKS)).kind).toBe("conflict");
  });

  it("scopes client ids to the guest and the event", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input(), HOOKS);
    expect((await startUpload(sqlite.db, backend, input({ participantId: "p2" }), HOOKS)).kind).toBe("started");
    expect((await startUpload(sqlite.db, backend, input({ eventId: "event-2", participantId: "p3" }), HOOKS)).kind).toBe("started");
  });

  it("refuses a guest who is gone and aborts its own multipart", async () => {
    const { backend, calls } = fakeBackend();
    expect(await startUpload(sqlite.db, backend, input({ participantId: "p-left" }), HOOKS)).toEqual({ kind: "guest_gone" });
    // A participant of another event doesn't count either.
    expect(await startUpload(sqlite.db, backend, input({ participantId: "p3" }), HOOKS)).toEqual({ kind: "guest_gone" });
    expect(calls.abort).toHaveLength(2);
  });

  it("lets a concurrent duplicate lose cleanly and aborts its multipart", async () => {
    const { backend, calls } = fakeBackend();
    const [a, b] = await Promise.all([startUpload(sqlite.db, backend, input(), HOOKS), startUpload(sqlite.db, backend, input(), HOOKS)]);
    expect([a.kind, b.kind].sort()).toEqual(["existing", "started"]);
    expect(calls.create).toHaveLength(2);
    expect(calls.abort).toHaveLength(1);
    const rows = sqlite.raw.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it.each([
    [{ clientUploadId: "not-a-uuid" }, "client_upload_id must be a UUID"],
    [{ contentType: "application/zip" }, "Unsupported file type"],
    [{ size: 0 }, "File too large (max 512MB)"],
    [{ size: 512 * 1024 * 1024 + 1 }, "File too large (max 512MB)"],
    [{ size: 1.5 }, "File too large (max 512MB)"],
    [{ caption: "x".repeat(501) }, "Caption is too long"],
  ])("rejects %o before calling R2", async (overrides, message) => {
    const { backend, calls } = fakeBackend();
    expect(await startUpload(sqlite.db, backend, input(overrides), HOOKS)).toEqual({ kind: "invalid", message });
    expect(calls.create).toHaveLength(0);
  });

  it("caps open sessions per guest", async () => {
    const { backend } = fakeBackend();
    for (let i = 0; i < MAX_OPEN_UPLOADS_PER_GUEST; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      expect((await startUpload(sqlite.db, backend, input({ clientUploadId: id }), HOOKS)).kind).toBe("started");
    }
    expect((await startUpload(sqlite.db, backend, input(), HOOKS)).kind).toBe("too_many_open");
    // A retry of an existing item still works at the cap.
    const retry = await startUpload(sqlite.db, backend, input({ clientUploadId: "00000000-0000-4000-8000-000000000000" }), HOOKS);
    expect(retry.kind).toBe("existing");
  });

  it("leaves web upload rows working (no client id, no owner)", async () => {
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes)
         VALUES ('w1', 'event-1', 'Web', 'events/event-1/moments/a.jpg', 'u1', 'image/jpeg', 10)`
      )
      .run();
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, content_type, size_bytes)
         VALUES ('w2', 'event-1', 'Web', 'events/event-1/moments/b.jpg', 'u2', 'image/jpeg', 10)`
      )
      .run();
    expect(await getOwnedUpload(sqlite.db, { eventId: "event-1", participantId: "p1", uploadId: "w1" })).toBeNull();
  });
});

describe("getOwnedUpload", () => {
  it("finds only the guest's own session in this event", async () => {
    const { backend } = fakeBackend();
    const started = await startUpload(sqlite.db, backend, input(), HOOKS);
    if (started.kind !== "started") throw new Error("expected a session");
    const ref = { eventId: "event-1", participantId: "p1", uploadId: started.session.id };
    expect((await getOwnedUpload(sqlite.db, ref))?.id).toBe(started.session.id);
    expect(await getOwnedUpload(sqlite.db, { ...ref, participantId: "p2" })).toBeNull();
    expect(await getOwnedUpload(sqlite.db, { ...ref, eventId: "event-2" })).toBeNull();
  });
});

describe("presignPartUrls", () => {
  async function session() {
    const { backend, calls } = fakeBackend();
    const started = await startUpload(sqlite.db, backend, input(), HOOKS);
    if (started.kind !== "started") throw new Error("expected a session");
    return { backend, calls, session: started.session };
  }

  it("signs every part for the URL lifetime by default", async () => {
    const { backend, session: s } = await session();
    const now = new Date("2026-11-18T10:00:00Z");
    const result = await presignPartUrls(backend, s, undefined, now);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    expect(result.parts[0].url).toContain(`ttl=${PART_URL_TTL_SECONDS}`);
    expect(result.expiresAt.toISOString()).toBe("2026-11-18T16:00:00.000Z");
  });

  it("refuses an empty list instead of signing everything", async () => {
    const { backend, calls, session: s } = await session();
    expect((await presignPartUrls(backend, s, [])).kind).toBe("invalid");
    expect(calls.presign).toEqual([]);
  });

  it("signs only the named parts, once each", async () => {
    const { backend, calls, session: s } = await session();
    const result = await presignPartUrls(backend, s, [3, 1, 3]);
    expect(result.kind === "ok" && result.parts.map((p) => p.part_number)).toEqual([1, 3]);
    expect(calls.presign).toEqual([1, 3]);
  });

  it.each([[[0]], [[4]], [[1.5]]])("rejects part numbers outside the file (%o)", async (parts) => {
    const { backend, session: s } = await session();
    expect((await presignPartUrls(backend, s, parts)).kind).toBe("invalid");
  });
});

describe("startUpload edge cases", () => {
  it("returns an existing session even when new ones are refused", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input(), HOOKS);
    const closed: StartUploadHooks = { ...HOOKS, canStartNew: async () => "closed" };
    expect((await startUpload(sqlite.db, backend, input(), closed)).kind).toBe("existing");
    const other = input({ clientUploadId: "00000000-0000-4000-8000-000000000009" });
    expect((await startUpload(sqlite.db, backend, other, closed)).kind).toBe("closed");
    const limited: StartUploadHooks = { ...HOOKS, canStartNew: async () => "rate_limited" };
    expect((await startUpload(sqlite.db, backend, other, limited)).kind).toBe("rate_limited");
  });

  it("treats client ids case-insensitively", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input(), HOOKS);
    expect((await startUpload(sqlite.db, backend, input({ clientUploadId: CLIENT_ID.toUpperCase() }), HOOKS)).kind).toBe("existing");
    expect((await startUpload(sqlite.db, backend, input({ contentType: "IMAGE/JPEG" }), HOOKS)).kind).toBe("existing");
  });

  it("answers not_open for an aborted session's id", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input(), HOOKS);
    sqlite.raw.prepare("UPDATE uploads SET status = 'aborted'").run();
    expect((await startUpload(sqlite.db, backend, input(), HOOKS)).kind).toBe("not_open");
  });

  it("caps open sessions per event", async () => {
    const insert = sqlite.raw.prepare(
      `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, participant_id, client_upload_id)
       VALUES (?, 'event-1', 'x', 'k', 'u', 1, ?, ?)`
    );
    for (let i = 0; i < MAX_OPEN_UPLOADS_PER_EVENT; i++) insert.run(`r${i}`, `guest-${i}`, `c${i}`);
    const { backend, calls } = fakeBackend();
    expect((await startUpload(sqlite.db, backend, input(), HOOKS)).kind).toBe("too_many_open");
    expect(calls.create).toHaveLength(0);
  });

  it("aborts its multipart when the insert fails, and logs a failed cleanup", async () => {
    const { backend, calls } = fakeBackend();
    backend.abort = async () => { throw new Error("abort failed"); };
    const brokenDb = {
      prepare: (sql: string) => (sql.trimStart().startsWith("INSERT") ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : sqlite.db.prepare(sql)),
    } as unknown as D1Database;
    await expect(startUpload(brokenDb, backend, input(), HOOKS)).rejects.toThrow("D1 down");
    expect(calls.create).toHaveLength(1);
    expect(cleanupErrors).toHaveLength(1);
  });
});

describe("abortUpload", () => {
  async function opened() {
    const { backend, calls } = fakeBackend();
    const started = await startUpload(sqlite.db, backend, input(), HOOKS);
    if (started.kind !== "started") throw new Error("expected a session");
    return { backend, calls, session: started.session };
  }
  const status = () => (sqlite.raw.prepare("SELECT status FROM uploads").get() as { status: string }).status;

  it("aborts in R2 and frees the slot", async () => {
    const { backend, calls, session } = await opened();
    expect((await abortUpload(sqlite.db, backend, session)).kind).toBe("aborted");
    expect(calls.abort).toEqual(["mp-1"]);
    expect(status()).toBe("aborted");
  });

  it("counts an upload R2 no longer has as aborted", async () => {
    const { backend, session } = await opened();
    backend.abort = async () => { throw new R2RequestError("abortMultipartUpload", 404, "NoSuchUpload"); };
    expect((await abortUpload(sqlite.db, backend, session)).kind).toBe("aborted");
    expect(status()).toBe("aborted");
  });

  it("keeps the session open when R2 fails otherwise", async () => {
    const { backend, session } = await opened();
    backend.abort = async () => { throw new R2RequestError("abortMultipartUpload", 403, "AccessDenied"); };
    await expect(abortUpload(sqlite.db, backend, session)).rejects.toBeInstanceOf(R2RequestError);
    expect(status()).toBe("open");
  });

  it("refuses a completed session", async () => {
    const { backend, session } = await opened();
    expect((await abortUpload(sqlite.db, backend, { ...session, status: "completed" })).kind).toBe("completed");
  });
});

describe("partCount", () => {
  it.each([
    [MULTIPART_PART_BYTES, 1],
    [MULTIPART_PART_BYTES + 1, 2],
    [512 * 1024 * 1024, 64],
    [1, 1],
  ])("splits %d bytes into %d parts", (size, parts) => {
    expect(partCount({ size_bytes: size, part_size: MULTIPART_PART_BYTES })).toBe(parts);
  });
});

