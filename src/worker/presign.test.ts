import { describe, expect, it } from "vitest";
import {
  isR2Configured,
  registrationKeyBelongsToEvent,
  MAX_DIRECT_UPLOAD_BYTES,
} from "./presign";
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

describe("registrationKeyBelongsToEvent", () => {
  it("accepts a key under the event's own moments prefix", () => {
    expect(registrationKeyBelongsToEvent("e1", "events/e1/moments/uuid-photo.jpg")).toBe(true);
  });

  it("rejects a key for a different event", () => {
    expect(registrationKeyBelongsToEvent("e1", "events/e2/moments/uuid-photo.jpg")).toBe(false);
  });

  it("rejects the bare prefix with no object name", () => {
    expect(registrationKeyBelongsToEvent("e1", "events/e1/moments/")).toBe(false);
  });

  it("rejects a different folder under the same event", () => {
    expect(registrationKeyBelongsToEvent("e1", "events/e1/cover/uuid.jpg")).toBe(false);
  });

  it("rejects path-traversal attempts", () => {
    expect(registrationKeyBelongsToEvent("e1", "events/e1/moments/../../e2/moments/x")).toBe(false);
  });
});

describe("MAX_DIRECT_UPLOAD_BYTES", () => {
  it("caps direct uploads at 512MB", () => {
    expect(MAX_DIRECT_UPLOAD_BYTES).toBe(512 * 1024 * 1024);
  });
});
