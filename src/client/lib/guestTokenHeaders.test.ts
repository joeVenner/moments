import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toggleMomentReaction, uploadMoment } from "./api";
import { abortResumableUpload } from "./multipartUpload";
import { guestTokenHeaders, setGuestToken } from "./nickname";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, value); },
  };
}

/** The token on every call made (one entry per fetch). */
const sentTokens = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get("X-Guest-Token"));
const sentToken = (fetchMock: ReturnType<typeof vi.fn>) => sentTokens(fetchMock)[0];

describe("guest token on web requests", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ moment: {}, reacted: true, reaction_count: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is the event's own token, or nothing", () => {
    expect(guestTokenHeaders("party")).toEqual({});
    setGuestToken("party", "tok-1");
    expect(guestTokenHeaders("party")).toEqual({ "X-Guest-Token": "tok-1" });
    expect(guestTokenHeaders("other")).toEqual({});
  });

  it("is empty where storage is missing (service worker) or blocked", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(guestTokenHeaders("party")).toEqual({});
  });

  it("goes with uploads and hearts", async () => {
    setGuestToken("party", "tok-1");
    await uploadMoment("party", new FormData());
    expect(sentToken(fetchMock)).toBe("tok-1");
    fetchMock.mockClear();
    await toggleMomentReaction("party", "m1");
    expect(sentToken(fetchMock)).toBe("tok-1");
  });

  it("goes with multipart calls", async () => {
    setGuestToken("party", "tok-1");
    // Its later IndexedDB cleanup has no IndexedDB under node; only the request matters here.
    await expect(abortResumableUpload("party", "up-1", "k")).rejects.toThrow(/indexedDB/);
    expect(sentTokens(fetchMock)).toEqual(["tok-1"]);
  });

  it("is left off for a guest without a token", async () => {
    await uploadMoment("party", new FormData());
    expect(sentToken(fetchMock)).toBeNull();
  });
});
