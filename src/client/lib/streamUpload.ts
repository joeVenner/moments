import { GuestRequiredError, announceGuestRequired, isGuestRequired, slugOfEventUrl } from "./guestRequired";
import { Upload, type DetailedError } from "tus-js-client";
import type { MomentData } from "./types";
import { getGuestToken, guestTokenHeaders, uploadTokenHeaders } from "./nickname";
import {
  deleteUpload,
  deleteUploadFile,
  getUploadFile,
  createUpload,
  saveUpload,
  saveUploadFile,
  type PersistedUpload,
} from "./uploadStore";

const TUS_CHUNK_BYTES = 50 * 1024 * 1024;
const activeStreamUploads = new Map<string, { upload: Upload; reject: (reason: unknown) => void }>();
const runningStreamUploads = new Set<string>();
const cancelledStreamUploads = new Set<string>();

interface StreamUploadOptions {
  slug: string;
  file: File;
  caption: string;
  uploaderName: string;
  resume?: PersistedUpload;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

interface CompleteResponse {
  moment: MomentData;
  points_awarded: number;
}

export class StreamUploadInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamUploadInterruptedError";
  }
}

export class StreamUploadAlreadyRunningError extends Error {
  constructor() {
    super("upload is already running in another page");
    this.name = "StreamUploadAlreadyRunningError";
  }
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (isGuestRequired(response.status, body)) throw announceGuestRequired(slugOfEventUrl(url), init.headers);
  if (!response.ok) throw new Error((body as { error?: string }).error || `request failed (${response.status})`);
  return body as T;
}

