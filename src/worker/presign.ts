import { AwsClient } from "aws4fetch";
import type { Env } from "./types";

/**
 * Ceiling for large direct-to-R2 uploads (presigned PUT). Deliberately separate
 * from storage.ts's MAX_UPLOAD_BYTES (the small native-binding path): these files
 * never pass through the Worker — the browser PUTs them straight to R2 — which is
 * the only way to clear Cloudflare's ~200MB request-body limit. See .agent P3.1.
 */
export const MAX_DIRECT_UPLOAD_BYTES = 512 * 1024 * 1024; // 512MB

/** Presigned PUT URL lifetime — long enough to finish a 512MB clip on slow mobile. */
export const PRESIGN_EXPIRY_SECONDS = 600; // 10 minutes

const DEFAULT_BUCKET = "moments-media";

/** Whether the R2 S3 credentials needed for presigning are all configured. */
export function isR2Configured(env: Env): boolean {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_S3_ENDPOINT);
}

/**
 * Builds a short-lived presigned S3 PUT URL so the browser can upload a large
 * file straight to R2 — the Worker only signs, it never touches the bytes.
 * Content-type/size are NOT signed in; they are re-validated server-side via an
 * R2 head() check at registration (see .agent P3.1 step 4). Callers must have
 * checked isR2Configured() first.
 */
export async function presignPutUrl(env: Env, key: string): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    service: "s3",
    region: "auto",
  });
  const endpoint = (env.R2_S3_ENDPOINT as string).replace(/\/+$/, "");
  const bucket = env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const target = `${endpoint}/${bucket}/${encodeURI(key)}?X-Amz-Expires=${PRESIGN_EXPIRY_SECONDS}`;
  const signed = await client.sign(target, { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}
