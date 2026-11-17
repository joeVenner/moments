import { describe, expect, it, vi } from "vitest";
import { cleanupEvent } from "./lifecycle";
import type { Env, MomentRow } from "./types";

describe("cleanupEvent", () => {
  it("removes indexed media, remaining prefix objects, and event-owned rows", async () => {
    const moment: MomentRow = {
      id: "moment",
      event_id: "event",
      uploader_name: "guest",
      media_url: "/media/events/event/moments/photo.png",
      caption: null,
      points_awarded: 1,
      created_at: "2026-01-01 00:00:00",
      size_bytes: 100,
      mime_type: "image/png",
      moderation_status: "approved",
    };
    const statements: unknown[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => {
          const statement = {
            sql,
            args,
            all: vi.fn().mockResolvedValue({ results: sql.startsWith("SELECT") ? [moment] : [] }),
          };
          statements.push(statement);
          return statement;
        },
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;
    const bucket = {
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        objects: [{ key: "events/event/cover/cover.png" }],
        truncated: false,
      }),
    } as unknown as R2Bucket;
    const env = {
      DB: db,
      BUCKET: bucket,
      ASSETS: {} as Fetcher,
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "secret",
      ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    } satisfies Env;

    await cleanupEvent(env, { id: "event" });

    expect(bucket.delete).toHaveBeenCalledWith("events/event/moments/photo.png");
    expect(bucket.delete).toHaveBeenCalledWith(["events/event/cover/cover.png"]);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(6);
  });
});
