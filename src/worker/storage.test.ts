import { describe, expect, it, vi } from "vitest";
import { sanitizeFilename, isAllowedContentType, pointsForContentType, putMedia } from "./storage";
import type { Env } from "./types";

describe("sanitizeFilename", () => {
  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeFilename("my photo (1).jpg")).toBe("my_photo__1_.jpg");
  });

  it("keeps the tail when the name is very long", () => {
    const long = `${"x".repeat(100)}.jpg`;
    const result = sanitizeFilename(long);
    expect(result.length).toBe(80);
    expect(result.endsWith(".jpg")).toBe(true);
  });
});

describe("isAllowedContentType", () => {
  it("allows common image and video types", () => {
    expect(isAllowedContentType("image/jpeg")).toBe(true);
    expect(isAllowedContentType("video/mp4")).toBe(true);
    expect(isAllowedContentType("IMAGE/PNG")).toBe(true);
  });

  it("rejects arbitrary types", () => {
    expect(isAllowedContentType("text/plain")).toBe(false);
    expect(isAllowedContentType("application/pdf")).toBe(false);
    expect(isAllowedContentType("")).toBe(false);
  });
});

describe("pointsForContentType", () => {
  it("awards 1 point for images", () => {
    expect(pointsForContentType("image/jpeg")).toBe(1);
    expect(pointsForContentType("image/heic")).toBe(1);
  });

  it("awards 3 points for video, case-insensitively", () => {
    expect(pointsForContentType("video/mp4")).toBe(3);
    expect(pointsForContentType("VIDEO/QUICKTIME")).toBe(3);
  });
});

function fakeEnv() {
  return {
    BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env;
}

describe("putMedia", () => {
  it("rejects files over the size limit", async () => {
    const env = fakeEnv();
    const file = new File([new Uint8Array(1)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 26 * 1024 * 1024 });
    await expect(putMedia(env, "events/1/moments", file)).rejects.toThrow(/too large/i);
  });

  it("rejects disallowed content types", async () => {
    const env = fakeEnv();
    const file = new File(["hi"], "notes.txt", { type: "text/plain" });
    await expect(putMedia(env, "events/1/moments", file)).rejects.toThrow(/unsupported/i);
  });

  it("stores valid files under the given folder and returns a /media URL", async () => {
    const env = fakeEnv();
    const file = new File(["data"], "photo.jpg", { type: "image/jpeg" });
    const { key, url } = await putMedia(env, "events/1/moments", file);
    expect(key.startsWith("events/1/moments/")).toBe(true);
    expect(url).toBe(`/media/${key}`);
    expect(env.BUCKET.put).toHaveBeenCalledWith(
      key,
      file,
      expect.objectContaining({ httpMetadata: { contentType: "image/jpeg" } })
    );
  });
});
