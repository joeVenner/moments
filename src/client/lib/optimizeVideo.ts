import { createFile, DataStream, Endianness, type Movie, type Box } from "mp4box";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/**
 * Opt-in client-side video transcode (the "optimize before upload" toggle).
 *
 * Shrinks a large phone video before it ever hits the network — downscale to
 * ≤1280px + a bitrate derived from a target output size — so a 500 MB clip
 * becomes ~100 MB. This is a *bandwidth/time* optimization; the resumable
 * chunked uploader (multipartUpload.ts) already makes the raw 500 MB upload
 * work. It is OFF by default and only runs when (a) the toggle is on, (b)
 * WebCodecs is supported, and (c) the file is a large video. Any failure
 * returns `null` and the caller uploads the original — so a buggy transcode
 * can never lose a guest's video, it can only fail to optimize it.
 *
 * ⚠️ ON-DEVICE VALIDATION REQUIRED (2026-06-30): the muxed MP4 is NOT
 * runtime-verified in the dev sandbox (no real device/codec/file). The
 * demux→re-encode→remux pipeline below follows the canonical mp4box +
 * mp4-muxer + WebCodecs pattern, but A/V sync, the avcC description
 * serialization, and the AAC-LC AudioSpecificConfig must be confirmed on a
 * real iPhone with a real .mov before this is enabled by default. Gated
 * behind the opt-in toggle so default users are unaffected.
 *
 * Design choices that reduce blind risk:
 *  - H.264 Constrained Baseline (no B-frames) ⇒ DTS == CTS, so no
 *    composition-time-offset / B-frame reorder math to get wrong.
 *  - AAC-LC AudioSpecificConfig is COMPUTED from the track's sample rate +
 *    channel count (a 2-byte, well-defined encoding) rather than parsed from
 *    the source esds descriptor tree — correct for the common AAC-LC case
 *    (the vast majority of phone videos) and unit-testable.
 *  - Video + audio chunks are buffered then interleaved by timestamp before
 *    muxing, avoiding cross-track async ordering races.
 */

const MAX_DIMENSION = 1280;
const TARGET_OUTPUT_BYTES = 40 * 1024 * 1024; // aim for ~40MB regardless of source size
const MIN_SIZE_TO_OPTIMIZE = 25 * 1024 * 1024; // only bother for large files
const MIN_BITRATE = 800_000; // 0.8 Mbps floor — below this quality collapses
const MAX_BITRATE = 4_000_000; // 4 Mbps ceiling
const TARGET_FPS = 30;
const EXTRACTION_TIMEOUT_MS = 60_000;

// Constrained Baseline 3.1 — no B-frames (DTS==CTS), supports 720p30, widest
// device support incl. iOS 16.4+. isConfigSupported is checked at runtime.
const H264_CODEC = "avc1.42E01F";

let transcodeSupportCache: boolean | null = null;

/** Feature-detect WebCodecs encode/decode + the muxer deps. Cached. */
export function canTranscodeVideo(): boolean {
  if (transcodeSupportCache !== null) return transcodeSupportCache;
  transcodeSupportCache =
    typeof VideoDecoder !== "undefined" &&
    typeof VideoEncoder !== "undefined" &&
    typeof EncodedVideoChunk !== "undefined" &&
    typeof EncodedAudioChunk !== "undefined" &&
    typeof OffscreenCanvas !== "undefined";
  return transcodeSupportCache;
}

/** Test-only: clear the feature-detection cache so stubbed globals take effect. */
export function _resetTranscodeCacheForTests(): void {
  transcodeSupportCache = null;
}

/** Pure: should we even attempt to optimize this file? */
export function shouldOptimize(file: File): boolean {
  return (
    canTranscodeVideo() &&
    file.type.startsWith("video/") &&
    file.size >= MIN_SIZE_TO_OPTIMIZE
  );
}

const even = (n: number) => (n % 2 === 0 ? n : n - 1); // H.264 needs even w/h

/** Pure: downscale source dimensions to fit MAX_DIMENSION, keeping aspect + even. */
export function downscaleDimensions(srcW: number, srcH: number, max = MAX_DIMENSION) {
  if (srcW <= max && srcH <= max) return { width: even(srcW), height: even(srcH) };
  const scale = max / Math.max(srcW, srcH);
  return { width: even(Math.round(srcW * scale)), height: even(Math.round(srcH * scale)) };
}

/** Pure: target bitrate = bytes*8/duration, clamped, so output ≈ TARGET_OUTPUT_BYTES. */
export function pickBitrate(durationSec: number, targetBytes = TARGET_OUTPUT_BYTES) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MAX_BITRATE;
  return Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, Math.round((targetBytes * 8) / durationSec)));
}

