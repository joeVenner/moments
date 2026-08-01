import { readFile } from "node:fs/promises";

const base = process.env.BASE_URL?.replace(/\/$/, "");
const indexNowKey = "fa60290795b4f44bb333d99a718a705e";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [html, robots, sitemap, llms, indexNowKeyFile] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/robots.txt", import.meta.url), "utf8"),
  readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
  readFile(new URL("../public/llms.txt", import.meta.url), "utf8"),
  readFile(new URL(`../public/${indexNowKey}.txt`, import.meta.url), "utf8"),
]);

assert(html.includes("<link rel=\"canonical\" href=\"https://moments-hq.com/\""), "canonical URL missing");
assert(html.includes("name=\"description\""), "meta description missing");
assert(html.includes("property=\"og:image\""), "Open Graph image missing");
assert(html.includes("application/ld+json"), "JSON-LD missing");
const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
assert(jsonLd, "JSON-LD payload missing");
JSON.parse(jsonLd);
assert(html.includes("Event photo sharing, live the instant it happens"), "crawlable homepage copy missing");
assert(robots.includes("User-agent: OAI-SearchBot"), "OAI-SearchBot policy missing");
assert(robots.includes("User-agent: GPTBot"), "GPTBot privacy policy missing");
assert(robots.includes("Disallow: /e/"), "GPTBot event-content protection missing");
assert(robots.includes("User-agent: Claude-SearchBot"), "Claude search policy missing");
assert(robots.includes("User-agent: ClaudeBot"), "Claude training privacy policy missing");
assert(robots.includes("User-agent: PerplexityBot"), "Perplexity search policy missing");
assert(robots.includes("Sitemap: https://moments-hq.com/sitemap.xml"), "robots sitemap reference missing");
assert(sitemap.includes("<loc>https://moments-hq.com/</loc>"), "canonical sitemap URL missing");
assert(llms.includes("# Moments"), "AI-readable site summary missing");
assert(indexNowKeyFile.trim() === indexNowKey, "local IndexNow key content mismatch");

if (base) {
  const [homeResponse, robotsResponse, sitemapResponse, llmsResponse, adminResponse] = await Promise.all([
    fetch(`${base}/`),
    fetch(`${base}/robots.txt`),
    fetch(`${base}/sitemap.xml`),
    fetch(`${base}/llms.txt`),
    fetch(`${base}/admin`),
  ]);
  assert(homeResponse.ok, `homepage returned ${homeResponse.status}`);
  assert(robotsResponse.ok, `robots.txt returned ${robotsResponse.status}`);
  assert(sitemapResponse.ok, `sitemap.xml returned ${sitemapResponse.status}`);
  assert(llmsResponse.ok, `llms.txt returned ${llmsResponse.status}`);
  assert(adminResponse.headers.get("x-robots-tag")?.includes("noindex"), "admin noindex header missing");
  const indexNowKeyResponse = await fetch(`${base}/${indexNowKey}.txt`);
  assert(indexNowKeyResponse.ok, `IndexNow key returned ${indexNowKeyResponse.status}`);
  assert((await indexNowKeyResponse.text()).trim() === indexNowKey, "IndexNow key content mismatch");

  const liveHtml = await homeResponse.text();
  assert(liveHtml.includes("https://moments-hq.com/"), "deployed canonical metadata missing");
  assert(liveHtml.includes("Event photo sharing, live the instant it happens"), "deployed crawlable copy missing");
}

console.log(JSON.stringify({ static: "ok", production: base ? "ok" : "not-requested" }));
