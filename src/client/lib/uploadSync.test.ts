import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUploadBackgroundSync, UPLOAD_SYNC_TAG } from "./uploadSync";

describe("requestUploadBackgroundSync", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns immediately when no service worker registration exists", async () => {
    const ready = new Promise<ServiceWorkerRegistration>(() => {});
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { serviceWorker: { ready, getRegistration } });

    await expect(requestUploadBackgroundSync()).resolves.toBeUndefined();
    expect(getRegistration).toHaveBeenCalledOnce();
  });

  it("registers the sync tag on a supplied registration", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { serviceWorker: {} });

    await requestUploadBackgroundSync({ sync: { register } } as unknown as ServiceWorkerRegistration);

    expect(register).toHaveBeenCalledWith(UPLOAD_SYNC_TAG);
  });
});
