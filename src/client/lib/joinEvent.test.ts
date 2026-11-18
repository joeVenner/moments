import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinEvent } from "./api";
import { getGuestToken } from "./nickname";

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

function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
}

describe("joinEvent", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the token when the join succeeds", async () => {
    answer(200, { participant: {}, guest_token: "tok-1" });
    expect(await joinEvent("party", "Sara", "seed")).toBe("joined");
    expect(getGuestToken("party")).toBe("tok-1");
  });

  it("keeps no token and stops on a rate limit, even with an odd body", async () => {
    answer(429, { code: "rate_limited", guest_token: "nope" });
    expect(await joinEvent("party", "Sara", "seed")).toBe("rate_limited");
    answer(429, "null");
    expect(await joinEvent("party", "Sara", "seed")).toBe("rate_limited");
    expect(getGuestToken("party")).toBeNull();
  });

  it("stops when the nickname is taken", async () => {
    answer(409, { code: "nickname_taken" });
    expect(await joinEvent("party", "Sara", "seed")).toBe("nickname_taken");
  });

  it("lets the guest in on a server error or a non-JSON body", async () => {
    answer(500, "<html>oops</html>");
    expect(await joinEvent("party", "Sara", "seed")).toBe("unavailable");
  });

  it("lets the guest in when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await joinEvent("party", "Sara", "seed")).toBe("unavailable");
  });
});
