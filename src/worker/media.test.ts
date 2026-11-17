import { describe, expect, it } from "vitest";
import { buildMomentMedia, mediaKeyUrl, mediaKind, parseStreamMediaUrl } from "./media";

const UID = "0123456789abcdef0123456789abcdef";
const STREAM_URL = `https://customer-abc123.cloudflarestream.com/${UID}/iframe`;

describe("parseStreamMediaUrl", () => {
  it("extracts host and uid from Stream iframe URLs only", () => {
    expect(parseStreamMediaUrl(STREAM_URL)).toEqual({ host: "customer-abc123.cloudflarestream.com", uid: UID });
    expect(parseStreamMediaUrl("/media/events/e/moments/a.mp4")).toBeNull();
    expect(parseStreamMediaUrl(`https://evil.example/${UID}/iframe`)).toBeNull();
    expect(parseStreamMediaUrl(`https://customer-abc123.cloudflarestream.com/${UID}/iframe?x=1`)).toBeNull();
  });
});

describe("mediaKind", () => {
  it.each([
    [{ media_url: "/media/a.jpg", mime_type: "image/jpeg" }, "image"],
    [{ media_url: "/media/a.bin", mime_type: "video/quicktime" }, "video"],
    [{ media_url: "/media/old.MOV", mime_type: null }, "video"],
    [{ media_url: STREAM_URL, mime_type: null }, "video"],
    [{ media_url: "/media/old.heic", mime_type: null }, "image"],
  ] as const)("%j -> %s", (row, kind) => {
    expect(mediaKind(row)).toBe(kind);
  });
});

describe("buildMomentMedia", () => {
  it("returns nulls and the original url for a bare legacy image", () => {
    expect(buildMomentMedia({ event_id: "e1", media_url: "/media/events/e1/moments/a.jpg", mime_type: "image/jpeg" })).toEqual({
      kind: "image",
      url: "/media/events/e1/moments/a.jpg",
      thumb_url: null,
      display_url: null,
      poster_url: null,
      hls_url: null,
      width: null,
      height: null,
      duration_ms: null,
      blurhash: null,
    });
  });

  it("derives HLS and poster URLs for Stream videos", () => {
    const media = buildMomentMedia({ event_id: "e1", media_url: STREAM_URL, mime_type: "video/mp4", duration_ms: 4200 });
    expect(media.hls_url).toBe(`https://customer-abc123.cloudflarestream.com/${UID}/manifest/video.m3u8`);
    expect(media.poster_url).toBe(`https://customer-abc123.cloudflarestream.com/${UID}/thumbnails/thumbnail.jpg`);
    expect(media.duration_ms).toBe(4200);
  });

  it("serves derived keys only from the moment's own event prefix", () => {
    const media = buildMomentMedia({
      event_id: "e1",
      media_url: "/media/events/e1/moments/a.jpg",
      mime_type: "image/jpeg",
      thumb_key: "events/e1/thumbs/a.jpg",
      display_key: "events/e2/display/a.jpg",
      poster_key: "events/e1/../e2/p.jpg",
      width: 4032,
      height: 3024,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    });
    expect(media.thumb_url).toBe("/media/events/e1/thumbs/a.jpg");
    expect(media.display_url).toBeNull();
    expect(media.poster_url).toBeNull();
    expect(media).toMatchObject({ width: 4032, height: 3024, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" });
  });
});

describe("mediaKeyUrl", () => {
  it.each([
    ["events/e1/thumbs/a.jpg", "/media/events/e1/thumbs/a.jpg"],
    ["events/e1/a..b.jpg", "/media/events/e1/a..b.jpg"],
    ["events/e10/a.jpg", null],
    ["events/e1/../e2/a.jpg", null],
    ["events/e1/./a.jpg", null],
    ["events/e1//a.jpg", null],
    ["events/e1/a.jpg?x=1", null],
    ["events/e1/a%2e%2e.jpg", null],
    ["events/e1/a#b.jpg", null],
    ["events/e1/", null],
    ["covers/a.jpg", null],
  ])("%j -> %j", (key, expected) => {
    expect(mediaKeyUrl(key, "e1")).toBe(expected);
  });
});

describe("buildMomentMedia precedence", () => {
  it("prefers a stored poster over the derived Stream poster", () => {
    const media = buildMomentMedia({
      event_id: "e1",
      media_url: STREAM_URL,
      mime_type: "video/mp4",
      poster_key: "events/e1/posters/p.jpg",
    });
    expect(media.poster_url).toBe("/media/events/e1/posters/p.jpg");
  });

  it("treats a non-video mime type as an image even with a video extension", () => {
    expect(mediaKind({ media_url: "/media/a.mp4", mime_type: "application/octet-stream" })).toBe("image");
  });
});
