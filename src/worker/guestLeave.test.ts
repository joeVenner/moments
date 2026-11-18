import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest, resolveGuestSession } from "./guestIdentity";
import { LEAVE_ABORT_BATCH, LEAVE_DELETE_BATCH, leaveEvent } from "./guestLeave";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { MultipartBackend } from "./uploadSessions";

let sqlite: SqliteD1;
let bucket: { delete: ReturnType<typeof vi.fn<(keys: string | string[]) => Promise<void>>> };
let backend: MultipartBackend & { abort: ReturnType<typeof vi.fn> };

async function joinAs(nickname: string): Promise<{ participantId: string; token: string }> {
  const result = await joinEventAsGuest(sqlite.db, {
    eventId: "ev1",
    nickname,
    avatarSeed: null,
    presentedToken: null,
    enforceClaims: true,
  });
  if (!result.ok || !result.guestToken) throw new Error("join failed");
  return { participantId: result.participant.id, token: result.guestToken };
}

let seq = 0;
/** A v1 session row; `moment: true` also creates its moment (and a reaction on it). */
function seedSession(participantId: string | null, status: "open" | "completed" | "aborted", moment = false): string {
  const id = `u${++seq}`;
  const key = `events/ev1/moments/${id}.jpg`;
  sqlite.raw
    .prepare(
      `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, client_upload_id, participant_id, caption)
       VALUES (?, 'ev1', 'Sara', ?, ?, 10, ?, ?, ?, 'secret caption')`
    )
    .run(id, key, `mp-${id}`, status, crypto.randomUUID(), participantId);
  if (moment) {
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES (?, 'ev1', 'Sara', ?)").run(`m-${id}`, `/media/${key}`);
    sqlite.raw
      .prepare("INSERT INTO moment_reactions (id, moment_id, event_id, reactor_id) VALUES (?, ?, 'ev1', 'someone')")
      .run(`r-${id}`, `m-${id}`);
  }
  return id;
}

const count = (sql: string, ...args: string[]) => (sqlite.raw.prepare(sql).get(...args) as { n: number }).n;

beforeEach(() => {
  sqlite = createSqliteD1();
  sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev1', 'party', 'Party', 'party')").run();
  bucket = { delete: vi.fn(async (_keys: string | string[]) => undefined) };
  backend = {
    create: vi.fn(),
    presignPart: vi.fn(),
    listParts: vi.fn(),
    abort: vi.fn(async () => undefined),
  };
});

describe("leaveEvent", () => {
  it("deletes only what the guest shared from the app, then revokes the token", async () => {
    const sara = await joinAs("Sara");
    const lina = await joinAs("Lina");
    const mine = seedSession(sara.participantId, "completed", true);
    const linas = seedSession(lina.participantId, "completed", true);
    // A web upload under the same name never carried a token: it stays.
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('m-web', 'ev1', 'Sara', '/media/events/ev1/moments/web.jpg')").run();

    expect(await leaveEvent(sqlite.db, bucket, backend, { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });

    expect(bucket.delete).toHaveBeenCalledWith([`events/ev1/moments/${mine}.jpg`]);
    const left = sqlite.raw.prepare("SELECT id FROM moments ORDER BY id").all() as { id: string }[];
    expect(left.map((m) => m.id)).toEqual([`m-${linas}`, "m-web"]);
    expect(count("SELECT COUNT(*) AS n FROM moment_reactions WHERE moment_id = ?", `m-${mine}`)).toBe(0);
    // The feed sees the deletion.
    expect(count("SELECT COUNT(*) AS n FROM moment_tombstones WHERE moment_id = ?", `m-${mine}`)).toBe(1);
    // No caption or name of hers is kept; the token is dead and the name free.
    expect(count("SELECT COUNT(*) AS n FROM uploads WHERE participant_id = ?", sara.participantId)).toBe(0);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM participants WHERE nickname = 'Sara'")).toBe(0);
    expect(await resolveGuestSession(sqlite.db, "ev1", lina.token)).not.toBeNull();
    expect((await joinAs("Sara")).token).toMatch(/^gt_/);
  });

  it("aborts open sessions first, over several calls, before letting go", async () => {
    const sara = await joinAs("Sara");
    const open = Array.from({ length: LEAVE_ABORT_BATCH + 3 }, () => seedSession(sara.participantId, "open"));
    const guest = { eventId: "ev1", participantId: sara.participantId };

    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: false });
    expect(backend.abort).toHaveBeenCalledTimes(LEAVE_ABORT_BATCH);
    // Still signed in, so the app can call again.
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();

    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: true });
    expect(backend.abort).toHaveBeenCalledTimes(open.length);
    // Aborted keys are deleted too (an object finalize assembled but never registered).
    expect(bucket.delete.mock.calls.flatMap(([keys]) => keys)).toEqual(open.map((id) => `events/ev1/moments/${id}.jpg`));
    // Nothing is left for the finalize sweep to turn into a moment.
    expect(count("SELECT COUNT(*) AS n FROM uploads WHERE status = 'open'")).toBe(0);
  });

  it("keeps the guest when a session opens meanwhile", async () => {
    const sara = await joinAs("Sara");
    seedSession(sara.participantId, "open");
    // Another request opens a session while this one aborts the first.
    backend.abort.mockImplementationOnce(async () => {
      seedSession(sara.participantId, "open");
    });
    const guest = { eventId: "ev1", participantId: sara.participantId };
    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: false });
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();
    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: true });
  });

  it("still deletes the objects of sessions aborted before a failing abort", async () => {
    const sara = await joinAs("Sara");
    const first = seedSession(sara.participantId, "open");
    seedSession(sara.participantId, "open");
    backend.abort.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("R2 down"));
    await expect(leaveEvent(sqlite.db, bucket, backend, { eventId: "ev1", participantId: sara.participantId })).rejects.toThrow("R2 down");
    expect(bucket.delete).toHaveBeenCalledWith([`events/ev1/moments/${first}.jpg`]);
  });

  it("deletes many moments in batches", async () => {
    const sara = await joinAs("Sara");
    for (let i = 0; i < LEAVE_DELETE_BATCH + 1; i += 1) seedSession(sara.participantId, "completed", true);
    const guest = { eventId: "ev1", participantId: sara.participantId };
    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: false });
    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: true });
    expect(count("SELECT COUNT(*) AS n FROM moments")).toBe(0);
  });

  it("keeps everything when storage fails, so a retry can finish", async () => {
    const sara = await joinAs("Sara");
    seedSession(sara.participantId, "completed", true);
    bucket.delete.mockRejectedValueOnce(new Error("R2 down"));
    const guest = { eventId: "ev1", participantId: sara.participantId };
    await expect(leaveEvent(sqlite.db, bucket, backend, guest)).rejects.toThrow("R2 down");
    expect(count("SELECT COUNT(*) AS n FROM moments")).toBe(1);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();
    expect(await leaveEvent(sqlite.db, bucket, backend, guest)).toEqual({ done: true });
  });

  it("a guest with nothing shared just leaves", async () => {
    const sara = await joinAs("Sara");
    expect(await leaveEvent(sqlite.db, bucket, backend, { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});
