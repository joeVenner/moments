import type { MomentData } from "./types";
import {
  saveUpload,
  getUpload,
  deleteUpload,
  type PersistedUpload,
} from "./uploadStore";

/**
 * Resumable chunked uploader for large videos (the >25 MB path).
 *
 * Splits the file into 8 MiB parts and PUTs each one straight to R2 through a
 * Worker-minted presigned URL — the Worker never sees the bytes. Three parts
 * run concurrently; each part is XHR'd so we get real upload-acked progress
 * (fetch streaming-upload progress is Chrome-only and inaccurate).
 *
 * Resilience to "the user put their phone down":
 *  - Chunking bounds any interruption to ONE part (~8 MB), not the whole file.
 *  - Per-part retries (3×, backoff) ride out transient cellular drops.
 *  - On `visibilitychange → visible` we reconcile against R2's ListParts — the
 *    server is the source of truth — so parts that finished (or didn't) during
 *    iOS background suspension are reflected exactly, and we never re-upload a
 *    part R2 already has.
 *  - Progress is mirrored to IndexedDB so a same-session reload resumes with no
 *    server round-trip, and a cold reload re-matches a re-picked file to its
 *    in-progress upload.
 *
 * The screen wake lock (useUploadWakeLock) keeps the foregrounded tab from
 * dozing; no web API can keep an upload alive after iOS fully backgrounds the
 * app, but this makes that interruption cheap and recoverable.
 */

const CONCURRENCY = 3;
const MAX_PART_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

/** Thrown when a part can't be uploaded after all retries — the R2 multipart
 *  upload is left OPEN so the caller can resume (re-run, or re-pick the file). */
export class UploadInterruptedError extends Error {
  constructor(public uploadId: string, public key: string, message: string) {
    super(message);
    this.name = "UploadInterruptedError";
  }
}

interface InitResponse {
  upload_id: string;
  key: string;
  part_size: number;
  part_count: number;
  media_url: string;
}
interface StatusResponse {
  status: string;
  part_size: number;
  part_count: number;
  parts: { partNumber: number; etag: string }[];
}
interface CompleteResponse {
  moment: MomentData;
  points_awarded: number;
}

export interface ResumableUploadOptions {
  slug: string;
  file: File;
  caption: string;
  uploaderName: string;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Resume handle: a persisted upload for this file (from findResumableUpload
   *  or a previous run). When provided we skip init and resume in place. */
  resume?: PersistedUpload;
}

/** In-memory File registry — keyed by the local upload id. Not persisted: a
 *  cold reload requires re-picking the file (then findResumableUpload rematches). */
const fileRegistry = new Map<string, File>();

async function jsonReq<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `request failed (${res.status})`);
  return body as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PUT one chunk to R2 via XHR (real upload progress) and resolve its ETag. */
