import { describe, expect, it } from "vitest";
import { isR2Configured, presignPutUrl, MAX_DIRECT_UPLOAD_BYTES } from "./presign";
import type { Env } from "./types";

function envWithR2(overrides: Partial<Env> = {}): Env {
  return {
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_S3_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
    R2_BUCKET_NAME: "moments-media",
    ...overrides,
  } as unknown as Env;
}

describe("isR2Configured", () => {
  it("is false when any S3 credential is missing", () => {
    expect(isR2Configured({} as Env)).toBe(false);
    expect(isR2Configured(envWithR2({ R2_SECRET_ACCESS_KEY: undefined }))).toBe(false);
    expect(isR2Configured(envWithR2({ R2_S3_ENDPOINT: undefined }))).toBe(false);
  });

  it("is true when key, secret and endpoint are all set", () => {
    expect(isR2Configured(envWithR2())).toBe(true);
  });
});

describe("presignPutUrl", () => {
  it("signs a query-auth PUT URL targeting the bucket + key on the R2 endpoint", async () => {
    const url = new URL(await presignPutUrl(envWithR2(), "events/e1/moments/abc-photo.jpg"));
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/moments-media/events/e1/moments/abc-photo.jpg");
    // SigV4 query-signed params so the browser can PUT with no auth header.
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("test-access-key");
  });

  it("falls back to the default bucket name when R2_BUCKET_NAME is unset", async () => {
    const url = new URL(await presignPutUrl(envWithR2({ R2_BUCKET_NAME: undefined }), "k"));
    expect(url.pathname).toBe("/moments-media/k");
  });

  it("tolerates a trailing slash on the endpoint", async () => {
    const url = new URL(
      await presignPutUrl(envWithR2({ R2_S3_ENDPOINT: "https://acct123.r2.cloudflarestorage.com/" }), "k")
    );
    expect(url.pathname).toBe("/moments-media/k");
  });
});

describe("MAX_DIRECT_UPLOAD_BYTES", () => {
  it("caps direct uploads at 512MB", () => {
    expect(MAX_DIRECT_UPLOAD_BYTES).toBe(512 * 1024 * 1024);
  });
});
