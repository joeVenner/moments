import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinEventAsGuest, resolveGuestSession } from "./guestIdentity";
import { guestReactorId, setReaction } from "./reactions";
import { LEAVE_ABORT_BATCH, LEAVE_DELETE_BATCH, LEAVE_STREAM_BATCH, leaveEvent, leaveStorage, type LeaveStorage } from "./guestLeave";
import { R2RequestError } from "./multipartPresign";
import { createSqliteD1, type SqliteD1 } from "./testing/sqliteD1";
import type { MultipartBackend } from "./uploadSessions";

let sqlite: SqliteD1;
let bucket: { delete: ReturnType<typeof vi.fn<(keys: string | string[]) => Promise<void>>> };
let backend: MultipartBackend & { abort: ReturnType<typeof vi.fn> };
let deleteStreamVideo: ReturnType<typeof vi.fn<(uid: string) => Promise<void>>>;
const storage = (): LeaveStorage => ({ bucket, multipart: backend, deleteStreamVideo });

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
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id) VALUES (?, 'ev1', 'Sara', ?, ?)")
      .run(`m-${id}`, `/media/${key}`, participantId);
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
  deleteStreamVideo = vi.fn(async (_uid: string) => undefined);
});

describe("leaveEvent", () => {
  it("deletes only what the guest shared, then revokes the token", async () => {
    const sara = await joinAs("Sara");
    const lina = await joinAs("Lina");
    const mine = seedSession(sara.participantId, "completed", true);
    const linas = seedSession(lina.participantId, "completed", true);
    // An upload under the same name that never carried a token: it stays.
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('m-web', 'ev1', 'Sara', '/media/events/ev1/moments/web.jpg')").run();

    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });

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

    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: false });
    expect(backend.abort).toHaveBeenCalledTimes(LEAVE_ABORT_BATCH);
    // Still signed in, so the app can call again.
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();

    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
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
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: false });
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
  });

  it("still deletes the objects of sessions aborted before a failing abort", async () => {
    const sara = await joinAs("Sara");
    const first = seedSession(sara.participantId, "open");
    seedSession(sara.participantId, "open");
    backend.abort.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("R2 down"));
    await expect(leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).rejects.toThrow("R2 down");
    expect(bucket.delete).toHaveBeenCalledWith([`events/ev1/moments/${first}.jpg`]);
  });

  it("deletes many moments in batches", async () => {
    const sara = await joinAs("Sara");
    for (let i = 0; i < LEAVE_DELETE_BATCH + 1; i += 1) seedSession(sara.participantId, "completed", true);
    const guest = { eventId: "ev1", participantId: sara.participantId };
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: false });
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
    expect(count("SELECT COUNT(*) AS n FROM moments")).toBe(0);
  });

  it("keeps everything when storage fails, so a retry can finish", async () => {
    const sara = await joinAs("Sara");
    seedSession(sara.participantId, "completed", true);
    bucket.delete.mockRejectedValueOnce(new Error("R2 down"));
    const guest = { eventId: "ev1", participantId: sara.participantId };
    await expect(leaveEvent(sqlite.db, storage(), guest)).rejects.toThrow("R2 down");
    expect(count("SELECT COUNT(*) AS n FROM moments")).toBe(1);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
  });

  it("a guest with nothing shared just leaves", async () => {
    const sara = await joinAs("Sara");
    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("takes back the guest's hearts, and only those", async () => {
    const sara = await joinAs("Sara");
    const lina = await joinAs("Lina");
    const linaMoment = seedSession(lina.participantId, "completed", true);
    const momentId = `m-${linaMoment}`;
    const SARA_HEART = guestReactorId(sara.participantId);
    const LINA_HEART = guestReactorId(lina.participantId);
    const TOKENLESS = "33333333-3333-4333-8333-333333333333";
    for (const reactorId of [SARA_HEART, LINA_HEART, TOKENLESS]) {
      await setReaction(sqlite.db, { eventId: "ev1", momentId, reactorId, reacted: true });
    }
    // Sara's device hearted in another event too: that heart isn't this event's.
    sqlite.raw.prepare("INSERT INTO events (id, slug, title, type) VALUES ('ev2', 'other', 'Other', 'party')").run();
    sqlite.raw.prepare("INSERT INTO moments (id, event_id, uploader_name, media_url) VALUES ('x1', 'ev2', 'Sara', '/media/x1')").run();
    await setReaction(sqlite.db, { eventId: "ev2", momentId: "x1", reactorId: SARA_HEART, reacted: true });

    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });
    const left = sqlite.raw.prepare("SELECT reactor_id FROM moment_reactions WHERE moment_id = ? ORDER BY reactor_id").all(momentId) as { reactor_id: string }[];
    // "someone" is the heart seedSession puts on every moment it creates.
    expect(left.map((r) => r.reactor_id)).toEqual([LINA_HEART, TOKENLESS, "someone"].sort());
    expect(count("SELECT COUNT(*) AS n FROM moment_reactions WHERE moment_id = 'x1'")).toBe(1);
  });

  it("keeps the hearts while the guest is kept (something still open)", async () => {
    const sara = await joinAs("Sara");
    const lina = await joinAs("Lina");
    const momentId = `m-${seedSession(lina.participantId, "completed", true)}`;
    const SARA_HEART = guestReactorId(sara.participantId);
    await setReaction(sqlite.db, { eventId: "ev1", momentId, reactorId: SARA_HEART, reacted: true });
    for (let i = 0; i <= LEAVE_ABORT_BATCH; i++) seedSession(sara.participantId, "open");
    const guest = { eventId: "ev1", participantId: sara.participantId };
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: false });
    expect(count("SELECT COUNT(*) AS n FROM moment_reactions WHERE reactor_id = ?", SARA_HEART)).toBe(1);
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
    expect(count("SELECT COUNT(*) AS n FROM moment_reactions WHERE reactor_id = ?", SARA_HEART)).toBe(0);
  });

  it("deletes the guest's web moments too: photos with their thumbnails, and Stream videos", async () => {
    const sara = await joinAs("Sara");
    const uid = "a".repeat(32);
    const insert = sqlite.raw.prepare(
      `INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id, thumb_key)
       VALUES (?, 'ev1', 'Sara', ?, ?, ?)`
    );
    insert.run("m-photo", "/media/events/ev1/moments/web.jpg", sara.participantId, "events/ev1/thumbs/web.jpg");
    insert.run("m-video", `https://customer-abc123.cloudflarestream.com/${uid}/iframe`, sara.participantId, null);

    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });

    expect(bucket.delete).toHaveBeenCalledWith(["events/ev1/moments/web.jpg", "events/ev1/thumbs/web.jpg"]);
    expect(deleteStreamVideo).toHaveBeenCalledWith(uid);
    expect(count("SELECT COUNT(*) AS n FROM moments")).toBe(0);
  });

  it("aborts the guest's open web multipart upload (a row without client_upload_id)", async () => {
    const sara = await joinAs("Sara");
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, participant_id)
         VALUES ('w1', 'ev1', 'Sara', 'events/ev1/moments/big.mp4', 'mp-w1', 10, 'open', ?)`
      )
      .run(sara.participantId);

    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });

    expect(backend.abort).toHaveBeenCalledWith("events/ev1/moments/big.mp4", "mp-w1");
    expect(bucket.delete).toHaveBeenCalledWith(["events/ev1/moments/big.mp4"]);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).toBeNull();
  });

  it("deletes the video of an open web Stream upload instead of an R2 abort", async () => {
    const sara = await joinAs("Sara");
    const uid = "b".repeat(32);
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, participant_id)
         VALUES ('s1', 'ev1', 'Sara', ?, ?, 10, 'open', ?)`
      )
      .run(`stream/${uid}`, uid, sara.participantId);

    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });

    expect(deleteStreamVideo).toHaveBeenCalledWith(uid);
    expect(backend.abort).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).toBeNull();
  });

  it("keeps the guest and the moment when Stream fails, so a retry can finish", async () => {
    const sara = await joinAs("Sara");
    sqlite.raw
      .prepare("INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id) VALUES ('m1', 'ev1', 'Sara', ?, ?)")
      .run(`https://customer-abc123.cloudflarestream.com/${"c".repeat(32)}/iframe`, sara.participantId);
    deleteStreamVideo.mockRejectedValueOnce(new Error("Stream down"));
    const guest = { eventId: "ev1", participantId: sara.participantId };
    await expect(leaveEvent(sqlite.db, storage(), guest)).rejects.toThrow("Stream down");
    expect(count("SELECT COUNT(*) AS n FROM moments")).toBe(1);
    expect(await resolveGuestSession(sqlite.db, "ev1", sara.token)).not.toBeNull();
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
  });

  it("deletes every derived image with the object, Stream and R2 moments in one call", async () => {
    const sara = await joinAs("Sara");
    const uid = "d".repeat(32);
    sqlite.raw
      .prepare(
        `INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id, thumb_key, display_key, poster_key)
         VALUES ('m1', 'ev1', 'Sara', '/media/events/ev1/moments/a.jpg', ?, 'events/ev1/t/a.jpg', 'events/ev1/d/a.jpg', NULL),
                ('m2', 'ev1', 'Sara', ?, ?, NULL, NULL, 'events/ev1/p/v.jpg')`
      )
      .run(sara.participantId, `https://customer-abc123.cloudflarestream.com/${uid}/iframe`, sara.participantId);

    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });

    expect(bucket.delete).toHaveBeenCalledTimes(1);
    expect([...(bucket.delete.mock.calls[0]?.[0] as string[])].sort()).toEqual(
      ["events/ev1/moments/a.jpg", "events/ev1/t/a.jpg", "events/ev1/d/a.jpg", "events/ev1/p/v.jpg"].sort()
    );
    expect(deleteStreamVideo).toHaveBeenCalledExactlyOnceWith(uid);
  });

  it("deletes a bounded number of Stream videos per call", async () => {
    const sara = await joinAs("Sara");
    const insert = sqlite.raw.prepare(
      "INSERT INTO moments (id, event_id, uploader_name, media_url, participant_id) VALUES (?, 'ev1', 'Sara', ?, ?)"
    );
    for (let i = 0; i < LEAVE_STREAM_BATCH + 2; i += 1) {
      const uid = i.toString(16).padStart(32, "0");
      insert.run(`v${i}`, `https://customer-abc123.cloudflarestream.com/${uid}/iframe`, sara.participantId);
    }
    insert.run("photo", "/media/events/ev1/moments/p.jpg", sara.participantId);
    const guest = { eventId: "ev1", participantId: sara.participantId };

    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: false });
    expect(deleteStreamVideo).toHaveBeenCalledTimes(LEAVE_STREAM_BATCH);
    // Photos in the same batch aren't held back by the cap.
    expect(count("SELECT COUNT(*) AS n FROM moments WHERE id = 'photo'")).toBe(0);
    expect(await leaveEvent(sqlite.db, storage(), guest)).toEqual({ done: true });
    expect(deleteStreamVideo).toHaveBeenCalledTimes(LEAVE_STREAM_BATCH + 2);
  });

  it("counts a web multipart R2 no longer has as aborted", async () => {
    const sara = await joinAs("Sara");
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, participant_id)
         VALUES ('w1', 'ev1', 'Sara', 'events/ev1/moments/big.mp4', 'mp-w1', 10, 'open', ?)`
      )
      .run(sara.participantId);
    backend.abort.mockRejectedValueOnce(new R2RequestError("AbortMultipartUpload", 404, "NoSuchUpload"));
    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });
  });

  it("closes a Stream session that has no video yet, without touching storage", async () => {
    const sara = await joinAs("Sara");
    sqlite.raw
      .prepare(
        `INSERT INTO uploads (id, event_id, uploader_name, key, upload_id, size_bytes, status, participant_id)
         VALUES ('s0', 'ev1', 'Sara', 'stream-session/s0', 's0', 10, 'open', ?)`
      )
      .run(sara.participantId);
    expect(await leaveEvent(sqlite.db, storage(), { eventId: "ev1", participantId: sara.participantId })).toEqual({ done: true });
    expect(backend.abort).not.toHaveBeenCalled();
    expect(deleteStreamVideo).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("refuses to report a Stream video deleted when Stream isn't configured", async () => {
    const real = leaveStorage({ BUCKET: bucket, DB: sqlite.db } as unknown as Parameters<typeof leaveStorage>[0]);
    await expect(real.deleteStreamVideo("f".repeat(32))).rejects.toThrow("Stream is not configured");
  });
});
