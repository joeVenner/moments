/**
 * Lightweight detection for the opt-in "optimize before upload" feature.
 * Deliberately imports NOTHING heavy (no mp4box / mp4-muxer) so the toggle can
 * be shown/hidden cheaply in the upload UI without bloating the main bundle.
 * The actual transcode pipeline lives in `optimizeVideo.ts`, which the app
 * dynamic-imports only when the user actually enables the feature on a large
 * video — keeping mp4box + mp4-muxer (~56KB gzip) out of the default bundle.
 */

const MIN_SIZE_TO_OPTIMIZE = 25 * 1024 * 1024; // only bother for large files

let transcodeSupportCache: boolean | null = null;

/** Feature-detect WebCodecs encode/decode (the muxer deps are verified on use). Cached. */
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

/** Pure: should we even attempt to optimize this file? */
export function shouldOptimize(file: File): boolean {
  return (
    canTranscodeVideo() &&
    file.type.startsWith("video/") &&
    file.size >= MIN_SIZE_TO_OPTIMIZE
  );
}

/** Test-only: clear the feature-detection cache so stubbed globals take effect. */
export function _resetTranscodeCacheForTests(): void {
  transcodeSupportCache = null;
}

export { MIN_SIZE_TO_OPTIMIZE };