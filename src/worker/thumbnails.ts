/**
 * Grid thumbnails made by the app (about 400 px JPEG) and uploaded beside
 * the moment's file, at a key derived from the upload's own key, so no
 * schema change is needed and an event's purge (by key prefix) takes them.
 * A thumbnail never blocks its moment: a missing or bad one is dropped at
 * finalize and the feed falls back to the full file.
 */

/** Largest thumbnail accepted; a 400 px JPEG is far smaller. */
export const MAX_THUMBNAIL_BYTES = 200 * 1024;
export const THUMBNAIL_CONTENT_TYPE = "image/jpeg";
/** Thumbnail URLs live as long as part URLs; ask again after. */
export const THUMBNAIL_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Where the app PUTs a thumbnail (through a presigned URL that stays valid
 * for hours). Never served: `/media` refuses it, so bytes sent after the
 * check can't reach anyone.
 */
export function thumbnailUploadKey(uploadKey: string): string {
  return `${uploadKey}.thumb-upload.jpg`;
}

/**
 * Where an accepted thumbnail lives: a copy the server wrote after checking
 * it, at a key no URL was ever signed for. Next to the file, in the same
 * event prefix.
 */
export function thumbnailKey(uploadKey: string): string {
  return `${uploadKey}.thumb.jpg`;
}

/** Both keys a session's thumbnail may occupy, for cleanup. */
export function thumbnailKeys(uploadKey: string): string[] {
  return [thumbnailUploadKey(uploadKey), thumbnailKey(uploadKey)];
}

/** Keys `/media` must never serve: the guest can still write to them. */
export function isThumbnailUploadKey(key: string): boolean {
  return key.endsWith(".thumb-upload.jpg");
}

export function isValidThumbnailSize(size: number): boolean {
  return Number.isInteger(size) && size > 0 && size <= MAX_THUMBNAIL_BYTES;
}

/** The object store calls a thumbnail check needs. */
export interface ThumbnailStore {
  head(key: string): Promise<{ contentType: string; size: number } | null>;
  /** The whole object (thumbnails are small), or null if it doesn't exist. */
  readAll(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

/** A whole JPEG: starts with FF D8 FF, ends with FF D9. */
function isWholeJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}

/**
 * Checks the thumbnail the app uploaded and, if it is a whole JPEG of at
 * most `MAX_THUMBNAIL_BYTES`, copies it to its served key. The uploaded
 * copy is always deleted. Returns the served key, or null when there was
 * none or it was unusable.
 */
export async function acceptThumbnail(store: ThumbnailStore, uploadKey: string): Promise<string | null> {
  const uploaded = thumbnailUploadKey(uploadKey);
  const object = await store.head(uploaded);
  if (!object) return null;
  let accepted: string | null = null;
  if (object.contentType === THUMBNAIL_CONTENT_TYPE && isValidThumbnailSize(object.size)) {
    const bytes = await store.readAll(uploaded);
    // The size is checked again on what was read (it may have changed since the HEAD).
    if (bytes && isValidThumbnailSize(bytes.length) && isWholeJpeg(bytes)) {
      accepted = thumbnailKey(uploadKey);
      await store.put(accepted, bytes, THUMBNAIL_CONTENT_TYPE);
    }
  }
  await store.deleteObject(uploaded);
  return accepted;
}
