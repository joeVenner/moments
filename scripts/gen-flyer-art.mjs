// One-shot generator for the "Celebration" graphic-rich flyer background
// (portrait 2:3). Calls OpenAI gpt-image-2 (/v1/images/generations), then
// downscales + converts the result to JPG (via macOS `sips`) before saving into
// src/client/assets/flyer/. Photographic art as PNG was ~1.9MB; JPG at 900px
// max edge is ~100KB — a ~19x payload cut with no visible loss under the flyer
// scrim. Used as a full-bleed flyer background with the QR on a light inset
// tile + a scrim for text legibility. Local-only — the key is read from
// .dev.vars (gitignored). Not shipped to the worker.
//
// The "Leaves" graphic-rich style is NOT generated here — it reuses the
// recovered historical flyer-frame.png (see git history, commit 33d06cf),
// converted to flyer-leaves.jpg by hand.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const ENV_PATH = new URL("../.dev.vars", import.meta.url);
function loadDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadDotenv(ENV_PATH);
const KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY missing (set it or put it in .dev.vars)");
  process.exit(1);
}

const PROMPT =
  "A premium portrait flyer background for an event photo-sharing app. A " +
  "celebratory, joyful scene of diverse guests at a party raising their " +
  "phones to capture the moment — hands and smartphones lifted, flashes and " +
  "glowing screens, confetti and warm sparks drifting through the air. Deep " +
  "charcoal (#1a1a1a) field with a single warm-orange accent (#d97757) in the " +
  "glows and rim-light. Frosted-glass depth: foreground hands/phones crisp, " +
  "background softly blurred and fainter. Elegant, premium, cinematic. Leave " +
  "the lower-center region relatively clear and uncluttered for a QR code and " +
  "title overlay. No readable text, no watermark, no logos. Portrait 2:3 " +
  "composition, centered with negative space.";

const OUT_DIR = new URL("../src/client/assets/flyer/", import.meta.url);
mkdirSync(OUT_DIR, { recursive: true });

const payload = {
  model: "gpt-image-2",
  prompt: PROMPT,
  size: "1024x1536", // 2:3 portrait — matches the flyer card aspect
  n: 1,
  background: "auto",
};

console.log("Generating Celebration flyer art (this can take 30-60s)…");
const res = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const body = await res.json();
const data = body.data ?? [];
if (!data.length) {
  console.error("No images returned:", JSON.stringify(body));
  process.exit(1);
}

const b64 = data[0].b64_json;
if (!b64) {
  console.error("no b64_json in response");
  process.exit(1);
}
const buf = Buffer.from(b64, "base64");
const png = new URL("flyer-celebration.png", OUT_DIR);
const jpg = new URL("flyer-celebration.jpg", OUT_DIR);
writeFileSync(png, buf);
// Downscale to 900px max edge and convert to JPG (quality 80). `sips` ships
// with macOS; this script is local-dev-only on darwin, so that's fine here.
execSync(`sips -Z 900 -s format jpeg -s formatOptions 80 "${png.pathname}" --out "${jpg.pathname}"`, { stdio: "ignore" });
rmSync(png);
console.log(`saved ${jpg.pathname} (${existsSync(jpg) ? "ok" : "FAILED"})`);
console.log("done.");