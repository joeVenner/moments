import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMultipartUpload,
  presignPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  listParts,
  partCountForSize,
  MULTIPART_PART_BYTES,
  MULTIPART_MIN_PART_BYTES,
  PART_PRESIGN_EXPIRY_SECONDS,
} from "./multipartPresign";
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

const KEY = "events/e1/moments/uuid-clip.mp4";

/**
 * Captures the signed Request aws4fetch issues (it signs, then calls
 * `fetch(signedRequest, init)`) and returns a canned Response. aws4fetch folds
 * method/body/headers into the Request, so we read everything off of it.
 */
function stubFetch(responder: (req: Request, init?: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return responder(req, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("part sizing", () => {
  it("uses an 8 MiB chunk that clears the 5 MiB R2 floor", () => {
    expect(MULTIPART_PART_BYTES).toBe(8 * 1024 * 1024);
    expect(MULTIPART_MIN_PART_BYTES).toBe(5 * 1024 * 1024);
  });

  it("counts parts by ceiling division, last part may be smaller", () => {
    expect(partCountForSize(8 * 1024 * 1024)).toBe(1);
    expect(partCountForSize(8 * 1024 * 1024 + 1)).toBe(2);
    expect(partCountForSize(512 * 1024 * 1024)).toBe(64); // 512 MB ÷ 8 MiB
  });
});

describe("presignPartUrl", () => {
  it("signs a query-auth PUT URL bound to partNumber + uploadId", async () => {
    const url = new URL(await presignPartUrl(envWithR2(), KEY, "upl-123", 7));
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/moments-media/${KEY}`);
    // The signature binds the part identity — these MUST be in the signed query.
    expect(url.searchParams.get("partNumber")).toBe("7");
    expect(url.searchParams.get("uploadId")).toBe("upl-123");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PART_PRESIGN_EXPIRY_SECONDS));
  });
});

describe("createMultipartUpload", () => {
  it("POSTs ?uploads and extracts the UploadId from R2's XML", async () => {
    const fn = stubFetch(() =>
      new Response(
        `<InitiateMultipartUploadResult><Bucket>moments-media</Bucket><Key>${KEY}</Key><UploadId>upl-xyz</UploadId></InitiateMultipartUploadResult>`,
        { status: 200, headers: { "Content-Type": "application/xml" } }
      )
    );
    const uploadId = await createMultipartUpload(envWithR2(), KEY, "video/mp4");
    expect(uploadId).toBe("upl-xyz");
    const calledUrl = new URL((fn.mock.calls[0][0] as Request).url);
    expect(calledUrl.searchParams.get("uploads")).toBe("");
    expect((fn.mock.calls[0][0] as Request).method).toBe("POST");
  });

  it("throws a clear error when R2 returns non-OK", async () => {
    stubFetch(() => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }));
    await expect(createMultipartUpload(envWithR2(), KEY, "video/mp4")).rejects.toThrow(
      /createMultipartUpload failed \(404\)/
    );
  });
});

describe("completeMultipartUpload", () => {
  it("sends parts in ascending order in the XML body", async () => {
    const fn = stubFetch(
      () =>
        new Response(
          `<CompleteMultipartUploadResult><ETag>"composite-1"</ETag></CompleteMultipartUploadResult>`,
          { status: 200 }
        )
    );
    const etag = await completeMultipartUpload(envWithR2(), KEY, "upl-1", [
      { partNumber: 3, etag: '"c"' },
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ]);
    expect(etag).toBe('"composite-1"');
    const req = fn.mock.calls[0][0] as Request;
    expect(req.method).toBe("POST");
    const body = await req.text();
    // Must be sorted 1,2,3 regardless of input order — R2 rejects out-of-order.
    expect(body.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(body.indexOf("<PartNumber>2</PartNumber>"));
    expect(body.indexOf("<PartNumber>2</PartNumber>")).toBeLessThan(body.indexOf("<PartNumber>3</PartNumber>"));
  });
});

describe("listParts", () => {
  it("parses parts and follows pagination via NextPartNumberMarker", async () => {
    const fn = stubFetch((_req) => {
      const calls = fn.mock.calls.length;
      if (calls === 1) {
        return new Response(
          `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>` +
            `<Part><PartNumber>1</PartNumber><ETag>"a"</ETag><Size>8388608</Size></Part>` +
            `<Part><PartNumber>2</PartNumber><ETag>"b"</ETag><Size>8388608</Size></Part></ListPartsResult>`,
          { status: 200 }
        );
      }
      return new Response(
        `<ListPartsResult><IsTruncated>false</IsTruncated>` +
          `<Part><PartNumber>3</PartNumber><ETag>"c"</ETag><Size>1234</Size></Part></ListPartsResult>`,
        { status: 200 }
      );
    });
    const parts = await listParts(envWithR2(), KEY, "upl-1");
    expect(parts).toEqual([
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
      { partNumber: 3, etag: '"c"' },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
    // Second call must continue from the marker R2 gave us.
    const secondUrl = new URL((fn.mock.calls[1][0] as Request).url);
    expect(secondUrl.searchParams.get("part-number-marker")).toBe("2");
  });

  it("returns an empty list for an upload with no parts yet", async () => {
    stubFetch(() => new Response(`<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>`, { status: 200 }));
    expect(await listParts(envWithR2(), KEY, "upl-empty")).toEqual([]);
  });
});

describe("abortMultipartUpload", () => {
  it("DELETEs ?uploadId and tolerates a 404 (already gone)", async () => {
    const fn = stubFetch(() => new Response(null, { status: 204 }));
    await abortMultipartUpload(envWithR2(), KEY, "upl-1");
    const req = fn.mock.calls[0][0] as Request;
    expect(req.method).toBe("DELETE");
    expect(new URL(req.url).searchParams.get("uploadId")).toBe("upl-1");
  });

  it("treats 404 as success (completed or auto-expired)", async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    await expect(abortMultipartUpload(envWithR2(), KEY, "upl-1")).resolves.toBeUndefined();
  });
});