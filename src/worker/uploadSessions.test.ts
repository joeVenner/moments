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
  type StartUploadInput,
} from "./uploadSessions";
import { MULTIPART_PART_BYTES } from "./multipartPresign";

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

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('event-1', 'party', 'Party', 'Party')").run();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('event-2', 'other', 'Other', 'Party')").run();
});

describe("startUpload", () => {
  it("opens a session that stores the owner, caption and part size", async () => {
    const { backend, calls } = fakeBackend();
    const result = await startUpload(sqlite.db, backend, input());
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
    const first = await startUpload(sqlite.db, backend, input());
    const again = await startUpload(sqlite.db, backend, input({ caption: "ignored on retry" }));
    expect(again.kind).toBe("existing");
    if (first.kind !== "started" || again.kind !== "existing") return;
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.caption).toBe("Cake!");
    expect(calls.create).toHaveLength(1);
  });

  it("refuses a reused client id for a different file", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input());
    expect((await startUpload(sqlite.db, backend, input({ size: 1234 }))).kind).toBe("conflict");
    expect((await startUpload(sqlite.db, backend, input({ contentType: "video/mp4" }))).kind).toBe("conflict");
  });

  it("scopes client ids to the guest and the event", async () => {
    const { backend } = fakeBackend();
    await startUpload(sqlite.db, backend, input());
    expect((await startUpload(sqlite.db, backend, input({ participantId: "p2" }))).kind).toBe("started");
    expect((await startUpload(sqlite.db, backend, input({ eventId: "event-2" }))).kind).toBe("started");
  });

  it("lets a concurrent duplicate lose cleanly and aborts its multipart", async () => {
    const { backend, calls } = fakeBackend();
    const [a, b] = await Promise.all([startUpload(sqlite.db, backend, input()), startUpload(sqlite.db, backend, input())]);
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
    expect(await startUpload(sqlite.db, backend, input(overrides))).toEqual({ kind: "invalid", message });
    expect(calls.create).toHaveLength(0);
  });

  it("caps open sessions per guest", async () => {
    const { backend } = fakeBackend();
    for (let i = 0; i < MAX_OPEN_UPLOADS_PER_GUEST; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      expect((await startUpload(sqlite.db, backend, input({ clientUploadId: id }))).kind).toBe("started");
    }
    expect((await startUpload(sqlite.db, backend, input())).kind).toBe("too_many_open");
    // A retry of an existing item still works at the cap.
    const retry = await startUpload(sqlite.db, backend, input({ clientUploadId: "00000000-0000-4000-8000-000000000000" }));
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
    const started = await startUpload(sqlite.db, backend, input());
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
    const started = await startUpload(sqlite.db, backend, input());
    if (started.kind !== "started") throw new Error("expected a session");
    return { backend, calls, session: started.session };
  }

  it("signs every part for a day by default", async () => {
    const { backend, session: s } = await session();
    const now = new Date("2026-11-18T10:00:00Z");
    const result = await presignPartUrls(backend, s, undefined, now);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    expect(result.parts[0].url).toContain(`ttl=${PART_URL_TTL_SECONDS}`);
    expect(result.expiresAt.toISOString()).toBe("2026-11-19T10:00:00.000Z");
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
