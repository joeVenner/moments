import { AwsClient } from "aws4fetch";
import type { Env } from "./types";

/**
 * Resumable large-upload path (P3.1 evolution). The existing `presign.ts` does a
 * single monolithic PUT of the whole file — which dies and restarts from byte
 * zero the moment iOS suspends the background tab. This module upgrades the same
 * "Worker stays out of the data path" architecture (Fork B) to S3 multipart:
 *
 *   1. Worker calls S3 CreateMultipartUpload  → returns uploadId
 *   2. Worker mints a short-TTL presigned UploadPart PUT URL per part
 *   3. Browser Blob.slice()s the file and PUTs each chunk STRAIGHT to R2
 *      (Worker never sees the bytes), reading the ETag from the response
 *   4. Worker calls CompleteMultipartUpload with the ordered {part,etag} list
 *
 * Resume source of truth is R2 ListParts (survives reload + cross-device); the
 * client mirrors progress in IndexedDB for zero-round-trip same-session resume.
 * The D1 `uploads` row (index.ts) is accounting/cleanup only.
 *
 * All S3 multipart ops go to the same R2 S3 endpoint used by `presign.ts`; the
 * browser's direct part PUTs need the bucket CORS to `ExposeHeaders: ["ETag"]`
 * (see scripts/r2-cors.json) — without that the client can't read each part's
 * ETag and can't complete the upload.
 */

/** R2 requires every part except the last to be ≥ 5 MiB. */
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;

/**
 * Fixed 8 MiB chunk: clears the 5 MiB floor with headroom, stays well under the
 * ~100 MB Workers request-body limit, and bounds the loss on an interrupted
 * transfer to one ~8 MiB part. 512 MB ÷ 8 MiB = 64 parts (R2 allows 10,000).
 * `Blob.slice()` is O(1), so chunking adds no memory cost regardless of file size.
 */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/** How many parts a file splits into (last part may be smaller). */
export function partCountForSize(size: number): number {
  return Math.max(1, Math.ceil(size / MULTIPART_PART_BYTES));
}

/** Presigned UploadPart URL lifetime — long enough for one chunk on slow mobile. */
export const PART_PRESIGN_EXPIRY_SECONDS = 600; // 10 minutes (matches single-PUT path)

const DEFAULT_BUCKET = "moments-media";

/** Re-uses isR2Configured from presign.ts — same three S3 credentials gate both paths. */
export { isR2Configured } from "./presign";

function s3Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    service: "s3",
    region: "auto",
  });
}

/** Base URL for an object on the R2 S3 endpoint, with optional query params. */
function objectUrl(env: Env, key: string, query: Record<string, string | undefined> = {}): string {
  const endpoint = (env.R2_S3_ENDPOINT as string).replace(/\/+$/, "");
  const bucket = env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
  const search = qs.toString();
  return `${endpoint}/${bucket}/${encodeURI(key)}${search ? `?${search}` : ""}`;
}

/**
 * Step 1: initiate a multipart upload. Server-side S3 call (header-signed, not
 * presigned) — the browser never sees credentials. Returns the R2 `uploadId`,
 * which is the only handle needed to resume later (resumeMultipartUpload-style
 * via ListParts; Workers are stateless so we persist it in D1 + IndexedDB).
 */
export async function createMultipartUpload(
  env: Env,
  key: string,
  contentType: string
): Promise<string> {
  const client = s3Client(env);
  // S3 CreateMultipartUpload = POST /key?uploads (empty body). Content-Type is
  // set as object metadata so R2 records the real type (mirrors the single-PUT
  // path's unsigned Content-Type trick, but here we can sign it server-side).
  const res = await client.fetch(objectUrl(env, key, { uploads: "" }), {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    aws: {},
  });
  if (!res.ok) {
    throw new Error(`createMultipartUpload failed (${res.status}): ${await res.text()}`);
  }
  const xml = await res.text();
  const uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error("createMultipartUpload: no UploadId in response");
  return uploadId;
}

