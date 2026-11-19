import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteMomentMedia } from "./moderation";
import type { Env } from "./types";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    BUCKET: { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket,
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...overrides,
  };
}

describe("deleteMomentMedia", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes Worker-served media from R2 using the original key", async () => {
    const env = environment();
    await deleteMomentMedia(env, { media_url: "/media/events/event-id/moments/file.png" });
    expect(env.BUCKET.delete).toHaveBeenCalledWith("events/event-id/moments/file.png");
  });

  it("deletes the moment's thumbnail and other derived images too", async () => {
    const env = environment();
    await deleteMomentMedia(env, {
      media_url: "/media/events/event-id/moments/file.jpg",
      thumb_key: "events/event-id/moments/file.jpg.thumb.jpg",
      display_key: null,
    });
    expect(env.BUCKET.delete).toHaveBeenCalledWith(["events/event-id/moments/file.jpg.thumb.jpg"]);
    expect(env.BUCKET.delete).toHaveBeenCalledWith("events/event-id/moments/file.jpg");
  });

  it("deletes a configured Stream asset by UID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = environment({
      STREAM_ACCOUNT_ID: "account",
      STREAM_API_TOKEN: "token",
      STREAM_CUSTOMER_CODE: "customer",
    });

    await deleteMomentMedia(env, { media_url: "https://customer-customer.cloudflarestream.com/video-uid/iframe" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account/stream/video-uid",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
