/**
 * IndexedDB-backed persistence for in-flight resumable multipart uploads.
 *
 * R2's ListParts is the *resume source of truth* (survives reload + cross-device),
 * so this store is a local cache of progress — it lets a same-session reload
 * resume with zero server round-trips, and lets a cold reload re-match a file
 * the user re-picks to its in-progress upload (skip already-PUT parts).
 *
 * We deliberately do NOT persist the File blob here: a 500 MB IDB write on init
 * is slow and quota-fragile. The File lives in an in-memory Map for the session
 * (multipartUpload.ts); on a cold reload the user re-selects the file and we
 * match it back to its upload by {name, size, lastModified}.
 */

const DB_NAME = "moments-uploads";
const STORE = "uploads";
const DB_VERSION = 1;

export type UploadStatus = "uploading" | "paused" | "completed" | "failed";

export interface PersistedUpload {
  /** Client-local id (uuid) — keys the in-memory File map too. */
  id: string;
  slug: string;
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
  /** partNumber → R2 ETag (quoted, passed verbatim to Complete). */
  completedParts: Record<number, string>;
  status: UploadStatus;
  createdAt: number;
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

export async function saveUpload(u: PersistedUpload): Promise<void> {
  await tx((store) => store.put(u));
}

export async function getUpload(id: string): Promise<PersistedUpload | undefined> {
  return tx((store) => store.get(id) as IDBRequest<PersistedUpload | undefined>);
}

export async function deleteUpload(id: string): Promise<void> {
  await tx((store) => store.delete(id));
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
      (u.status === "uploading" || u.status === "paused")
  );
}