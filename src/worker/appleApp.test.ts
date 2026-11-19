import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import { appleAppSiteAssociation } from "./appleApp";
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
