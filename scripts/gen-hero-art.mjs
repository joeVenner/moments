// One-shot generator for the landing hero centerpiece (PLAN landing-wow).
// Calls OpenAI gpt-image-2 (/v1/images/generations) on a SOLID NEAR-BLACK
// background and saves PNGs into src/client/assets/. The result is composited
// in-page via mix-blend-screen (gpt-image-2 rejects background:"transparent",
// so we fake transparency by blending the dark base away). Local-only — the
// key is read from .dev.vars (gitignored). Not shipped to the worker.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENV_PATH = new URL("../.dev.vars", import.meta.url);
function loadDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
  "A hero illustration for an event photo-sharing app, dark-native aesthetic, " +
  "ON A SOLID NEAR-BLACK (#0a0a0a) BACKGROUND (no gradient). A dynamic upward " +
  "spiral of translucent frosted-glass polaroid photo cards floating around a " +
  "central softly-glowing QR code. The polaroids are tilted at varied angles, " +
  "their edges rim-lit with a single warm-orange light (#d97757), faint inner " +
  "reflections, no readable text on the cards. The QR code core emits a soft " +
  "warm-orange glow and gentle volumetric light rays rising upward. Tiny " +
  "drifting particles and sparks in warm orange and near-white, like soft dust " +
  "in a dark room. Strong depth: foreground cards crisp and brighter, distant " +
  "cards softly blurred and fainter. A single warm-orange accent color on a " +
  "near-black field, elegant, premium, minimal. No text, no watermark, no " +
  "logos, no human faces. Centered balanced composition with negative space.";

const OUT_DIR = new URL("../src/client/assets/", import.meta.url);

const payload = {
  model: "gpt-image-2",
  prompt: PROMPT,
  size: "1024x1024",
  n: 2,
  background: "auto",
};

console.log("Generating (this can take 30-60s)…");
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

for (let i = 0; i < data.length; i++) {
  const b64 = data[i].b64_json;
  if (!b64) {
    console.error(`variant ${i}: no b64_json`);
    continue;
  }
  const buf = Buffer.from(b64, "base64");
  const path = new URL(`hero-collage-${String.fromCharCode(97 + i)}.png`, OUT_DIR);
  writeFileSync(path, buf);
  console.log(`saved ${path.pathname} (${buf.length} bytes)`);
}
console.log("done.");