async function runStreamUpload(opts: StreamUploadOptions, localId: string): Promise<CompleteResponse> {
  let state: PersistedUpload = opts.resume ?? {
    id: localId,
    slug: opts.slug,
    backend: "stream",
    uploadId: "",
    key: "",
    partSize: TUS_CHUNK_BYTES,
    partCount: Math.ceil(opts.file.size / TUS_CHUNK_BYTES),
    fileSize: opts.file.size,
    fileType: opts.file.type,
    fileName: opts.file.name,
    fileLastModified: opts.file.lastModified,
    caption: opts.caption || null,
    uploaderName: opts.uploaderName,
    guestToken: getGuestToken(opts.slug),
    completedParts: {},
    status: "queued",
    createdAt: Date.now(),
    loadedBytes: 0,
    lastError: null,
  };
  state.backend = "stream";
  // Rows saved before tokens were kept: fill it in (never overwrite the owner's).
  state.guestToken ??= getGuestToken(opts.slug);
  if (opts.resume) await saveUpload(state);
  else await createUpload(state);
  if (cancelledStreamUploads.has(localId)) {
    await deleteUpload(localId);
    throw new DOMException("cancelled", "AbortError");
  }
  if (!(await getUploadFile(state))) await saveUploadFile(localId, opts.file);
  if (!state.streamSessionId) {
    try {
      const session = await jsonRequest<{ session_id: string }>(
        `/api/events/${encodeURIComponent(opts.slug)}/moments/stream/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...guestTokenHeaders(opts.slug) },
          body: JSON.stringify({
            uploader_name: opts.uploaderName,
            content_type: opts.file.type,
            size: opts.file.size,
          }),
        }
      );
      if (cancelledStreamUploads.has(localId)) {
        await deleteUpload(localId);
        throw new DOMException("cancelled", "AbortError");
      }
      state.streamSessionId = session.session_id;
      await saveUpload(state);
    } catch (error) {
      if (cancelledStreamUploads.has(localId)) {
        await deleteUpload(localId);
        throw error;
      }
      if (error instanceof GuestRequiredError) {
        state.status = "failed";
        state.lastError = error.message;
        await saveUpload(state);
        throw error;
      }
      state.status = "paused";
      state.lastError = error instanceof Error ? error.message : "Unable to start Stream upload";
      await saveUpload(state);
      throw new StreamUploadInterruptedError(state.lastError);
    }
  }

  return new Promise<CompleteResponse>((resolve, reject) => {
    let lastProgressSave = 0;
    // No guest token here on purpose: tus-js-client sends `headers` to the
    // Stream upload URL too, and the session id already ties tus to the guest.
    const upload = new Upload(opts.file, {
      endpoint: `/api/events/${encodeURIComponent(opts.slug)}/moments/stream/tus?session=${encodeURIComponent(state.streamSessionId!)}`,
      uploadUrl: state.streamUploadUrl ?? null,
      chunkSize: TUS_CHUNK_BYTES,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000, 20_000],
      removeFingerprintOnSuccess: true,
      metadata: {
        name: opts.file.name,
        filetype: opts.file.type,
        maxDurationSeconds: "3600",
      },
      onAfterResponse: async (_request, response) => {
        if (cancelledStreamUploads.has(localId)) return;
        const streamUid = response.getHeader("stream-media-id");
        if (streamUid) {
          state.streamUid = streamUid;
          state.uploadId = streamUid;
          state.key = `stream/${streamUid}`;
        }
        if (upload.url) state.streamUploadUrl = upload.url;
        await saveUpload(state);
      },
      onProgress: (uploaded, total) => {
        if (cancelledStreamUploads.has(localId)) return;
        state.status = "uploading";
        state.loadedBytes = uploaded;
        state.lastError = null;
        opts.onProgress?.(uploaded, total);
        const now = Date.now();
        if (now - lastProgressSave >= 500 || uploaded === total) {
          lastProgressSave = now;
          void saveUpload({ ...state });
        }
      },
      onError: (error: Error | DetailedError) => {
        activeStreamUploads.delete(localId);
        if (cancelledStreamUploads.has(localId)) {
          void deleteUpload(localId).finally(() => reject(new DOMException("cancelled", "AbortError")));
          return;
        }
        state.status = "paused";
        state.lastError = error.message;
        void saveUpload(state).finally(() => reject(new StreamUploadInterruptedError(error.message)));
      },
      onSuccess: () => {
        void (async () => {
          activeStreamUploads.delete(localId);
          if (cancelledStreamUploads.has(localId)) {
            await deleteUpload(localId);
            throw new DOMException("cancelled", "AbortError");
          }
          const streamUid = state.streamUid;
          if (!streamUid) throw new Error("Stream returned no media ID");
          const result = await jsonRequest<CompleteResponse>(
            `/api/events/${encodeURIComponent(opts.slug)}/moments/stream/complete`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...uploadTokenHeaders(state) },
              body: JSON.stringify({
                stream_uid: streamUid,
                uploader_name: opts.uploaderName,
                caption: opts.caption || null,
              }),
            }
          );
          if (cancelledStreamUploads.has(localId)) {
            await deleteUpload(localId);
            throw new DOMException("cancelled", "AbortError");
          }
          state.status = "completed";
          state.loadedBytes = state.fileSize;
          state.lastError = null;
          await saveUpload(state);
          await deleteUploadFile(localId);
          resolve(result);
        })().catch(async (error: unknown) => {
          if (cancelledStreamUploads.has(localId)) {
            await deleteUpload(localId);
            reject(error);
            return;
          }
          state.status = error instanceof GuestRequiredError ? "failed" : "paused";
          state.lastError = error instanceof Error ? error.message : "Stream completion failed";
          await saveUpload(state);
          reject(error);
        });
      },
    });

    activeStreamUploads.set(localId, { upload, reject });
    state.status = opts.resume ? "retrying" : "queued";
    void saveUpload(state)
      .then(() => upload.findPreviousUploads())
      .then((previous) => {
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
        state.status = "uploading";
        void saveUpload(state);
        upload.start();
      })
      .catch((error: unknown) => {
        activeStreamUploads.delete(localId);
        if (cancelledStreamUploads.has(localId)) void deleteUpload(localId);
        reject(error);
      });
  });
}

export async function streamUploadMoment(opts: StreamUploadOptions): Promise<CompleteResponse> {
  const localId = opts.resume?.id ?? crypto.randomUUID();
  const execute = async () => {
    if (runningStreamUploads.has(localId)) throw new StreamUploadAlreadyRunningError();
    runningStreamUploads.add(localId);
    try {
      return await runStreamUpload(opts, localId);
    } finally {
      runningStreamUploads.delete(localId);
      activeStreamUploads.delete(localId);
      cancelledStreamUploads.delete(localId);
    }
  };

  if ("locks" in navigator) {
    return navigator.locks.request(
      `moment-upload-${localId}`,
      { mode: "exclusive", ifAvailable: true },
      async (fileLock) => {
        if (!fileLock) throw new StreamUploadAlreadyRunningError();
        return execute();
      }
    );
  }
  return execute();
}

export async function cancelStreamUpload(upload: PersistedUpload): Promise<void> {
  cancelledStreamUploads.add(upload.id);
  const active = activeStreamUploads.get(upload.id);
  if (active) {
    await active.upload.abort(true).catch(() => {});
    active.reject(new DOMException("cancelled", "AbortError"));
  }
  activeStreamUploads.delete(upload.id);
  if (upload.streamUid || upload.streamSessionId) {
    await jsonRequest(`/api/events/${encodeURIComponent(upload.slug)}/moments/stream/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...uploadTokenHeaders(upload) },
      body: JSON.stringify({
        stream_uid: upload.streamUid,
        session_id: upload.streamSessionId,
      }),
    }).catch(() => {});
  }
  await deleteUpload(upload.id);
  if (!runningStreamUploads.has(upload.id)) cancelledStreamUploads.delete(upload.id);
}
