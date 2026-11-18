import type { MomentData } from "./types";
import {
  saveUpload,
  getUpload,
  getUploadFile,
  saveUploadFile,
  deleteUploadFile,
  deleteUpload,
  listUploads,
  type PersistedUpload,
} from "./uploadStore";
import { requestPageUploadResume, requestUploadBackgroundSync } from "./uploadSync";
import { guestTokenHeaders } from "./nickname";

/**
 * Resumable chunked uploader for large videos (the >25 MB path).
 *
 * Splits the file into 8 MiB parts and PUTs each one straight to R2 through a
 * Worker-minted presigned URL — the Worker never sees the bytes. Three parts
 * run concurrently. Progress advances after R2 acknowledges each bounded part.
 *
 * Resilience to "the user put their phone down":
 *  - Chunking bounds any interruption to ONE part (~8 MB), not the whole file.
 *  - Per-part retries (3×, backoff) ride out transient cellular drops.
 *  - On `visibilitychange → visible` we reconcile against R2's ListParts — the
 *    server is the source of truth — so parts that finished (or didn't) during
 *    iOS background suspension are reflected exactly, and we never re-upload a
 *    part R2 already has.
 *  - Metadata is mirrored to IndexedDB and bytes to OPFS, so a reload, browser
 *    restart, or supported Background Sync can continue without re-selection.
 *
 * The screen wake lock (useUploadWakeLock) keeps the foregrounded tab from
 * dozing; no web API can keep an upload alive after iOS fully backgrounds the
 * app, but this makes that interruption cheap and recoverable.
 */

const CONCURRENCY = 3;
const MAX_PART_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const activeControllers = new Map<string, AbortController>();
const cancelledUploads = new Set<string>();

/** Thrown when a part can't be uploaded after all retries — the R2 multipart
 *  upload is left OPEN so the caller can resume (re-run, or re-pick the file). */
export class UploadInterruptedError extends Error {
  constructor(public uploadId: string, public key: string, message: string) {
    super(message);
    this.name = "UploadInterruptedError";
  }
}

