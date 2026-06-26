import type { Env } from "./types";

const AI_BANNER_MODEL = "gpt-image-2";
const MAX_SELFIE_BYTES = 8 * 1024 * 1024; // 8MB — this is a portrait photo, not an event upload
const REQUEST_TIMEOUT_MS = 90_000; // gpt-image-2 edits at this size routinely take 30-50s+

export class BannerGenerationError extends Error {}

// The banner is displayed as a 3:2 landscape header card (matches the
// `aspect-[3/2]` event hero). gpt-image-2 only accepts three fixed sizes, so we
// request `1536x1024` (the 3:2 landscape option) and tell the model the exact
// target so it composes for a header — subject kept centrally, clear of the
// bottom edge where the title overlay + scrim sit.
const BANNER_SIZE = "1536x1024";

function promptForTheme(theme: string): string {
  return (
    `Create an elegant, professional event banner inspired by this photo. ` +
    `Theme: ${theme || "celebration"}. Warm, inviting lighting, tasteful and ` +
    `not overly literal — a banner background, not a portrait collage. ` +
    `The image is a landscape header banner displayed at a 3:2 ratio ` +
    `(1536x1024). Compose with the main interest centered and keep the bottom ` +
    `third relatively uncluttered and darker, since a title and a short ` +
    `description overlay it. No text, no watermarks.`
  );
}

export async function generateAiBanner(
  env: Env,
  selfie: File,
  theme: string
): Promise<{ key: string; url: string }> {
  if (!env.OPENAI_API_KEY) {
    throw new BannerGenerationError("AI banner generation is not configured");
  }
  if (!selfie.type.startsWith("image/")) {
    throw new BannerGenerationError("Selfie must be an image");
  }
  if (selfie.size > MAX_SELFIE_BYTES) {
    throw new BannerGenerationError("Selfie too large (max 8MB)");
  }

  const form = new FormData();
  form.append("model", AI_BANNER_MODEL);
  form.append("image", selfie, selfie.name || "selfie.jpg");
  form.append("prompt", promptForTheme(theme));
  form.append("size", BANNER_SIZE);
  form.append("n", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    throw new BannerGenerationError(
      err instanceof Error && err.name === "AbortError"
        ? "AI banner generation timed out"
        : "Could not reach the AI banner service"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new BannerGenerationError(`AI banner service returned ${response.status}`);
  }

  const body = await response.json<{ data?: Array<{ b64_json?: string }> }>().catch(() => null);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) {
    throw new BannerGenerationError("AI banner service returned no image");
  }

  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const key = `ai-banners/${crypto.randomUUID()}.png`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/png" } });

  return { key, url: `/media/${key}` };
}
