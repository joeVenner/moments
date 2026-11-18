import { describe, expect, it } from "vitest";
import { matchesContentType, SIGNATURE_BYTES } from "./mediaSignature";

const bytes = (...parts: (number[] | string)[]) => {
  const out: number[] = [];
  for (const part of parts) out.push(...(typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part));
  while (out.length < SIGNATURE_BYTES) out.push(0);
  return new Uint8Array(out);
};

const SAMPLES: Record<string, Uint8Array> = {
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0]),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: bytes("GIF89a"),
  webp: bytes("RIFF", [1, 2, 3, 4], "WEBP"),
  isoMedia: bytes([0, 0, 0, 0x18], "ftypheic"),
  mp4: bytes([0, 0, 0, 0x20], "ftypisom"),
  oldMov: bytes([0, 0, 0, 8], "wide"),
  webm: bytes([0x1a, 0x45, 0xdf, 0xa3]),
  html: bytes("<!doctype html>"),
};

describe("matchesContentType", () => {
  it.each([
    ["image/jpeg", "jpeg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["image/heic", "isoMedia"],
    ["image/heif", "isoMedia"],
    ["video/mp4", "mp4"],
    ["video/quicktime", "mp4"],
    ["video/quicktime", "oldMov"],
    ["video/webm", "webm"],
    ["IMAGE/JPEG", "jpeg"],
  ])("accepts %s from a %s header", (type, sample) => {
    expect(matchesContentType(SAMPLES[sample], type)).toBe(true);
  });

  it.each([
    ["image/jpeg", "html"],
    ["image/png", "jpeg"],
    ["image/webp", "gif"],
    ["video/mp4", "oldMov"],
    ["video/webm", "mp4"],
    ["image/svg+xml", "html"],
    ["image/jpeg", "empty"],
  ])("rejects %s from a %s header", (type, sample) => {
    expect(matchesContentType(SAMPLES[sample] ?? new Uint8Array(), type)).toBe(false);
  });
});
