import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import { checkParts, type FinalizeBackend, finalizeReadyUploads, finalizeUpload, FINALIZE_SWEEP_BATCH } from "./uploadFinalize";
import type { Env } from "./types";
import { vi } from "vitest";
import { abortUpload, getUploadById, startUpload, type StartUploadHooks, type UploadSessionRow } from "./uploadSessions";
import { MULTIPART_PART_BYTES, type R2Part, R2RequestError } from "./multipartPresign";

let sqlite: SqliteD1;
const MB8 = MULTIPART_PART_BYTES;
const SIZE = 2 * MB8 + 100;
const JPEG_START = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const HOOKS: StartUploadHooks = { canStartNew: async () => "ok", onCleanupError: () => undefined };

interface FakeR2 {
  backend: FinalizeBackend;
  state: {
    parts: R2Part[];
    multipartGone: boolean;
    object: { contentType: string; size: number; start: Uint8Array } | null;
    /** What Complete assembles. */
    assembled: { contentType: string; size: number; start: Uint8Array };
    completeFails: boolean;
    calls: string[];
  };
}

function fakeR2(): FakeR2 {
  const state: FakeR2["state"] = {
    parts: [],
    multipartGone: false,
    object: null,
    assembled: { contentType: "image/jpeg", size: SIZE, start: JPEG_START },
    completeFails: false,
    calls: [],
  };
  const backend: FinalizeBackend = {
    create: async () => "mp-1",
    presignPart: async () => "https://r2.test/part",
    listParts: async () => {
      state.calls.push("listParts");
      if (state.multipartGone) throw new R2RequestError("listParts", 404, "NoSuchUpload");
      return state.parts;
    },
    abort: async () => {
      state.calls.push("abort");
      if (state.multipartGone) throw new R2RequestError("abortMultipartUpload", 404, "NoSuchUpload");
      state.multipartGone = true;
    },
    complete: async () => {
      state.calls.push("complete");
      state.object = state.assembled;
      state.multipartGone = true;
      if (state.completeFails) throw new R2RequestError("completeMultipartUpload", 500, "InternalError");
    },
    head: async () => (state.object ? { contentType: state.object.contentType, size: state.object.size } : null),
    readStart: async () => state.object?.start ?? null,
    deleteObject: async () => {
      state.calls.push("delete");
      state.object = null;
    },
  };
  return { backend, state };
}

const fullParts = (): R2Part[] => [
  { partNumber: 1, etag: '"a"', size: MB8 },
  { partNumber: 2, etag: '"b"', size: MB8 },
  { partNumber: 3, etag: '"c"', size: 100 },
];

async function openSession(r2: FakeR2): Promise<UploadSessionRow> {
  const result = await startUpload(
    sqlite.db,
    r2.backend,
    {
      eventId: "event-1",
      participantId: "p1",
      nickname: "Sara",
      clientUploadId: "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      contentType: "image/jpeg",
      size: SIZE,
      caption: "Cake",
      filename: "a.jpg",
    },
    HOOKS
  );
  if (result.kind !== "started") throw new Error("expected a session");
  return result.session;
}

const moments = () => sqlite.raw.prepare("SELECT uploader_name, caption, points_awarded, size_bytes, mime_type, media_url FROM moments").all();

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('event-1', 'party', 'Party', 'Party')").run();
});

describe("checkParts", () => {
  const session = { size_bytes: SIZE, part_size: MB8 };
  it("is ready when every part has exactly its size", () => {
    expect(checkParts(session, fullParts())).toEqual({ kind: "ready" });
  });
  it("reports which parts arrived when some are missing", () => {
    expect(checkParts(session, [fullParts()[2], fullParts()[0]])).toEqual({ kind: "incomplete", uploadedParts: [1, 3] });
  });
  it.each([
    ["an oversized part", [{ partNumber: 1, etag: "x", size: MB8 + 1 }]],
    ["a short middle part", [{ partNumber: 2, etag: "x", size: 5 }]],
    ["a wrong last part", [{ partNumber: 3, etag: "x", size: 101 }]],
    ["a part past the end", [{ partNumber: 4, etag: "x", size: 1 }]],
    ["part zero", [{ partNumber: 0, etag: "x", size: MB8 }]],
    ["a last part one byte short", [{ partNumber: 3, etag: "x", size: 99 }]],
  ])("rejects %s", (_name, parts) => {
    expect(checkParts(session, parts)).toEqual({ kind: "bad" });
  });
  it("counts a repeated part number once", () => {
    const [first] = fullParts();
    expect(checkParts(session, [first, first])).toEqual({ kind: "incomplete", uploadedParts: [1] });
  });
  it("handles a one-part file", () => {
    expect(checkParts({ size_bytes: 10, part_size: MB8 }, [{ partNumber: 1, etag: "x", size: 10 }])).toEqual({ kind: "ready" });
  });
});

