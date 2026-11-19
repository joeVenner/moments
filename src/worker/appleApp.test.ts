import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
  appleAppSiteAssociation,
  isSmartAppBannerOn,
  smartAppBannerContent,
  withoutValidators,
  withSmartAppBanner,
  type HeadRewriter,
} from "./appleApp";
import type { Env } from "./types";
import { readFileSync } from "node:fs";

function call(path: string, init: RequestInit = {}, host = "moments-hq.com") {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const assets = { fetch: vi.fn(async () => new Response("spa")) } as unknown as Fetcher;
  return worker.fetch(new Request(`https://${host}${path}`, init), { ASSETS: assets } as unknown as Env, ctx);
}

describe("apple-app-site-association", () => {
  it("serves the association as JSON at the exact path, with no redirect", async () => {
    for (const host of ["moments-hq.com", "www.moments-hq.com"]) {
      const res = await call("/.well-known/apple-app-site-association", {}, host);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await res.json()).toEqual(appleAppSiteAssociation());
    }
  });

  it("names the app and the App Clip under the team", () => {
    const body = appleAppSiteAssociation();
    expect(body.applinks.details[0].appIDs).toEqual(["7877JLKPRQ.com.moments-hq.moments"]);
    expect(body.appclips.apps).toEqual(["7877JLKPRQ.com.moments-hq.moments.Clip"]);
  });

  it("opens event links in the app, but not the slideshow", () => {
    const components = appleAppSiteAssociation().applinks.details[0].components;
    // Apple takes the first matching component, so the exclusion must come first.
    expect(components.map((c) => [c["/"], c.exclude ?? false, c.caseSensitive ?? true])).toEqual([
      ["/e/*/slideshow*", true, false],
      ["/e/?*", false, true],
    ]);
    // A "?" key would make query strings part of the match and could drop
    // ?invite= links on private events.
    expect(components.every((c) => !("?" in c))).toBe(true);
  });

  it("is routed to the worker before static assets", () => {
    const wranglerSource = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(wranglerSource).toMatch(/"run_worker_first":\s*\[[^\]]*"\/\.well-known\/apple-app-site-association"/);
  });
});

describe("Smart App Banner", () => {
  /** Records what would be appended to <head>; transform keeps the response's headers. */
  function fakeRewriter() {
    const appended: string[] = [];
    const rewriter: HeadRewriter = {
      on(_selector, handlers) {
        handlers.element({ append: (content) => appended.push(content) });
        return rewriter;
      },
      transform: (response) => new Response(response.body, { status: response.status, headers: response.headers }),
    };
    return { appended, makeRewriter: () => rewriter };
  }
  const html = () =>
    new Response("<html><head></head></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"', "Last-Modified": "x", "X-Robots-Tag": "noindex" },
    });
  const page = (path: string) => new URL(`https://moments-hq.com${path}`);
  const META =
    '<meta name="apple-itunes-app" content="app-id=1234567890, app-clip-bundle-id=com.moments-hq.moments.Clip, app-clip-display=card, ' +
    'app-argument=https://moments-hq.com/e/party?invite=abc&amp;x=%22%3E">';

  it("needs a numeric App Store id", () => {
    for (const bad of [undefined, "", "abc", "12345", "1234567890123", '123456789"><script>', "id=123456789"]) {
      expect(isSmartAppBannerOn(bad)).toBe(false);
      expect(smartAppBannerContent(bad, "https://moments-hq.com/e/party")).toBeNull();
    }
    expect(isSmartAppBannerOn(" 1234567890 ")).toBe(true);
  });

  it("adds the meta with the page URL, escaped, and makes the page private and unvalidated", () => {
    const fake = fakeRewriter();
    const res = withSmartAppBanner(html(), {
      pageUrl: page('/e/party?invite=abc&x=">'),
      appStoreId: "1234567890",
      makeRewriter: fake.makeRewriter,
    });
    expect(fake.appended).toEqual([META]);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Last-Modified")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it.each([
    ["no App Store id", "/e/party", undefined, html],
    ["the slideshow", "/e/party/Slideshow/", "1234567890", html],
    ["a slideshow sub-path", "/e/party/slideshow-x", "1234567890", html],
    ["a non-HTML response", "/e/party", "1234567890", () => new Response("{}", { headers: { "Content-Type": "application/json" } })],
    ["a response without a type", "/e/party", "1234567890", () => new Response("x")],
    ["an error page", "/e/party", "1234567890", () => new Response("x", { status: 404, headers: { "Content-Type": "text/html" } })],
    ["a 304", "/e/party", "1234567890", () => new Response(null, { status: 304 })],
  ])("leaves %s untouched", (_label, path, appStoreId, make) => {
    const fake = fakeRewriter();
    const original = make();
    expect(withSmartAppBanner(original, { pageUrl: page(path), appStoreId, makeRewriter: fake.makeRewriter })).toBe(original);
    expect(fake.appended).toEqual([]);
  });

  it("drops the asset request's validators", () => {
    const request = withoutValidators(
      new Request("https://moments-hq.com/e/party", { headers: { "If-None-Match": '"abc"', "If-Modified-Since": "x", Accept: "text/html" } })
    );
    expect(request.headers.get("If-None-Match")).toBeNull();
    expect(request.headers.get("If-Modified-Since")).toBeNull();
    expect(request.headers.get("Accept")).toBe("text/html");
  });

  it("serves event pages unchanged while APP_STORE_ID is unset", async () => {
    const res = await call("/e/party");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spa");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("wires the route: page URL, App Store id, and an unconditional asset fetch", async () => {
    const appended: string[] = [];
    class FakeHTMLRewriter {
      on(_selector: string, handlers: { element(e: { append(c: string): void }): void }) {
        handlers.element({ append: (content) => appended.push(content) });
        return this;
      }
      transform(response: Response) {
        return response;
      }
    }
    vi.stubGlobal("HTMLRewriter", FakeHTMLRewriter);
    try {
      const assetFetch = vi.fn(async (_request: Request) => html());
      const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
      const env = { ASSETS: { fetch: assetFetch }, APP_STORE_ID: "1234567890" } as unknown as Env;
      const res = await worker.fetch(
        new Request('https://moments-hq.com/e/party?invite=abc&x=">', { headers: { "If-None-Match": '"abc"' } }),
        env,
        ctx
      );
      expect(appended).toEqual([META]);
      expect(assetFetch.mock.calls[0][0].headers.get("If-None-Match")).toBeNull();
      expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
      expect(res.headers.get("ETag")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