/** Build the VideoEncoder config for the downscaled output. Pure. */
export function pickEncodeConfig(srcW: number, srcH: number, durationSec: number) {
  const { width, height } = downscaleDimensions(srcW, srcH);
  return {
    codec: H264_CODEC,
    width,
    height,
    bitrate: pickBitrate(durationSec),
    framerate: TARGET_FPS,
    avc: { format: "avc" as const },
  };
}

// AAC-LC sampling-frequency index table (ISO 14496-3 1.5.1.1).
const AAC_FREQ_INDEX: Record<number, number> = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6,
  22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12,
};

/**
 * Pure: the 2-byte AAC-LC AudioSpecificConfig for an AAC-LC track
 * (audioObjectType=2, samplingFrequencyIndex, channelConfiguration). Unit-testable,
 * correct for the common AAC-LC case most phone videos use. Returns null for
 * sample rates the LC table doesn't cover (caller then falls back to raw upload).
 */
export function aacSpecificConfig(sampleRate: number, channelCount: number): Uint8Array | null {
  const freqIndex = AAC_FREQ_INDEX[sampleRate];
  if (freqIndex === undefined) return null;
  if (channelCount < 1 || channelCount > 7) return null;
  const audioObjectType = 2; // AAC-LC
  // 5 bits type | 4 bits freqIndex | 4 bits channelConfig | 3 bits padding
  const bits = (audioObjectType << 11) | (freqIndex << 7) | (channelCount << 3);
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff]);
}

/** Serialize an mp4box codec-config box (avcC/hvcC) to bytes for VideoDecoder's
 *  `description`. mp4box's Box.write targets MultiBufferStream at the type level,
 *  but accepts a DataStream at runtime (the canonical WebCodecs pattern). */
function serializeDecoderConfigBox(box: Box): Uint8Array {
  box.computeSize?.();
  const size = (box as { size: number }).size;
  const stream = new DataStream(new ArrayBuffer(size), 0, Endianness.BIG_ENDIAN);
  (box as unknown as { write: (s: unknown) => void }).write(stream);
  return new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer);
}

