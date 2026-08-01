import { describe, expect, it } from "vitest";
import type { Env } from "./types";
import { isStreamConfigured, streamApiUrl, streamAuthHeaders, streamMediaUrl } from "./stream";

const configured = {
  STREAM_ACCOUNT_ID: "account-id",
  STREAM_API_TOKEN: "secret-token",
  STREAM_CUSTOMER_CODE: "customer-code",
} as Env;

describe("Stream configuration", () => {
  it("requires account, token, and customer code", () => {
    expect(isStreamConfigured(configured)).toBe(true);
    expect(isStreamConfigured({ ...configured, STREAM_API_TOKEN: undefined })).toBe(false);
    expect(isStreamConfigured({ ...configured, STREAM_CUSTOMER_CODE: "" })).toBe(false);
  });

  it("builds API, authorization, and player values", () => {
    expect(streamApiUrl(configured, "/video-id")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/stream/video-id"
    );
    expect(streamAuthHeaders(configured)).toEqual({ Authorization: "Bearer secret-token" });
    expect(streamMediaUrl(configured, "video-id")).toBe(
      "https://customer-customer-code.cloudflarestream.com/video-id/iframe"
    );
  });
});
