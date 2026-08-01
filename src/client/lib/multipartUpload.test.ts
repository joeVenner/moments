import { afterEach, describe, expect, it, vi } from "vitest";
import { putPart } from "./multipartUpload";

class SuccessfulXHR {
  static latest: SuccessfulXHR | undefined;
  upload: { onprogress?: (event: { loaded: number }) => void } = {};
  status = 200;
  onerror?: () => void;
  onabort?: () => void;
  onload?: () => void;

  constructor() {
    SuccessfulXHR.latest = this;
  }

  open() {}

  send(blob: Blob) {
    this.upload.onprogress?.({ loaded: Math.floor(blob.size / 2) });
    this.onload?.();
  }

  abort() {
    this.onabort?.();
  }

  getResponseHeader(name: string) {
    return name.toLowerCase() === "etag" ? '"part-etag"' : null;
  }
}

describe("putPart", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports foreground byte progress before resolving the R2 ETag", async () => {
    vi.stubGlobal("XMLHttpRequest", SuccessfulXHR);
    const progress: number[] = [];
    const blob = new Blob([new Uint8Array(100)]);

    await expect(putPart("https://r2.test/part", blob, undefined, (loaded) => progress.push(loaded)))
      .resolves.toBe('"part-etag"');

    expect(progress).toEqual([50, 100]);
  });

  it("uses fetch in a service-worker environment without XMLHttpRequest", async () => {
    vi.stubGlobal("XMLHttpRequest", undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { ETag: '"fetch-etag"' } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];

    await expect(
      putPart("https://r2.test/part", new Blob([new Uint8Array(20)]), undefined, (loaded) =>
        progress.push(loaded)
      )
    ).resolves.toBe('"fetch-etag"');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(progress).toEqual([20]);
  });
});
