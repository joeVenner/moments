/**
 * IndexedDB-backed persistence for in-flight resumable multipart uploads.
 *
 * R2's ListParts is the *resume source of truth* (survives reload + cross-device),
 * so this store is a local cache of progress — it lets a same-session reload
 * resume with zero server round-trips, and lets a cold reload re-match a file
 * the user re-picks to its in-progress upload (skip already-PUT parts).
 *
 * Upload metadata lives in IndexedDB. The file bytes live in the Origin Private
 * File System (OPFS), which is designed for large local files and is available
 * to both the page and its service worker. Keeping the bytes makes a cold-start
 * resume possible without asking the guest to re-select the file.
 */

const DB_NAME = "moments-uploads";
const STORE = "uploads";
const DB_VERSION = 1;
const FILE_DIR = "pending-upload-files";

export type UploadStatus = "queued" | "uploading" | "paused" | "retrying" | "completed" | "failed";

export const ACTIVE_UPLOAD_STATUSES: ReadonlySet<UploadStatus> = new Set([
  "queued",
  "uploading",
  "paused",
  "retrying",
]);

const UPLOAD_CHANGE_EVENT = "moment-upload-store-changed";
const UPLOAD_CHANNEL = "moment-upload-store";

export interface PersistedUpload {
  /** Client-local id (uuid) — also names the staged OPFS file. */
  id: string;
  slug: string;
  /** Missing on legacy rows, which are R2 multipart uploads. */
  backend?: "r2" | "stream";
  /** R2 multipart handle — the only thing needed to resume on the server. */
  uploadId: string;
  key: string;
  partSize: number;
  partCount: number;
  fileSize: number;
  fileType: string;
  fileName: string;
  fileLastModified: number;
  caption: string | null;
  uploaderName: string;
  /**
   * The guest's token when the upload started, so the upload service worker
   * (no localStorage) can still prove whose upload it is. Same origin and
   * lifetime as the localStorage copy; deleted with the row.
   */
  guestToken?: string | null;
  /** partNumber → R2 ETag (quoted, passed verbatim to Complete). */
  completedParts: Record<number, string>;
  status: UploadStatus;
  createdAt: number;
  updatedAt?: number;
  loadedBytes?: number;
  lastError?: string | null;
  streamUid?: string;
  streamUploadUrl?: string;
  streamSessionId?: string;
}

function notifyUploadChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UPLOAD_CHANGE_EVENT));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(UPLOAD_CHANNEL);
    channel.postMessage("changed");
    channel.close();
  }
}

export function subscribeToUploadChanges(listener: () => void): () => void {
  const onWindowChange = () => listener();
  if (typeof window !== "undefined") window.addEventListener(UPLOAD_CHANGE_EVENT, onWindowChange);
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(UPLOAD_CHANNEL) : null;
  if (channel) channel.onmessage = listener;
  return () => {
    if (typeof window !== "undefined") window.removeEventListener(UPLOAD_CHANGE_EVENT, onWindowChange);
    channel?.close();
  };
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("slug", "slug", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Records a new upload. */
export async function createUpload(u: PersistedUpload): Promise<void> {
  u.updatedAt = Date.now();
  await tx((store) => store.put(u));
  notifyUploadChanged();
}

/**
 * Updates an upload, unless it was deleted meanwhile (cancelled, or the guest
 * left): a run still holding its copy must not bring the row back, with its
 * file name, caption and a revoked token. Returns whether it was written.
 */
export async function saveUpload(u: PersistedUpload): Promise<boolean> {
  u.updatedAt = Date.now();
  const db = await openDB();
  let written = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      const existing = store.count(u.id);
      existing.onsuccess = () => {
        if (existing.result === 0) return;
        store.put(u);
        written = true;
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
  if (written) notifyUploadChanged();
  return written;
}

export async function getUpload(id: string): Promise<PersistedUpload | undefined> {
  return tx((store) => store.get(id) as IDBRequest<PersistedUpload | undefined>);
}

export async function deleteUpload(id: string): Promise<void> {
  await tx((store) => store.delete(id));
  await deleteUploadFile(id);
  notifyUploadChanged();
}

async function uploadDirectory(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) return undefined;
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(FILE_DIR, { create });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}

/** Stage the exact bytes until R2 confirms multipart completion. */
export async function saveUploadFile(id: string, file: File): Promise<void> {
  const dir = await uploadDirectory(true);
  if (!dir) throw new Error("durable browser storage is unavailable");
  const handle = await dir.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(file);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(id).catch(() => {});
    throw error;
  }
}

/** Rehydrate a staged upload with its original identity and MIME metadata. */
export async function getUploadFile(upload: PersistedUpload): Promise<File | undefined> {
  const dir = await uploadDirectory(false);
  if (!dir) return undefined;
  try {
    const handle = await dir.getFileHandle(upload.id);
    const stored = await handle.getFile();
    if (stored.size !== upload.fileSize) return undefined;
    return new File([stored], upload.fileName, {
      type: upload.fileType,
      lastModified: upload.fileLastModified,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function deleteUploadFile(id: string): Promise<void> {
  const dir = await uploadDirectory(false);
  if (!dir) return;
  await dir.removeEntry(id).catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  });
}

export async function listUploads(slug?: string): Promise<PersistedUpload[]> {
  const db = await openDB();
  try {
    return await new Promise<PersistedUpload[]>((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const store = t.objectStore(STORE);
      const req = slug ? store.index("slug").getAll(slug) : store.getAll();
      req.onsuccess = () => resolve((req.result as PersistedUpload[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Match a re-picked file to an in-progress upload for this event, so the user
 * can resume after a reload/crash instead of starting over. Match key is
 * {slug, name, size, lastModified} — the same identity a fresh pick preserves.
 * Only matches uploads still resumable (uploading/paused).
 */
export async function findResumableUpload(
  slug: string,
  file: { name: string; size: number; lastModified: number }
): Promise<PersistedUpload | undefined> {
  const all = await listUploads(slug);
  return all.find(
    (u) =>
      u.fileName === file.name &&
      u.fileSize === file.size &&
      u.fileLastModified === file.lastModified &&
      ACTIVE_UPLOAD_STATUSES.has(u.status)
  );
}