describe("finalizeUpload", () => {
  it("completes, checks the object and inserts the moment with the stored caption", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    const result = await finalizeUpload(sqlite.db, r2.backend, session);
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.session).toMatchObject({ status: "completed" });
    expect(result.session.moment_id).toBeTruthy();
    expect(result.session.completed_at).toBeTruthy();
    expect(moments()).toEqual([
      { uploader_name: "Sara", caption: "Cake", points_awarded: 1, size_bytes: SIZE, mime_type: "image/jpeg", media_url: `/media/${session.key}` },
    ]);
  });

  it("is idempotent: a replay returns the same moment", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    const first = await finalizeUpload(sqlite.db, r2.backend, session);
    const again = await finalizeUpload(sqlite.db, r2.backend, session);
    expect(again.kind === "completed" && first.kind === "completed" && again.session.moment_id === first.session.moment_id).toBe(true);
    expect(moments()).toHaveLength(1);
  });

  it("recovers when Complete succeeded but its response was lost", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    r2.state.completeFails = true;
    expect((await finalizeUpload(sqlite.db, r2.backend, session)).kind).toBe("completed");
    // And a later replay sees NoSuchUpload, then the existing moment.
    const fresh = await getUploadById(sqlite.db, session.id);
    expect((await finalizeUpload(sqlite.db, r2.backend, fresh!)).kind).toBe("completed");
  });

  it("registers from the object when the multipart is already gone", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.multipartGone = true;
    r2.state.object = r2.state.assembled;
    expect((await finalizeUpload(sqlite.db, r2.backend, session)).kind).toBe("completed");
  });

  it("waits while parts are missing", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts().slice(0, 2);
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "incomplete", uploadedParts: [1, 2] });
    expect(r2.state.calls).not.toContain("complete");
    expect((await getUploadById(sqlite.db, session.id))?.status).toBe("open");
  });

  it("aborts, without completing, when a part has the wrong size", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = [...fullParts().slice(0, 2), { partNumber: 3, etag: '"c"', size: 5 * 1024 ** 3 }];
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "rejected", reason: "part_size_mismatch" });
    expect(r2.state.calls).toEqual(["listParts", "abort"]);
    expect((await getUploadById(sqlite.db, session.id))?.status).toBe("aborted");
  });

  it.each([
    ["a different type", { contentType: "text/html", size: SIZE, start: JPEG_START }, "object_mismatch"],
    ["a different size", { contentType: "image/jpeg", size: SIZE - 1, start: JPEG_START }, "object_mismatch"],
    ["bytes that aren't a JPEG", { contentType: "image/jpeg", size: SIZE, start: new TextEncoder().encode("<!doctype html>.") }, "signature_mismatch"],
  ])("removes an assembled object with %s", async (_name, assembled, reason) => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    r2.state.assembled = assembled;
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "rejected", reason });
    expect(r2.state.object).toBeNull();
    expect(moments()).toHaveLength(0);
    expect((await getUploadById(sqlite.db, session.id))?.status).toBe("aborted");
  });

  it("treats a vanished multipart with no object as aborted", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.multipartGone = true;
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "not_open" });
    expect((await getUploadById(sqlite.db, session.id))?.status).toBe("aborted");
  });

  it("never completes a cancelled session, and a cancel after completion says completed", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    expect((await abortUpload(sqlite.db, r2.backend, session)).kind).toBe("aborted");
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "not_open" });

    const other = fakeR2();
    sqlite.raw.prepare("DELETE FROM uploads").run();
    const live = await openSession(other);
    other.state.parts = fullParts();
    expect((await finalizeUpload(sqlite.db, other.backend, live)).kind).toBe("completed");
    // A cancel that read the session as open before finalize won.
    expect((await abortUpload(sqlite.db, other.backend, live)).kind).toBe("completed");
  });

  it("deletes the object when a cancel lands between the checks and the insert", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    const readStart = r2.backend.readStart;
    r2.backend.readStart = async (key, length) => {
      sqlite.raw.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").run(session.id);
      return readStart(key, length);
    };
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "not_open" });
    expect(moments()).toHaveLength(0);
    expect(r2.state.object).toBeNull();
  });

  it("answers not_open, never an error, once the moment was deleted", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    expect((await finalizeUpload(sqlite.db, r2.backend, session)).kind).toBe("completed");
    sqlite.raw.prepare("DELETE FROM moments").run();
    const fresh = await getUploadById(sqlite.db, session.id);
    expect(fresh).toMatchObject({ status: "completed", moment_id: null });
    expect(await finalizeUpload(sqlite.db, r2.backend, fresh!)).toEqual({ kind: "not_open" });
  });

  it("adds no moment to an event purged while it checked, and removes the object", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    const readStart = r2.backend.readStart;
    r2.backend.readStart = async (key, length) => {
      sqlite.raw.prepare("UPDATE events SET archived_at = datetime('now')").run();
      return readStart(key, length);
    };
    expect(await finalizeUpload(sqlite.db, r2.backend, session)).toEqual({ kind: "not_open" });
    expect(moments()).toHaveLength(0);
    expect(r2.state.object).toBeNull();
  });

  it("passes a failed Complete on when no object was assembled", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    r2.backend.complete = async () => {
      throw new R2RequestError("completeMultipartUpload", 400, "InvalidPart");
    };
    await expect(finalizeUpload(sqlite.db, r2.backend, session)).rejects.toThrow("InvalidPart");
    expect((await getUploadById(sqlite.db, session.id))?.status).toBe("open");
  });

  it("keeps the object when a rejection loses to a finalize that completed", async () => {
    const r2 = fakeR2();
    const session = await openSession(r2);
    r2.state.parts = fullParts();
    expect((await finalizeUpload(sqlite.db, r2.backend, session)).kind).toBe("completed");
    // A stale caller still holding the open row sees a mismatching head.
    r2.state.object = { ...r2.state.assembled, size: 1 };
    r2.state.multipartGone = true;
    expect((await finalizeUpload(sqlite.db, r2.backend, session)).kind).toBe("completed");
    expect(r2.state.object).not.toBeNull();
  });
});

