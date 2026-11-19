import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  createUpload: vi.fn(async () => undefined),
  saveUpload: vi.fn(async (_u: { status: string }) => true),
  getUpload: vi.fn(async () => undefined),
  getUploadFile: vi.fn(async () => new Blob([new Uint8Array(10)])),
  saveUploadFile: vi.fn(async () => undefined),
  deleteUploadFile: vi.fn(async () => undefined),
  deleteUpload: vi.fn(async () => undefined),
  listUploads: vi.fn(async () => []),
}));
const sync = vi.hoisted(() => ({
  requestUploadBackgroundSync: vi.fn(async () => undefined),
  requestPageUploadResume: vi.fn(),
}));
vi.mock("./uploadStore", () => store);
vi.mock("./uploadSync", () => sync);

import {
  GUEST_REQUIRED_EVENT,
  GuestRequiredError,
  announceGuestRequired,
  guestRequiredDetail,
  isGuestRequired,
  refusalAction,
  sentGuestToken,
  slugOfEventUrl,
} from "./guestRequired";
import { toggleMomentReaction } from "./api";
import { resumableUploadMoment } from "./multipartUpload";
import type { PersistedUpload } from "./uploadStore";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  for (const fn of [...Object.values(store), ...Object.values(sync)]) fn.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("guestRequired helpers", () => {
  it("recognises only the server's own refusal", () => {
    expect(isGuestRequired(403, { code: "guest_required" })).toBe(true);
    expect(isGuestRequired(403, { code: "uploads_closed" })).toBe(false);
    expect(isGuestRequired(403, null)).toBe(false);
    expect(isGuestRequired(404, { code: "guest_required" })).toBe(false);
  });

  it("reads the slug and the token a request carried", () => {
    expect(slugOfEventUrl("/api/events/f%C3%AAte/moments/multipart/part-url")).toBe("fête");
    expect(slugOfEventUrl("/api/events/party?x=1")).toBe("party");
    expect(sentGuestToken({ "X-Guest-Token": "gt_a", "Content-Type": "application/json" })).toBe("gt_a");
    expect(sentGuestToken({})).toBeNull();
    expect(sentGuestToken(undefined)).toBeNull();
  });

  it("forgets the guest only for the current token, keeping a newer one", () => {
    expect(refusalAction({ slug: "party", sentToken: "gt_old" }, "gt_old")).toBe("forget");
    expect(refusalAction({ slug: "party", sentToken: null }, null)).toBe("forget");
    // The guest already left from another tab: just show the gate.
    expect(refusalAction({ slug: "party", sentToken: "gt_old" }, null)).toBe("gate");
    // Another tab joined again meanwhile: keep the newer identity.
    expect(refusalAction({ slug: "party", sentToken: "gt_old" }, "gt_new")).toBe("ignore");
  });

  it("accepts only well-formed refusals relayed by the upload worker", () => {
    expect(guestRequiredDetail({ type: GUEST_REQUIRED_EVENT, slug: "party", sentToken: "gt_a" })).toEqual({ slug: "party", sentToken: "gt_a" });
    expect(guestRequiredDetail({ type: GUEST_REQUIRED_EVENT, slug: "party", sentToken: null })).toEqual({ slug: "party", sentToken: null });
    expect(guestRequiredDetail({ type: GUEST_REQUIRED_EVENT, slug: "party" })).toBeNull();
    expect(guestRequiredDetail({ type: "moment-upload-completed", slug: "party", sentToken: null })).toBeNull();
    expect(guestRequiredDetail(null)).toBeNull();
  });

  it("announces the refusal on the page", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const error = announceGuestRequired("party", { "X-Guest-Token": "gt_a" });
    expect(error).toBeInstanceOf(GuestRequiredError);
    expect(error.sentToken).toBe("gt_a");
    const [event] = dispatchEvent.mock.calls[0] as [CustomEvent];
    expect(event.type).toBe(GUEST_REQUIRED_EVENT);
    expect(event.detail).toEqual({ slug: "party", sentToken: "gt_a" });
  });

  it("builds the error without a page (the upload service worker)", () => {
    expect(announceGuestRequired("party", undefined).sentToken).toBeNull();
  });
});

describe("a resumed upload refused as guest_required", () => {
  const row = (): PersistedUpload => ({
    id: "local-1",
    slug: "party",
    backend: "r2",
    uploadId: "mp-1",
    key: "events/ev1/moments/a.jpg",
    partSize: 10,
    partCount: 1,
    fileSize: 10,
    fileType: "image/jpeg",
    fileName: "a.jpg",
    fileLastModified: 0,
    caption: null,
    uploaderName: "Sara",
    guestToken: "gt_left",
    completedParts: {},
    status: "paused",
    createdAt: 0,
    loadedBytes: 0,
    lastError: null,
  });

  it("stops at once, is marked failed, and asks for no background retry", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/status")
        ? json({ code: "guest_required" }, 403)
        : json({ error: "join the event first", code: "guest_required" }, 403)
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" });

    const error = await resumableUploadMoment({ slug: "party", file, caption: "", uploaderName: "Sara", resume: row() }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GuestRequiredError);
    expect((error as GuestRequiredError).sentToken).toBe("gt_left");
    // status (best-effort) + one part-url, no retries.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("part-url"))).toHaveLength(1);
    expect(store.saveUpload.mock.calls.at(-1)?.[0]).toMatchObject({ status: "failed" });
    expect(sync.requestPageUploadResume).not.toHaveBeenCalled();
  });
});

describe("a heart refused as guest_required", () => {
  it("throws GuestRequiredError with the token it sent", async () => {
    localStorage.setItem("moments:guest-token:party", "gt_left");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "join the event first", code: "guest_required" }, 403)));
    const error = await toggleMomentReaction("party", "m1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestRequiredError);
    expect((error as GuestRequiredError).sentToken).toBe("gt_left");
  });

  it("treats a proxy's 403 as an ordinary failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    const error = await toggleMomentReaction("party", "m1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GuestRequiredError);
  });
});