export class UploadAlreadyRunningError extends Error {
  constructor() {
    super("upload is already running in another page or worker");
    this.name = "UploadAlreadyRunningError";
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
  assembly_complete?: boolean;
  part_size: number;
  part_count: number;
  parts: { partNumber: number; etag: string }[];
  moment?: MomentData;
  points_awarded?: number;
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

async function jsonReq<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `request failed (${res.status})`);
  return body as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function putPartWithProgress(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onPartProgress: (loaded: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (etag: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(etag);
    };
    const onAbort = () => xhr.abort();

    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => onPartProgress(Math.min(event.loaded, blob.size));
    xhr.onerror = () => fail(new Error("part PUT failed (network error)"));
    xhr.onabort = () => fail(new DOMException("aborted", "AbortError"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(new Error(`part PUT failed (${xhr.status})`));
        return;
      }
      const etag = xhr.getResponseHeader("ETag");
      if (!etag) {
        fail(new Error("R2 returned no ETag (check bucket CORS ExposeHeaders)"));
        return;
      }
      onPartProgress(blob.size);
      succeed(etag);
    };

    if (signal?.aborted) {
      fail(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(blob);
  });
}

/**
 * PUT one chunk to R2 and resolve its ETag. Pages use XHR because Fetch still
 * exposes no request-body progress events; service workers retain the Fetch
 * path because XMLHttpRequest is unavailable there.
 */
export async function putPart(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onPartProgress: (loaded: number) => void
): Promise<string> {
  if (typeof XMLHttpRequest !== "undefined") {
    return putPartWithProgress(url, blob, signal, onPartProgress);
  }
  const response = await fetch(url, { method: "PUT", body: blob, signal });
  if (!response.ok) throw new Error(`part PUT failed (${response.status})`);
  const etag = response.headers.get("ETag");
  if (!etag) throw new Error("R2 returned no ETag (check bucket CORS ExposeHeaders)");
  onPartProgress(blob.size);
  return etag;
}

async function runResumableUpload(
  opts: ResumableUploadOptions,
  localId: string
): Promise<{ moment: MomentData; points_awarded: number }> {
  const { slug, file, caption, uploaderName, onProgress, signal } = opts;

  // Build or resume the persisted state.
  let state: PersistedUpload;
  if (opts.resume) {
    state = opts.resume;
  } else {
    const init = await jsonReq<InitResponse>(`/api/events/${slug}/moments/multipart/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...guestTokenHeaders(slug) },
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
      backend: "r2",
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
      status: "queued",
      createdAt: Date.now(),
      loadedBytes: 0,
      lastError: null,
    };
    await saveUpload(state);
  }

  // OPFS is the durable source of file bytes for reload/background recovery.
  // Old queue rows from before this feature are upgraded when the user picks
  // the matching file once more.
  if (!(await getUploadFile(state))) await saveUploadFile(localId, file);
  state.status = "uploading";
  state.lastError = null;
  await saveUpload(state);
  void requestUploadBackgroundSync();

  const partSize = state.partSize;
  const partCount = state.partCount;
  const completedParts: Record<number, string> = { ...state.completedParts };
  const inFlightBytes = new Map<number, number>();
  let assemblyComplete = false;
  let lastProgressPersistedAt = 0;
  let stopped = false; // set on hard part failure or abort so sibling workers stop

  const partByteSize = (n: number) =>
    n < partCount ? partSize : state.fileSize - (partCount - 1) * partSize;

  const emitProgress = () => {
    let loaded = 0;
    for (const n of Object.keys(completedParts)) loaded += partByteSize(Number(n));
    for (const v of inFlightBytes.values()) loaded += v;
    state.loadedBytes = Math.min(loaded, state.fileSize);
    onProgress?.(state.loadedBytes, state.fileSize);
    const now = Date.now();
    if (now - lastProgressPersistedAt >= 500 || state.loadedBytes === state.fileSize) {
      lastProgressPersistedAt = now;
      void saveUpload({
        ...state,
        completedParts: { ...state.completedParts },
      });
    }
  };

  /** Reconcile against R2 ListParts — the authoritative resume view. */
  const reconcile = async (): Promise<CompleteResponse | undefined> => {
    try {
      const s = await jsonReq<StatusResponse>(
        `/api/events/${slug}/moments/multipart/status?upload_id=${encodeURIComponent(
          state.uploadId
        )}&key=${encodeURIComponent(state.key)}`,
        { method: "GET", headers: guestTokenHeaders(slug) }
      );
      if (s.status === "completed" && s.moment && typeof s.points_awarded === "number") {
        return { moment: s.moment, points_awarded: s.points_awarded };
      }
      assemblyComplete = s.assembly_complete === true;
      for (const p of s.parts) completedParts[p.partNumber] = p.etag;
      state.completedParts = { ...completedParts };
      await saveUpload(state);
      emitProgress();
      return undefined;
    } catch {
      // Best-effort: if status is unreachable, fall back to our local map.
      return undefined;
    }
  };

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
            headers: { "Content-Type": "application/json", ...guestTokenHeaders(slug) },
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
        inFlightBytes.delete(partNumber);
        emitProgress();
        lastErr = err;
        state.status = "retrying";
        state.lastError = err instanceof Error ? err.message : "part upload failed";
        await saveUpload(state);
        if (attempt < MAX_PART_RETRIES) {
          await sleep(RETRY_BACKOFF_MS[attempt]);
          state.status = "uploading";
          await saveUpload(state);
        }
      }
    }
    throw lastErr;
  };

  try {
    const alreadyCompleted = await reconcile();
    if (alreadyCompleted) {
      state.status = "completed";
      state.loadedBytes = state.fileSize;
      state.lastError = null;
      await saveUpload(state);
      await deleteUploadFile(localId);
      return alreadyCompleted;
    }

    // 3-way concurrent part pump. Workers pull part numbers off a shared cursor;
    // already-completed parts (from reconcile or a sibling) are skipped.
    let cursor = assemblyComplete ? partCount + 1 : 1;
    const workers = Array.from({ length: assemblyComplete ? 0 : Math.min(CONCURRENCY, partCount) }, async () => {
      while (cursor <= partCount) {
        if (signal?.aborted || stopped) return;
        const n = cursor++;
        if (n in completedParts) continue;
        try {
          const etag = await uploadOnePart(n);
          completedParts[n] = etag;
          state.completedParts = { ...completedParts };
          state.status = "uploading";
          inFlightBytes.delete(n);
          emitProgress();
          await saveUpload(state);
        } catch (err) {
          inFlightBytes.delete(n);
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          // Hard part failure: leave the R2 upload OPEN so it can be resumed.
          stopped = true;
          state.status = "paused";
          state.lastError = err instanceof Error ? err.message : "part upload failed";
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
        headers: { "Content-Type": "application/json", ...guestTokenHeaders(slug) },
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
    state.loadedBytes = state.fileSize;
    state.lastError = null;
    await saveUpload(state);
    await deleteUploadFile(localId);
    return result;
  } catch (err) {
    // User abort: stop the loop; the R2 upload is left open for a possible
    // resume (or explicit abort via abortResumableUpload). Don't mark failed.
    if (err instanceof DOMException && err.name === "AbortError") {
      if (cancelledUploads.has(localId)) {
        await deleteUpload(localId);
        throw err;
      }
      state.status = "paused";
      state.lastError = "upload cancelled or suspended";
      await saveUpload(state);
      throw err;
    }
    void requestUploadBackgroundSync();
    requestPageUploadResume();
    throw err;
  }
}

let fallbackQueue: Promise<void> = Promise.resolve();

/**
 * Serialize large files globally and reject duplicate work for the same upload.
 * Web Locks coordinates the page and service worker; the promise queue covers
 * older browsers within the current JavaScript realm.
 */
export async function resumableUploadMoment(
  opts: ResumableUploadOptions
): Promise<{ moment: MomentData; points_awarded: number }> {
  const localId = opts.resume?.id ?? crypto.randomUUID();
  const execute = async () => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
    activeControllers.set(localId, controller);
    try {
      return await runResumableUpload({ ...opts, signal: controller.signal }, localId);
    } finally {
      opts.signal?.removeEventListener("abort", abortFromCaller);
      if (activeControllers.get(localId) === controller) activeControllers.delete(localId);
      cancelledUploads.delete(localId);
    }
  };

  if ("locks" in navigator) {
    return navigator.locks.request(
      `moment-upload-${localId}`,
      { mode: "exclusive", ifAvailable: true },
      async (fileLock) => {
        if (!fileLock) throw new UploadAlreadyRunningError();
        return navigator.locks.request("moment-upload-global", { mode: "exclusive" }, execute);
      }
    );
  }

  const result = fallbackQueue.then(
    execute,
    execute
  );
  fallbackQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function retryResumableUpload(upload: PersistedUpload): Promise<void> {
  if (upload.status === "completed") return;
  upload.status = "retrying";
  upload.lastError = null;
  await saveUpload(upload);
  requestPageUploadResume();
  await requestUploadBackgroundSync();
}

export async function cancelResumableUpload(upload: PersistedUpload): Promise<void> {
  cancelledUploads.add(upload.id);
  const controller = activeControllers.get(upload.id);
  controller?.abort(new DOMException("cancelled", "AbortError"));
  try {
    await abortResumableUpload(upload.slug, upload.uploadId, upload.key);
  } finally {
    if (!controller) cancelledUploads.delete(upload.id);
  }
}

/** Explicitly cancel an in-progress upload: aborts the R2 multipart (frees
 *  part storage) and removes the persisted state. Safe to call after a paused
 *  error or an abort. */
export async function abortResumableUpload(slug: string, uploadId: string, key: string): Promise<void> {
  await jsonReq(`/api/events/${slug}/moments/multipart/abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...guestTokenHeaders(slug) },
    body: JSON.stringify({ upload_id: uploadId, key }),
  }).catch(() => {}); // best-effort — R2 may already have reaped it
  // Drop any persisted row for this upload.
  const all = await listUploads(slug);
  await Promise.all(
    all.filter((u) => u.uploadId === uploadId && u.key === key).map((u) => deleteUpload(u.id))
  );
}

export { getUpload };
