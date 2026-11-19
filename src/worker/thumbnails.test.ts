import { describe, expect, it } from "vitest";
import {
  acceptThumbnail,
  isThumbnailUploadKey,
  isValidThumbnailSize,
  MAX_THUMBNAIL_BYTES,
  type ThumbnailStore,
  thumbnailKey,
  thumbnailKeys,
  thumbnailUploadKey,
} from "./thumbnails";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function store(uploaded: { contentType: string; size?: number; bytes: Uint8Array } | null) {
  const deleted: string[] = [];
  const written = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const fake: ThumbnailStore = {
    head: async (key) =>
      key === "k.thumb-upload.jpg" && uploaded ? { contentType: uploaded.contentType, size: uploaded.size ?? uploaded.bytes.length } : null,
    readAll: async (key) => (key === "k.thumb-upload.jpg" ? uploaded?.bytes ?? null : null),
    put: async (key, bytes, contentType) => void written.set(key, { bytes, contentType }),
    deleteObject: async (key) => void deleted.push(key),
  };
  return { fake, deleted, written };
}

describe("thumbnails", () => {
  it("uploads to a slot that is never served, and serves a copy beside the file", () => {
    expect(thumbnailUploadKey("events/e1/moments/a.jpg")).toBe("events/e1/moments/a.jpg.thumb-upload.jpg");
    expect(thumbnailKey("events/e1/moments/a.jpg")).toBe("events/e1/moments/a.jpg.thumb.jpg");
    expect(thumbnailKeys("k")).toEqual(["k.thumb-upload.jpg", "k.thumb.jpg"]);
    expect(isThumbnailUploadKey("events/e1/moments/a.jpg.thumb-upload.jpg")).toBe(true);
    expect(isThumbnailUploadKey("events/e1/moments/a.jpg.thumb.jpg")).toBe(false);
  });

  it("accepts sizes from 1 byte to the limit", () => {
    expect(isValidThumbnailSize(1)).toBe(true);
    expect(isValidThumbnailSize(MAX_THUMBNAIL_BYTES)).toBe(true);
    expect(isValidThumbnailSize(0)).toBe(false);
    expect(isValidThumbnailSize(MAX_THUMBNAIL_BYTES + 1)).toBe(false);
    expect(isValidThumbnailSize(1.5)).toBe(false);
  });

  it("copies a whole JPEG to the served key, then deletes the upload", async () => {
    const { fake, deleted, written } = store({ contentType: "image/jpeg", bytes: JPEG });
    expect(await acceptThumbnail(fake, "k")).toBe("k.thumb.jpg");
    expect(written.get("k.thumb.jpg")).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
    expect(deleted).toEqual(["k.thumb-upload.jpg"]);
  });

  it("returns null when there is none", async () => {
    const { fake, deleted, written } = store(null);
    expect(await acceptThumbnail(fake, "k")).toBeNull();
    expect(deleted).toEqual([]);
    expect(written.size).toBe(0);
  });

  it.each([
    ["another type", { contentType: "text/html", bytes: JPEG }],
    ["one over the limit", { contentType: "image/jpeg", size: MAX_THUMBNAIL_BYTES + 1, bytes: JPEG }],
    ["bytes that aren't a JPEG", { contentType: "image/jpeg", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]) }],
    ["a cut-off JPEG", { contentType: "image/jpeg", bytes: JPEG.slice(0, 6) }],
    ["an empty file", { contentType: "image/jpeg", bytes: new Uint8Array() }],
  ])("drops %s", async (_name, uploaded) => {
    const { fake, deleted, written } = store(uploaded);
    expect(await acceptThumbnail(fake, "k")).toBeNull();
    expect(deleted).toEqual(["k.thumb-upload.jpg"]);
    expect(written.size).toBe(0);
  });
});
