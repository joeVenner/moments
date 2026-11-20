import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCESS_GRANT_TTL_SECONDS } from "./worker/eventAccess";
import { capWithGrace, TEST_EVENT_GUEST_CAP } from "./worker/guestCap";
import { READONLY_DAYS_AFTER_LAPSE, READONLY_DAYS_AFTER_REFUND } from "./worker/plans";

/**
 * The Terms of Use and Privacy Policy are static pages in `public/`, served
 * by moments-hq.com and copied as they are to GitHub Pages (under a
 * `/moments/` prefix). App Review and the landing link to them.
 */
const ROOT = join(__dirname, "..");
const PAGES = ["terms.html", "privacy.html", "fr/terms.html", "fr/privacy.html"] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

describe("legal pages", () => {
  it.each(PAGES)("%s stands alone: no scripts, no outside styles or fonts", (page) => {
    const html = read(`public/${page}`);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain(`<html lang="${page.startsWith("fr/") ? "fr" : "en"}">`);
    expect(html).not.toMatch(/<script|<link |<iframe|<img/i);
    expect(html).not.toMatch(/src="/);
  });

  it.each(PAGES)("%s links only to pages that exist, by relative paths", (page) => {
    const html = read(`public/${page}`);
    for (const href of hrefs(html)) {
      if (/^(https:|mailto:)/.test(href)) continue;
      // A root-relative link would leave GitHub Pages' /moments/ prefix.
      expect(href.startsWith("/"), `${page}: ${href}`).toBe(false);
      const target = posix.normalize(posix.join(posix.dirname(page), href));
      expect(existsSync(join(ROOT, "public", `${target}.html`)), `${page}: ${href}`).toBe(true);
    }
  });

  it("keeps the English and French versions in step", () => {
    for (const name of ["terms", "privacy"]) {
      const sections = (html: string) => html.match(/<h2>/g)?.length ?? 0;
      const en = read(`public/${name}.html`);
      const fr = read(`public/fr/${name}.html`);
      expect(sections(en)).toBeGreaterThan(4);
      expect(sections(fr)).toBe(sections(en));
      expect(hrefs(en)).toContain(`fr/${name}`);
      expect(hrefs(fr)).toContain(`../${name}`);
    }
  });

  it("publishes exactly these pages to GitHub Pages, never docs/", () => {
    const workflow = read(".github/workflows/legal-pages.yml");
    expect(workflow).toContain("cp public/terms.html public/privacy.html _site/");
    expect(workflow).toContain("cp public/fr/terms.html public/fr/privacy.html _site/fr/");
    expect(workflow).toContain("path: _site");
    expect(workflow).not.toMatch(/path: \.?\/?docs|cp -r/);
    for (const page of PAGES) expect(workflow).toContain(`public/${page}`);
    expect(existsSync(join(ROOT, ".github/pages/index.html"))).toBe(true);
    // The job refuses pages that still hold draft placeholders.
    const guard = workflow.match(/grep -nE "(.+?)" public/)?.[1];
    expect(guard).toBeDefined();
    const placeholder = new RegExp(guard!.replace(/\\\\/g, "\\"));
    expect(placeholder.test("<a href=\"mailto:[CONTACT EMAIL]\">")).toBe(true);
    expect(placeholder.test("[NOM DE L'ENTITÉ]")).toBe(true);
    expect(placeholder.test("<h2>Your rights</h2> [1]")).toBe(false);
    expect(workflow.indexOf("Refuse unfinished pages")).toBeLessThan(workflow.indexOf("upload-pages-artifact"));
    // No accented character ranges (they break outside a UTF-8 locale), and a grep
    // error must fail the job, not pass as "no placeholders".
    expect(guard).not.toMatch(/[^\x00-\x7f]-|-[^\x00-\x7f]/);
    expect(workflow).toContain('elif [ "$status" -ne 1 ]; then');
  });

  it("lists every page in the sitemap", () => {
    const sitemap = read("public/sitemap.xml");
    for (const page of PAGES) {
      expect(sitemap).toContain(`<loc>https://moments-hq.com/${page.replace(/\.html$/, "")}</loc>`);
    }
  });

  it("states the numbers the code enforces", () => {
    const terms = read("public/terms.html");
    const privacy = read("public/privacy.html");
    expect(capWithGrace(100)).toBe(110);
    expect(terms).toContain("Up to 10% more guests");
    expect(terms).toContain(`up to ${TEST_EVENT_GUEST_CAP} guests`);
    expect(terms).toContain(`${READONLY_DAYS_AFTER_LAPSE} days to download everything (${READONLY_DAYS_AFTER_REFUND} days after a refund)`);
    expect(privacy).toContain(`valid ${ACCESS_GRANT_TTL_SECONDS / 86_400} days`);
    expect(privacy).toContain(`${READONLY_DAYS_AFTER_LAPSE} days to download, ${READONLY_DAYS_AFTER_REFUND} after a refund`);
  });

  it("names every outside host the website loads", () => {
    const privacy = read("public/privacy.html");
    const index = read("index.html");
    const hosts = new Set([...index.matchAll(/(?:href|src)="https:\/\/([^/"]+)/g)].map((match) => match[1]));
    const named: Record<string, string> = {
      "fonts.googleapis.com": "Google Fonts",
      "fonts.gstatic.com": "Google Fonts",
      "moments-hq.com": "Cloudflare",
      "wa.me": "WhatsApp",
    };
    for (const host of hosts) {
      expect(named[host], `index.html loads ${host}: name it in privacy.html`).toBeDefined();
      if (named[host] !== "WhatsApp") expect(privacy).toContain(named[host]);
    }
  });

  it("names the processors the code really uses", () => {
    const privacy = read("public/privacy.html");
    // AI covers send the host's photo to OpenAI (src/worker/banner.ts).
    expect(readFileSync(join(dirname(__filename), "worker/banner.ts"), "utf8")).toContain("api.openai.com");
    for (const processor of ["Cloudflare", "OpenAI", "Apple"]) expect(privacy).toContain(processor);
  });
});