/** Top-level entry. Returns an optimized File, or null to fall back to the original. */
export async function optimizeVideo(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<File | null> {
  if (!shouldOptimize(file)) return null;
  try {
    return await transcodeVideo(file, onProgress);
  } catch (err) {
    // Never let a transcode failure cost the upload — caller uploads the original.
    console.warn("[optimizeVideo] transcode failed, falling back to raw upload:", err);
    return null;
  }
}

async function transcodeVideo(file: File, onProgress?: (fraction: number) => void): Promise<File> {
  const buffer = await file.arrayBuffer();
  (buffer as unknown as { fileStart: number }).fileStart = 0;
  const iso = createFile();
  iso.appendBuffer(buffer as never);
  const info = await new Promise<Movie>((resolve) => {
    iso.onReady = (i) => resolve(i);
  });

  const vTrack = info.videoTracks?.[0];
  const aTrack = info.audioTracks?.[0];
  if (!vTrack) throw new Error("no video track");

  const durationSec = vTrack.duration / vTrack.timescale;
  const encodeConfig = pickEncodeConfig(vTrack.track_width, vTrack.track_height, durationSec);
  const supported = await VideoEncoder.isConfigSupported(encodeConfig);
  if (!supported.supported) throw new Error(`encoder does not support ${H264_CODEC}`);

  // Audio is REMUXED (not re-encoded). Bail to raw upload if we can't compute a
  // clean AAC-LC config (uncommon sample rate / channel layout).
  let aacConfig: Uint8Array | null = null;
  if (aTrack) {
    aacConfig = aacSpecificConfig(aTrack.audio?.sample_rate ?? 0, aTrack.audio?.channel_count ?? 0);
    if (!aacConfig) throw new Error("unsupported audio (non-LC sample rate / channels)");
  }

  // Decoder description = the source track's avcC/hvcC box, serialized to bytes.
  const trak = iso.getTrackById(vTrack.id);
  const stsdEntry = trak.mdia.minf.stbl.stsd.entries[0];
  const codecBox = (stsdEntry as { avcC?: Box; hvcC?: Box }).avcC ?? (stsdEntry as { hvcC?: Box }).hvcC;
  if (!codecBox) throw new Error("no avcC/hvcC decoder config in source");

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: encodeConfig.width, height: encodeConfig.height },
    audio: aTrack
      ? { codec: "aac", numberOfChannels: aTrack.audio!.channel_count, sampleRate: aTrack.audio!.sample_rate }
      : undefined,
    fastStart: "in-memory",
  });

  // Collect encoded chunks; interleave by timestamp once both pipelines settle.
  const videoChunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
  const audioChunks: { chunk: EncodedAudioChunk; meta?: object }[] = [];
  let videoKeyframeSeen = false;
  // VideoFrame exposes no keyframe flag, so we force an explicit GOP cadence
  // (first frame + every 30th) — guarantees keyframes the muxer/decoder need.
  let outputFrameIndex = 0;

  const decoder = new VideoDecoder({
    output: (frame) => {
      // Downscale via canvas, then re-encode at the ORIGINAL timestamp so the
      // video timeline matches the remuxed audio (sync preserved).
      const canvas = new OffscreenCanvas(encodeConfig.width, encodeConfig.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(frame, 0, 0, encodeConfig.width, encodeConfig.height);
      const scaled = new VideoFrame(canvas, {
        timestamp: frame.timestamp ?? 0,
        duration: frame.duration ?? undefined,
      });
      frame.close();
      const keyFrame = outputFrameIndex === 0 || outputFrameIndex % 30 === 0;
      encoder.encode(scaled, { keyFrame });
      outputFrameIndex++;
      scaled.close();
    },
    error: (e) => console.warn("[optimizeVideo] decoder error", e),
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description) videoKeyframeSeen = true;
      videoChunks.push({ chunk, meta });
      onProgress?.(Math.min(0.9, (videoChunks.length / Math.max(1, vTrack.nb_samples)) * 0.85));
    },
    error: (e) => console.warn("[optimizeVideo] encoder error", e),
  });

  decoder.configure({
    codec: vTrack.codec,
    codedWidth: vTrack.track_width,
    codedHeight: vTrack.track_height,
    description: serializeDecoderConfigBox(codecBox),
  });
  encoder.configure(encodeConfig);

  // mp4box has no "extraction complete" callback; onSamples fires in batches.
  // We count delivered samples against the track totals (a reliable signal) and
  // resolve once both tracks are fully delivered (with a safety timeout).
  const vTotal = vTrack.nb_samples;
  const aTotal = aTrack?.nb_samples ?? 0;
  let videoDelivered = 0;
  let audioDelivered = 0;
  let resolveExtraction: () => void;
  const extractionDone = new Promise<void>((r) => (resolveExtraction = r));
  const checkDone = () => {
    if (videoDelivered >= vTotal && audioDelivered >= aTotal) resolveExtraction();
  };

  const vScale = 1_000_000 / vTrack.timescale;
  const aScale = aTrack ? 1_000_000 / aTrack.timescale : 0;

  iso.onSamples = (_id, _user, samples) => {
    for (const s of samples) {
      if (s.track_id === vTrack.id) {
        videoDelivered++;
        decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: s.cts * vScale,
            duration: s.duration * vScale,
            data: s.data!,
          })
        );
      } else if (aTrack && s.track_id === aTrack.id) {
        audioDelivered++;
        const meta =
          audioChunks.length === 0 ? { decoderConfig: { description: aacConfig } } : undefined;
        audioChunks.push({
          chunk: new EncodedAudioChunk({
            type: "key",
            timestamp: s.cts * aScale,
            duration: s.duration * aScale,
            data: s.data!,
          }),
          meta,
        });
      }
      iso.releaseUsedSamples?.(s.track_id, s.number);
    }
    checkDone();
  };

  iso.setExtractionOptions(vTrack.id, undefined, { nbSamples: Infinity });
  if (aTrack) iso.setExtractionOptions(aTrack.id, undefined, { nbSamples: Infinity });
  iso.start();

  await Promise.race([
    extractionDone,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("mp4box extraction timed out")), EXTRACTION_TIMEOUT_MS)
    ),
  ]);

  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();
  iso.stop();

  // Interleave by timestamp (microseconds) so the muxer gets an ordered stream.
  const all: { t: number; add: () => void }[] = [];
  for (const v of videoChunks) {
    all.push({ t: v.chunk.timestamp, add: () => muxer.addVideoChunk(v.chunk, v.meta) });
  }
  if (aTrack) {
    for (const a of audioChunks) {
      all.push({ t: a.chunk.timestamp, add: () => muxer.addAudioChunk(a.chunk, a.meta as never) });
    }
  }
  all.sort((a, b) => a.t - b.t);
  for (const x of all) x.add();
  muxer.finalize();
  onProgress?.(1);

  if (!videoKeyframeSeen) throw new Error("no keyframe produced — output would be unplayable");
  if (!target.buffer) throw new Error("muxer produced no buffer");

  return new File([target.buffer], file.name.replace(/\.\w+$/, ".mp4"), {
    type: "video/mp4",
    lastModified: file.lastModified,
  });
}