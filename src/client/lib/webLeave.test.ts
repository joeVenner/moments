import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  listUploads: vi.fn(async (_slug?: string) => [] as { id: string }[]),
  deleteUpload: vi.fn(async (_id: string) => undefined),
}));
vi.mock("./uploadStore", () => store);

import { getGuestToken, getNickname, setGuestToken, setNickname } from "./nickname";
import { forgetGuest, leaveEvent, MAX_LEAVE_CALLS, type LeaveDeps } from "./webLeave";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deps(...responses: Array<Response | Error>): LeaveDeps & { post: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => {
    const next = responses.shift() ?? json({ done: false });
    if (next instanceof Error) throw next;
    return next;
  });
  return { post, forget: vi.fn(async () => undefined) };
}

beforeEach(() => {
  store.listUploads.mockClear();
  store.deleteUpload.mockClear();
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("leaveEvent", () => {
  it("repeats until the server is done, then forgets the guest", async () => {
    const d = deps(json({ done: false }), json({ done: false }), json({ done: true }));
    expect(await leaveEvent("party", d)).toBe("left");
    expect(d.post).toHaveBeenCalledTimes(3);
    expect(d.forget).toHaveBeenCalledWith("party");
  });

  it("treats a refused token as already left (a lost response to the last call)", async () => {
    const d = deps(json({ code: "guest_required" }, 403));
    expect(await leaveEvent("party", d)).toBe("left");
    expect(d.forget).toHaveBeenCalledOnce();
  });

  it.each([
    ["rate limited", json({ code: "rate_limited" }, 429), "rate_limited"],
    ["storage down", json({ code: "storage_unavailable" }, 502), "failed"],
    ["the event is gone", json({ error: "event not found" }, 404), "failed"],
    ["offline", new TypeError("Failed to fetch"), "failed"],
    ["a 200 that isn't JSON (a captive portal)", new Response("<html>", { status: 200 }), "failed"],
    ["a done that isn't a boolean", json({ done: "yes" }), "failed"],
    ["a 403 from something else (a proxy, a firewall)", new Response("Forbidden", { status: 403 }), "failed"],
    ["a 403 with another code", json({ code: "uploads_closed" }, 403), "failed"],
  ] as const)("keeps everything, after one call, when %s", async (_label, response, outcome) => {
    const d = deps(response);
    expect(await leaveEvent("party", d)).toBe(outcome);
    expect(d.post).toHaveBeenCalledOnce();
    expect(d.forget).not.toHaveBeenCalled();
  });

  it("keeps everything when a later call fails after partial progress", async () => {
    const d = deps(json({ done: false }), json({ code: "storage_unavailable" }, 502));
    expect(await leaveEvent("party", d)).toBe("failed");
    expect(d.forget).not.toHaveBeenCalled();
  });

  it("gives up after a bounded number of calls, keeping the token for a retry", async () => {
    const d = deps();
    expect(await leaveEvent("party", d)).toBe("failed");
    expect(d.post).toHaveBeenCalledTimes(MAX_LEAVE_CALLS);
    expect(d.forget).not.toHaveBeenCalled();
  });
});

describe("forgetGuest", () => {
  it("deletes the event's saved uploads and the guest's nickname and token", async () => {
    setNickname("party", "Sara");
    setGuestToken("party", "gt_sara");
    setGuestToken("other", "gt_other");
    store.listUploads.mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }]);

    await forgetGuest("party");

    expect(store.listUploads).toHaveBeenCalledWith("party");
    expect(store.deleteUpload.mock.calls.map(([id]) => id)).toEqual(["u1", "u2"]);
    expect(getNickname("party")).toBeNull();
    expect(getGuestToken("party")).toBeNull();
    // Other events are untouched.
    expect(getGuestToken("other")).toBe("gt_other");
  });

  it("deletes the other uploads when one delete fails", async () => {
    store.listUploads.mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }]);
    store.deleteUpload.mockRejectedValueOnce(new DOMException("busy", "InvalidStateError"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await forgetGuest("party");

    expect(store.deleteUpload.mock.calls.map(([id]) => id)).toEqual(["u1", "u2"]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), "InvalidStateError");
  });

  it("drops this event's tus resume entries, and only those", async () => {
    localStorage.setItem("tus::tus-br-clip.mp4-video/mp4-10-1-/api/events/party/moments/stream/tus?session=s1::1", "{}");
    localStorage.setItem("tus::tus-br-clip.mp4-video/mp4-10-1-/api/events/partyhouse/moments/stream/tus?session=s2::1", "{}");
    localStorage.setItem("moments:lang", "fr");

    await forgetGuest("party");

    expect(localStorage.getItem("tus::tus-br-clip.mp4-video/mp4-10-1-/api/events/party/moments/stream/tus?session=s1::1")).toBeNull();
    expect(localStorage.getItem("tus::tus-br-clip.mp4-video/mp4-10-1-/api/events/partyhouse/moments/stream/tus?session=s2::1")).toBe("{}");
    expect(localStorage.getItem("moments:lang")).toBe("fr");
  });

  it("still forgets the guest when browser storage fails", async () => {
    setNickname("party", "Sara");
    setGuestToken("party", "gt_sara");
    store.listUploads.mockRejectedValueOnce(new DOMException("blocked", "SecurityError"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await forgetGuest("party");

    expect(getNickname("party")).toBeNull();
    expect(getGuestToken("party")).toBeNull();
  });
});