function putPart(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onPartProgress: (loaded: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPartProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // ETag is the load-bearing return — bucket CORS MUST ExposeHeaders:["ETag"].
        const etag = xhr.getResponseHeader("ETag");
        if (etag) resolve(etag);
        else reject(new Error("R2 returned no ETag (check bucket CORS ExposeHeaders)"));
      } else {
        reject(new Error(`part PUT failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("part PUT network error"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.send(blob);
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
  });
}

export async function resumableUploadMoment(
  opts: ResumableUploadOptions
): Promise<{ moment: MomentData; points_awarded: number }> {
  const { slug, file, caption, uploaderName, onProgress, signal } = opts;
  const localId = opts.resume?.id ?? crypto.randomUUID();
  fileRegistry.set(localId, file);

  // Build or resume the persisted state.
  let state: PersistedUpload;
  if (opts.resume) {
    state = opts.resume;
  } else {
    const init = await jsonReq<InitResponse>(`/api/events/${slug}/moments/multipart/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploader_name: uploaderName,
        content_type: file.type,
        size: file.size,
        filename: file.name,
      }),
    });
    state = {
      id: localId,
      slug,
      uploadId: init.upload_id,
      key: init.key,
      partSize: init.part_size,
      partCount: init.part_count,
      fileSize: file.size,
      fileType: file.type,
      fileName: file.name,
      fileLastModified: file.lastModified,
      caption: caption || null,
      uploaderName,
      completedParts: {},
      status: "uploading",
      createdAt: Date.now(),
    };
    await saveUpload(state);
  }

  const partSize = state.partSize;
  const partCount = state.partCount;
  const completedParts: Record<number, string> = { ...state.completedParts };
  const inFlightBytes = new Map<number, number>();
  let stopped = false; // set on hard part failure or abort so sibling workers stop

  const partByteSize = (n: number) =>
    n < partCount ? partSize : state.fileSize - (partCount - 1) * partSize;

  const emitProgress = () => {
    if (!onProgress) return;
    let loaded = 0;
    for (const n of Object.keys(completedParts)) loaded += partByteSize(Number(n));
    for (const v of inFlightBytes.values()) loaded += v;
    onProgress(Math.min(loaded, state.fileSize), state.fileSize);
  };

  /** Reconcile against R2 ListParts — the authoritative resume view. Called on
   *  start and on every `visibilitychange → visible` so suspension can't leave
   *  our local map stale. */
  const reconcile = async () => {
    try {
      const s = await jsonReq<StatusResponse>(
        `/api/events/${slug}/moments/multipart/status?upload_id=${encodeURIComponent(
          state.uploadId
        )}&key=${encodeURIComponent(state.key)}`,
        { method: "GET" }
      );
      for (const p of s.parts) completedParts[p.partNumber] = p.etag;
      state.completedParts = { ...completedParts };
      await saveUpload(state);
      emitProgress();
    } catch {
      // Best-effort: if status is unreachable, fall back to our local map.
    }
  };

  // Re-acquire ground truth whenever the user returns to the tab.
  const onVisible = () => {
    if (document.visibilityState === "visible" && !stopped) void reconcile();
  };
  document.addEventListener("visibilitychange", onVisible);

  const uploadOnePart = async (partNumber: number): Promise<string> => {
    const start = (partNumber - 1) * partSize;
    const blob = file.slice(start, start + partByteSize(partNumber));
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_PART_RETRIES; attempt++) {
      if (signal?.aborted || stopped) throw new DOMException("aborted", "AbortError");
      try {
        const { url } = await jsonReq<{ url: string; part_number: number }>(
          `/api/events/${slug}/moments/multipart/part-url`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ upload_id: state.uploadId, key: state.key, part_number: partNumber }),
          }
        );
        return await putPart(
          url,
          blob,
          signal,
          (loaded) => {
            inFlightBytes.set(partNumber, Math.min(loaded, blob.size));
            emitProgress();
          }
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        lastErr = err;
        if (attempt < MAX_PART_RETRIES) await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
    throw lastErr;
  };

  try {
    await reconcile();

    // 3-way concurrent part pump. Workers pull part numbers off a shared cursor;
    // already-completed parts (from reconcile or a sibling) are skipped.
    let cursor = 1;
    const workers = Array.from({ length: Math.min(CONCURRENCY, partCount) }, async () => {
      while (cursor <= partCount) {
        if (signal?.aborted || stopped) return;
        const n = cursor++;
        if (n in completedParts) continue;
        try {
          const etag = await uploadOnePart(n);
          completedParts[n] = etag;
          state.completedParts = { ...completedParts };
          state.status = "uploading";
          await saveUpload(state);
          inFlightBytes.delete(n);
          emitProgress();
        } catch (err) {
          inFlightBytes.delete(n);
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          // Hard part failure: leave the R2 upload OPEN so it can be resumed.
          stopped = true;
          state.status = "paused";
          await saveUpload(state);
          throw new UploadInterruptedError(
            state.uploadId,
            state.key,
            err instanceof Error ? err.message : "part upload failed"
          );
        }
      }
    });
    await Promise.all(workers);

    // All parts confirmed — finalize. ETags exactly as R2 returned them (quoted).
    const result = await jsonReq<CompleteResponse>(
      `/api/events/${slug}/moments/multipart/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_id: state.uploadId,
          key: state.key,
          caption: caption || null,
          uploader_name: uploaderName,
          parts: Object.entries(completedParts).map(([n, etag]) => ({
            partNumber: Number(n),
            etag,
          })),
        }),
      }
    );
    state.status = "completed";
    await deleteUpload(localId);
    return result;
  } catch (err) {
    // User abort: stop the loop; the R2 upload is left open for a possible
    // resume (or explicit abort via abortResumableUpload). Don't mark failed.
    if (err instanceof DOMException && err.name === "AbortError") {
      state.status = "paused";
      await saveUpload(state);
      throw err;
    }
    throw err;
  } finally {
    document.removeEventListener("visibilitychange", onVisible);
    fileRegistry.delete(localId);
  }
}

/** Explicitly cancel an in-progress upload: aborts the R2 multipart (frees
 *  part storage) and removes the persisted state. Safe to call after a paused
 *  error or an abort. */
export async function abortResumableUpload(slug: string, uploadId: string, key: string): Promise<void> {
  await jsonReq(`/api/events/${slug}/moments/multipart/abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId, key }),
  }).catch(() => {}); // best-effort — R2 may already have reaped it
  // Drop any persisted row for this upload.
  const all = await (await import("./uploadStore")).listUploads(slug);
  await Promise.all(
    all.filter((u) => u.uploadId === uploadId && u.key === key).map((u) => deleteUpload(u.id))
  );
}

export { getUpload, fileRegistry };