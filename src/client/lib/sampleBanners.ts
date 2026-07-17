// Ready-made banner fallbacks. When AI generation fails (or isn't configured),
// the admin can pick one of these instead of being stuck with no cover. Each
// theme is painted onto a 1536x1024 canvas — matching the AI banner's aspect
// ratio — and exported as a PNG File so it flows through the exact same
// `cover` upload path as a hand-picked photo (the backend only trusts real
// image uploads or its own /media/ URLs for the cover).
//
// Repainted dark-native (2026-06) to follow CLAUDE.md → Design System: the old
// light candy gradients (#f6d365, #fad0c4, #a18cd1…) clashed with the charcoal
// page and violated the dark-theme mandate. Each swatch now echoes one of the
// live type scenes in `eventBanners.ts` (midnight→Corporate, sunset→Gala,
// confetti→Birthday, forest→Wedding, golden/blush→Other/celebratory) so the
// pickable static covers feel of-a-piece with the animated fallback.

export interface SampleBanner {
  id: string;
  /** i18n key for the human-facing label. */
  labelKey: string;
  /** Diagonal gradient stops, top-left → bottom-right. Dark-native only. */
  stops: [string, string, string];
  /** Soft accent used for the decorative bokeh dots. */
  glow: string;
}

export const SAMPLE_BANNERS: SampleBanner[] = [
  // Other / celebratory — warm accent mesh.
  { id: "golden", labelKey: "sampleGolden", stops: ["#2a1a16", "#1f1714", "#171010"], glow: "#d97757" },
  // Other / celebratory — near-white sparkle on charcoal.
  { id: "blush", labelKey: "sampleBlush", stops: ["#2b2b2b", "#3a3a3a", "#232323"], glow: "#e8e0d4" },
  // Corporate — cool graphite + cyan.
  { id: "midnight", labelKey: "sampleMidnight", stops: ["#222a2e", "#1a1f22", "#15191b"], glow: "#5fa8c4" },
  // Gala — deep oxblood + gold.
  { id: "sunset", labelKey: "sampleSunset", stops: ["#3a1f1c", "#22120f", "#16100e"], glow: "#d9a85a" },
  // Wedding — emerald-tinted charcoal.
  { id: "forest", labelKey: "sampleForest", stops: ["#1f2a24", "#172019", "#121a15"], glow: "#bfe3c0" },
  // Birthday — accent + near-white confetti.
  { id: "confetti", labelKey: "sampleConfetti", stops: ["#2a1a16", "#1f1714", "#171010"], glow: "#d97757" },
];

/**
 * Picks a sample-banner id that echoes the live scene for a given event type,
 * so the admin's fallback picker can pre-select a cover that matches the
 * occasion. Falls back to "golden" (the warm Other default) for unknown types.
 */
export function sampleBannerIdForType(type: string | null | undefined): string {
  switch ((type ?? "").toLowerCase()) {
    case "wedding":
      return "forest";
    case "gala":
      return "sunset";
    case "birthday":
      return "confetti";
    case "corporate":
      return "midnight";
    default:
      return "golden";
  }
}

const BANNER_WIDTH = 1536;
const BANNER_HEIGHT = 1024;

/**
 * Paints a sample banner to an offscreen canvas and returns it as a PNG File.
 * The optional title is drawn faintly so a bare-fallback banner still feels
 * tailored to the event rather than a generic swatch.
 */
export async function renderSampleBanner(
  banner: SampleBanner,
  title?: string
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = BANNER_WIDTH;
  canvas.height = BANNER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const gradient = ctx.createLinearGradient(0, 0, BANNER_WIDTH, BANNER_HEIGHT);
  gradient.addColorStop(0, banner.stops[0]);
  gradient.addColorStop(0.55, banner.stops[1]);
  gradient.addColorStop(1, banner.stops[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, BANNER_WIDTH, BANNER_HEIGHT);

  // Scattered soft "bokeh" circles for a celebratory, photographed-light feel.
  const dots = [
    { x: 0.18, y: 0.28, r: 220, a: 0.18 },
    { x: 0.78, y: 0.22, r: 150, a: 0.22 },
    { x: 0.62, y: 0.72, r: 260, a: 0.14 },
    { x: 0.32, y: 0.78, r: 120, a: 0.2 },
    { x: 0.88, y: 0.6, r: 90, a: 0.25 },
  ];
  for (const dot of dots) {
    ctx.beginPath();
    ctx.globalAlpha = dot.a;
    ctx.fillStyle = banner.glow;
    ctx.arc(dot.x * BANNER_WIDTH, dot.y * BANNER_HEIGHT, dot.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const trimmed = title?.trim();
  if (trimmed) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 92px Fraunces, Georgia, serif";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 4;
    ctx.fillText(trimmed.slice(0, 40), BANNER_WIDTH / 2, BANNER_HEIGHT / 2);
    ctx.restore();
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("Could not render sample banner");
  return new File([blob], `sample-banner-${banner.id}.png`, { type: "image/png" });
}