/**
 * Step 2: presign a single UploadPart PUT URL. The browser PUTs the chunk
 * straight to R2 and reads the ETag from the response header. Query-signed
 * (signQuery) exactly like `presignPutUrl`, with partNumber + uploadId folded
 * into the canonical query string so the signature binds them.
 */
export async function presignPartUrl(
  env: Env,
  key: string,
  uploadId: string,
  partNumber: number
): Promise<string> {
  const client = s3Client(env);
  const target = objectUrl(env, key, {
    partNumber: String(partNumber),
    uploadId,
    "X-Amz-Expires": String(PART_PRESIGN_EXPIRY_SECONDS),
  });
  const signed = await client.sign(target, { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

/** A completed part as R2 reports it / as CompleteMultipartUpload expects it. */
export interface R2Part {
  partNumber: number;
  etag: string;
}

/**
 * Step 3: finalize the upload. Server-side POST with an XML body listing the
 * parts in ascending order. The ETags must be passed exactly as R2 returned
 * them (quoted) — the client captures them from each part PUT response header.
 * Returns the final object's ETag. On failure R2 leaves the upload open; the
 * caller should abort to free storage.
 */
export async function completeMultipartUpload(
  env: Env,
  key: string,
  uploadId: string,
  parts: R2Part[]
): Promise<string> {
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const body =
    `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    ordered.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
    `</CompleteMultipartUpload>`;
  const client = s3Client(env);
  const res = await client.fetch(objectUrl(env, key, { uploadId }), {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body,
    aws: {},
  });
  if (!res.ok) {
    throw new Error(`completeMultipartUpload failed (${res.status}): ${await res.text()}`);
  }
  // R2 returns the final composite ETag (etag-N form); not strictly needed but
  // return it for parity with the single-PUT path.
  const xml = await res.text();
  return xml.match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? "";
}

/**
 * Cancel an in-progress upload, freeing the storage held by uploaded parts.
 * Always call on give-up / validation failure — orphaned multipart uploads
 * accrue R2 storage until a lifecycle policy reaps them.
 */
export async function abortMultipartUpload(
  env: Env,
  key: string,
  uploadId: string
): Promise<void> {
  const client = s3Client(env);
  const res = await client.fetch(objectUrl(env, key, { uploadId }), {
    method: "DELETE",
    aws: {},
  });
  if (!res.ok && res.status !== 404) {
    // 404 = already gone (completed or auto-expired); treat as success.
    throw new Error(`abortMultipartUpload failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * List already-uploaded parts for a multipart upload — the resume source of
 * truth. Used on reload/revisit to skip parts the client doesn't need to re-PUT.
 * R2 returns up to 1000 parts per call; we follow NextPartNumberMarker if
 * truncated (64-part uploads never paginate, but stay correct at scale).
 */
export async function listParts(
  env: Env,
  key: string,
  uploadId: string
): Promise<R2Part[]> {
  const client = s3Client(env);
  const parts: R2Part[] = [];
  let marker: string | undefined;
  for (let page = 0; page < 100; page++) {
    // Safety bound — 100 × 1000 = 100k parts, well past R2's 10k cap.
    const res = await client.fetch(objectUrl(env, key, { uploadId, "part-number-marker": marker }), {
      method: "GET",
      aws: {},
    });
    if (!res.ok) {
      throw new Error(`listParts failed (${res.status}): ${await res.text()}`);
    }
    const xml = await res.text();
    // Each <Part><PartNumber>N</PartNumber><ETag>"..."</ETag>...</Part>
    const partRe = /<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]*)<\/ETag>/g;
    let m: RegExpExecArray | null;
    while ((m = partRe.exec(xml)) !== null) {
      parts.push({ partNumber: parseInt(m[1], 10), etag: m[2] });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!truncated) break;
    marker = xml.match(/<NextPartNumberMarker>([^<]+)<\/NextPartNumberMarker>/)?.[1];
    if (!marker) break;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}