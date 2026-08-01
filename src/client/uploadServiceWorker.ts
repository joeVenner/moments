import { resumableUploadMoment, UploadAlreadyRunningError } from "./lib/multipartUpload";
import { ACTIVE_UPLOAD_STATUSES, getUploadFile, listUploads } from "./lib/uploadStore";
import { UPLOAD_SYNC_TAG } from "./lib/uploadSync";

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SyncEventLike extends ExtendableEventLike {
  tag: string;
}

interface ClientLike {
  postMessage(message: unknown): void;
}

interface ServiceWorkerScopeLike {
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<ClientLike[]>;
  };
  addEventListener(type: string, listener: (event: SyncEventLike) => void): void;
}

const serviceWorker = globalThis as unknown as ServiceWorkerScopeLike;

async function notifyClients(slug: string): Promise<void> {
  const clients = await serviceWorker.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "moment-upload-completed", slug });
}

async function resumeQueue(): Promise<void> {
  const uploads = (await listUploads())
    .filter((upload) => upload.backend !== "stream" && ACTIVE_UPLOAD_STATUSES.has(upload.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  let retryNeeded = false;

  for (const upload of uploads) {
    const file = await getUploadFile(upload);
    if (!file) continue; // Legacy row: page can upgrade it after a re-selection.
    try {
      await resumableUploadMoment({
        slug: upload.slug,
        file,
        caption: upload.caption ?? "",
        uploaderName: upload.uploaderName,
        resume: upload,
      });
      await notifyClients(upload.slug);
    } catch (error) {
      if (!(error instanceof UploadAlreadyRunningError)) retryNeeded = true;
    }
  }

  // Rejecting asks Background Sync to retry later after transient failures.
  if (retryNeeded) throw new Error("pending uploads remain");
}

serviceWorker.addEventListener("install", (event) => {
  event.waitUntil(serviceWorker.skipWaiting());
});

serviceWorker.addEventListener("activate", (event) => {
  event.waitUntil(serviceWorker.clients.claim());
});

serviceWorker.addEventListener("sync", (event) => {
  if (event.tag === UPLOAD_SYNC_TAG) event.waitUntil(resumeQueue());
});