describe("finalizeReadyUploads", () => {
  const env = (): Env =>
    ({
      DB: sqlite.db,
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
      R2_S3_ENDPOINT: "https://r2.example.com",
      R2_BUCKET_NAME: "b",
    }) as unknown as Env;
  const age = (minutes: number) => sqlite.raw.prepare("UPDATE uploads SET created_at = datetime('now', ?)").run(`-${minutes} minutes`);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("finishes sessions nobody nudged once they are old enough", async () => {
    const r2 = fakeR2();
    await openSession(r2);
    r2.state.parts = fullParts();
    age(5);
    expect(await finalizeReadyUploads(env(), r2.backend)).toMatchObject({ completed: 0 });
    age(31);
    expect(await finalizeReadyUploads(env(), r2.backend)).toEqual({ completed: 1, waiting: 0, rejected: 0, closed: 0, failed: 0 });
    expect(moments()).toHaveLength(1);
  });

  it("leaves incomplete sessions open and skips purged events", async () => {
    const r2 = fakeR2();
    await openSession(r2);
    age(60);
    expect(await finalizeReadyUploads(env(), r2.backend)).toMatchObject({ waiting: 1 });
    sqlite.raw.prepare("UPDATE events SET purge_after = datetime('now', '-1 minute')").run();
    r2.state.parts = fullParts();
    expect(await finalizeReadyUploads(env(), r2.backend)).toEqual({ completed: 0, waiting: 0, rejected: 0, closed: 0, failed: 0 });
  });

  it("logs a failing session by id and goes on", async () => {
    const r2 = fakeR2();
    await openSession(r2);
    age(60);
    r2.backend.listParts = async () => {
      throw new R2RequestError("listParts", 403, "AccessDenied");
    };
    expect(await finalizeReadyUploads(env(), r2.backend)).toMatchObject({ failed: 1 });
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("AccessDenied");
  });

  it("does nothing without R2 credentials", async () => {
    expect(await finalizeReadyUploads({ DB: sqlite.db } as unknown as Env, fakeR2().backend)).toEqual({
      completed: 0,
      waiting: 0,
      rejected: 0,
      closed: 0,
      failed: 0,
    });
    expect(FINALIZE_SWEEP_BATCH).toBeGreaterThan(0);
  });
});

