import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canTranscodeVideo,
  shouldOptimize,
  downscaleDimensions,
  pickBitrate,
  pickEncodeConfig,
  aacSpecificConfig,
  // test-only escape hatch for the feature-detection cache
} from "./optimizeVideo";
import * as mod from "./optimizeVideo";

// The detection result is cached at module scope; reset between tests so stubbed
// globals take effect. (Re-importing per test is heavier than a reset.)
beforeEach(() => {
  vi.unstubAllGlobals();
  (mod as unknown as { _resetTranscodeCacheForTests: () => void })._resetTranscodeCacheForTests?.();
});

function stubWebCodecs(present: boolean) {
  const make = <T>(v: T) => (present ? v : undefined);
  vi.stubGlobal("VideoDecoder", make(class {}));
  vi.stubGlobal("VideoEncoder", make(class {}));
  vi.stubGlobal("EncodedVideoChunk", make(class {}));
  vi.stubGlobal("EncodedAudioChunk", make(class {}));
  vi.stubGlobal("OffscreenCanvas", make(class {}));
  (mod as unknown as { _resetTranscodeCacheForTests: () => void })._resetTranscodeCacheForTests?.();
}

describe("downscaleDimensions", () => {
  it("keeps sub-max dimensions as-is (evened)", () => {
    expect(downscaleDimensions(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("downscales the long edge to 1280 keeping aspect ratio", () => {
    expect(downscaleDimensions(1920, 1080)).toEqual({ width: 1280, height: 720 });
  });

  it("downscales a portrait video by its taller dimension", () => {
    expect(downscaleDimensions(1080, 1920)).toEqual({ width: 720, height: 1280 });
  });

  it("forces even dimensions (H.264 requirement)", () => {
    // 1280x721 → scale to fit 1280 wide → 1280 x 720.x → evened to 1280x720
    const r = downscaleDimensions(1280, 721);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
  });
});

describe("pickBitrate", () => {
  it("targets output size = bytes*8/duration, clamped to [min,max]", () => {
    // TARGET is 40 MiB. 40MiB*8/80s ≈ 4.19Mbps → clamped to the 4Mbps ceiling.
    expect(pickBitrate(80)).toBe(4_000_000);
    // 40MiB*8/500s ≈ 0.67Mbps → clamped to the 0.8Mbps floor.
    expect(pickBitrate(500)).toBe(800_000);
    // Unclamped midpoint: 40MiB*8/160s = 2,097,152 bps (2 Mbps).
    expect(pickBitrate(160)).toBe(2_097_152);
    // very short clip → ceiling
    expect(pickBitrate(10)).toBe(4_000_000);
  });

  it("falls back to the ceiling for non-finite/zero duration", () => {
    expect(pickBitrate(0)).toBe(4_000_000);
    expect(pickBitrate(NaN)).toBe(4_000_000);
  });
});

describe("pickEncodeConfig", () => {
  it("downscales and carries the computed bitrate + baseline codec", () => {
    const cfg = pickEncodeConfig(1920, 1080, 80);
    expect(cfg.codec).toBe("avc1.42E01F");
    expect(cfg.width).toBe(1280);
    expect(cfg.height).toBe(720);
    expect(cfg.bitrate).toBe(4_000_000);
    expect(cfg.avc.format).toBe("avc");
  });
});

describe("aacSpecificConfig", () => {
  // Reference values from the ISO 14496-3 1.5.1.1 layout:
  //   bits  = (audioObjectType<<11) | (freqIndex<<7) | (channelConfig<<3)
  //   byte0 = (bits>>8)&0xff, byte1 = bits&0xff
  it("encodes 44.1kHz stereo as the canonical AAC-LC 2-byte config", () => {
    // audioObjectType=2, freqIndex=4, channels=2 → bits 0x1210
    expect(Array.from(aacSpecificConfig(44100, 2)!)).toEqual([0x12, 0x10]);
  });

  it("encodes 48kHz mono", () => {
    // audioObjectType=2, freqIndex=3, channels=1 → bits 0x1188
    expect(Array.from(aacSpecificConfig(48000, 1)!)).toEqual([0x11, 0x88]);
  });

  it("returns null for a sample rate AAC-LC doesn't index", () => {
    expect(aacSpecificConfig(12345, 2)).toBeNull();
  });

  it("returns null for out-of-range channel counts", () => {
    expect(aacSpecificConfig(44100, 0)).toBeNull();
    expect(aacSpecificConfig(44100, 8)).toBeNull();
  });
});

describe("canTranscodeVideo", () => {
  it("is false without WebCodecs + OffscreenCanvas", () => {
    stubWebCodecs(false);
    expect(canTranscodeVideo()).toBe(false);
  });

  it("is true when all primitives are present", () => {
    stubWebCodecs(true);
    expect(canTranscodeVideo()).toBe(true);
  });
});

describe("shouldOptimize", () => {
  const bigVideo = new File(["x".repeat(30 * 1024 * 1024)], "v.mp4", { type: "video/mp4" });
  const smallVideo = new File(["x"], "v.mp4", { type: "video/mp4" });
  const bigImage = new File(["x".repeat(30 * 1024 * 1024)], "i.jpg", { type: "image/jpeg" });

  it("optimizes a large video when WebCodecs is available", () => {
    stubWebCodecs(true);
    expect(shouldOptimize(bigVideo)).toBe(true);
  });

  it("skips small videos, images, and unsupported environments", () => {
    stubWebCodecs(true);
    expect(shouldOptimize(smallVideo)).toBe(false);
    expect(shouldOptimize(bigImage)).toBe(false);
    stubWebCodecs(false);
    expect(shouldOptimize(bigVideo)).toBe(false);
  });
});