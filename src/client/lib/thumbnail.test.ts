import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_REQUEST_TIMEOUT_MS,
  encodeThumbnail,
  isWholeJpeg,
  makeThumbnail,
  sendThumbnail,
  thumbnailDimensions,
} from "./thumbnail";

const jpeg = (size: number) => {
  const bytes = new Uint8Array(Math.max(4, size));
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return new Blob([bytes], { type: "image/jpeg" });
};

describe("thumbnailDimensions", () => {
  it("fits the longest side in 400 px, keeping the shape", () => {
    expect(thumbnailDimensions(4032, 3024)).toEqual({ width: 400, height: 300 });
    expect(thumbnailDimensions(1080, 1920)).toEqual({ width: 225, height: 400 });
  });
  it("never upscales and never rounds to nothing", () => {
    expect(thumbnailDimensions(200, 100)).toEqual({ width: 200, height: 100 });
    expect(thumbnailDimensions(10000, 1)).toEqual({ width: 400, height: 1 });
  });
  it.each([[0, 10], [10, 0], [-1, 10], [NaN, 10], [Infinity, 10]])("refuses %s × %s", (w, h) => {
    expect(thumbnailDimensions(w, h)).toBeNull();
  });
});

describe("isWholeJpeg", () => {
  it("needs the start and end markers", async () => {
    expect(isWholeJpeg(new Uint8Array(await jpeg(10).arrayBuffer()))).toBe(true);
    expect(isWholeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe(false);
    expect(isWholeJpeg(new Uint8Array([0x89, 0x50, 0xff, 0xd9]))).toBe(false);
    expect(isWholeJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});

describe("encodeThumbnail", () => {
  it("lowers the quality until it fits", async () => {
    const qualities: number[] = [];
    const blob = await encodeThumbnail(async (q) => {
      qualities.push(q);
      return jpeg(q > 0.5 ? MAX_THUMBNAIL_BYTES + 1 : 1000);
    });
    expect(blob?.size).toBe(1000);
    expect(qualities).toEqual([0.75, 0.6, 0.45]);
  });
  it("gives up when nothing fits", async () => {
    expect(await encodeThumbnail(async () => jpeg(MAX_THUMBNAIL_BYTES + 1))).toBeNull();
  });
  it("refuses anything but a whole JPEG (a browser that falls back to PNG)", async () => {
    expect(await encodeThumbnail(async () => new Blob([new Uint8Array(10)], { type: "image/png" }))).toBeNull();
    expect(await encodeThumbnail(async () => new Blob([new Uint8Array(10)], { type: "image/jpeg" }))).toBeNull();
    expect(await encodeThumbnail(async () => null)).toBeNull();
  });
});

describe("makeThumbnail", () => {
  it("gives nothing for a file it can't read, never an error", async () => {
    // Node has no createImageBitmap or document.
    expect(await makeThumbnail(new File([new Uint8Array(4)], "a.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(await makeThumbnail(new File([new Uint8Array(4)], "a.mp4", { type: "video/mp4" }))).toBeNull();
    expect(await makeThumbnail(new File([new Uint8Array(4)], "a.txt", { type: "text/plain" }))).toBeNull();
  });
});

describe("sendThumbnail", () => {
  afterEach(() => vi.unstubAllGlobals());
  const target = { slug: "party", uploadId: "mp-1", key: "events/ev1/moments/a.jpg", headers: { "X-Guest-Token": "gt-test" } };
  const signedURL = "https://acct.r2.cloudflarestorage.com/moments-media/a.thumb-upload.jpg?X-Amz-Signature=s";

  it("asks for the URL with the guest's token, then PUTs only the JPEG there", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ url: signedURL, expires_in: 21600 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const thumbnail = jpeg(500);
    expect(await sendThumbnail(thumbnail, target)).toBe(true);
    const [askURL, ask] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(askURL).toBe("/api/events/party/moments/multipart/thumbnail-url");
    expect(ask.headers).toMatchObject({ "X-Guest-Token": "gt-test" });
    expect(JSON.parse(ask.body as string)).toEqual({ upload_id: "mp-1", key: target.key, size: 500 });
    const [putURL, put] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putURL).toBe(signedURL);
    // Storage gets nothing of the guest's.
    expect(put).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: thumbnail, credentials: "omit", redirect: "error" });
  });

  it("never throws, and never sends when the server says no", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "guest_required" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendThumbnail(jpeg(10), target)).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await sendThumbnail(jpeg(10), target)).toBe(false);
  });

  it("refuses a URL that isn't https, and a storage refusal is false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ url: "http://evil.example/x" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendThumbnail(jpeg(10), target)).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ url: signedURL }))
      .mockResolvedValueOnce(new Response(null, { status: 403 })));
    expect(await sendThumbnail(jpeg(10), target)).toBe(false);
  });

  it("gives up on a request that hangs, so complete never waits for long", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));
      const sent = sendThumbnail(jpeg(10), target);
      await vi.advanceTimersByTimeAsync(THUMBNAIL_REQUEST_TIMEOUT_MS);
      expect(await sent).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at once when the upload is cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      init.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : Promise.resolve(new Response())
    );
    expect(await sendThumbnail(jpeg(10), { ...target, signal: controller.signal })).toBe(false);
  });

  it("never asks for a thumbnail the server would refuse", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendThumbnail(jpeg(MAX_THUMBNAIL_BYTES + 1), target)).toBe(false);
    expect(await sendThumbnail(new Blob([new Uint8Array(10)], { type: "image/png" }), target)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
