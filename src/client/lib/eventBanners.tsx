import { prefersReducedMotion } from "./motion";
import { useI18n } from "./i18n";

// Type-aware banner scenes — the dark-native *no-cover* fallback for the event
// page (and the admin live preview). Each event type gets its own palette +
// motif, painted as a live CSS mesh in the DOM (crisp at any size, animatable,
// reduced-motion aware) rather than a rasterized PNG. This is the standing
// visual language mandated in CLAUDE.md → Design System: charcoal surfaces,
// near-white text, the single orange accent used sparingly. No light candy
// gradients (see the old `sampleBanners.ts` retheme note).
//
// The admin's *prebuilt pickable* banners still ride the PNG cover-upload path
// (the backend only trusts real uploads / `/media/` URLs) — those live in
// `sampleBanners.ts`, now repainted dark-native to echo these scenes.

export type BannerMotif = "bokeh" | "sparkle" | "confetti" | "scan" | "rings";

export interface EventBannerPreset {
  /** Stable id, also used as the i18n key suffix (`banner${Capitalize(id)}`). */
  id: "wedding" | "gala" | "birthday" | "corporate" | "other";
  /** i18n key for the human-facing label. */
  labelKey: string;
  /** Diagonal gradient stops, top-left → bottom-right. Dark-native only. */
  stops: [string, string, string];
  /** Soft accent used for the decorative motif dots / sparkles. */
  glow: string;
  /** Decorative motif layered over the mesh. */
  motif: BannerMotif;
}

export const EVENT_BANNER_PRESETS: EventBannerPreset[] = [
  {
    id: "wedding",
    labelKey: "bannerWedding",
    // Pearl/ivory warmth laid over charcoal — never bright white, stays legible.
    stops: ["#2b2b2b", "#3a3a3a", "#232323"],
    glow: "#e8e0d4",
    motif: "rings",
  },
  {
    id: "gala",
    labelKey: "bannerGala",
    // Deep oxblood + a gold glow — the single accent family, no second hue.
    stops: ["#3a1f1c", "#22120f", "#16100e"],
    glow: "#d9a85a",
    motif: "sparkle",
  },
  {
    id: "birthday",
    labelKey: "bannerBirthday",
    // Accent-orange + near-white confetti — reuses the brand confetti palette.
    stops: ["#2a1a16", "#1f1714", "#171010"],
    glow: "#d97757",
    motif: "confetti",
  },
  {
    id: "corporate",
    labelKey: "bannerCorporate",
    // Cool graphite + a cyan hairline — restrained, the only cool motif.
    stops: ["#222a2e", "#1a1f22", "#15191b"],
    glow: "#5fa8c4",
    motif: "scan",
  },
  {
    id: "other",
    labelKey: "bannerOther",
    // The upgraded default glow — accent mesh over the raised surface.
    stops: ["#262626", "#1f1f1f", "#1a1a1a"],
    glow: "#d97757",
    motif: "bokeh",
  },
];

const PRESET_BY_ID = new Map(EVENT_BANNER_PRESETS.map((p) => [p.id, p]));

/**
 * Resolves the banner preset for an event type. Unknown / "Other" types fall
 * back to the neutral `other` scene so every event always has a tailored cover.
 */
export function bannerForType(type: string | null | undefined): EventBannerPreset {
  const key = (type ?? "").toLowerCase();
  return (
    PRESET_BY_ID.get(key as EventBannerPreset["id"]) ??
    PRESET_BY_ID.get("other")!
  );
}

// Static decorative seeds per motif. Fixed (no Math.random — that's forbidden
// in the workflow runtime and undesirable here anyway: a banner should look
// the same every render, not flicker).
const BOKEH_DOTS = [
  { x: 0.18, y: 0.28, r: 220, a: 0.16 },
  { x: 0.78, y: 0.22, r: 150, a: 0.2 },
  { x: 0.62, y: 0.72, r: 260, a: 0.12 },
  { x: 0.32, y: 0.78, r: 120, a: 0.18 },
  { x: 0.88, y: 0.6, r: 90, a: 0.22 },
];

const CONFETTI_BITS = [
  { x: 0.12, y: 0.2, s: 6, d: "0s" },
  { x: 0.28, y: 0.35, s: 4, d: "0.4s" },
  { x: 0.46, y: 0.15, s: 7, d: "0.8s" },
  { x: 0.6, y: 0.3, s: 5, d: "1.2s" },
  { x: 0.74, y: 0.22, s: 6, d: "0.6s" },
  { x: 0.88, y: 0.32, s: 4, d: "1.6s" },
  { x: 0.2, y: 0.55, s: 5, d: "0.2s" },
  { x: 0.5, y: 0.5, s: 6, d: "1s" },
  { x: 0.82, y: 0.55, s: 4, d: "0.5s" },
];

const SPARKLES = [
  { x: 0.2, y: 0.3, s: 3, d: "0s" },
  { x: 0.35, y: 0.18, s: 2, d: "0.6s" },
  { x: 0.55, y: 0.35, s: 4, d: "1.1s" },
  { x: 0.72, y: 0.22, s: 2, d: "0.3s" },
  { x: 0.84, y: 0.4, s: 3, d: "0.9s" },
  { x: 0.45, y: 0.55, s: 2, d: "1.4s" },
];

/**
 * The live banner scene. Layered: gradient mesh → motif overlay → optional
 * bottom scrim for text legibility. All animation is skipped under
 * prefers-reduced-motion (the classes simply aren't applied).
 */
export function EventBannerScene({
  type,
  withScrim = false,
  className = "",
}: {
  type: string | null | undefined;
  /** Render the bottom-up dark scrim (set true when overlaying text). */
  withScrim?: boolean;
  className?: string;
}) {
  const reduced = prefersReducedMotion();
  const preset = bannerForType(type);
  const mesh = `linear-gradient(135deg, ${preset.stops[0]}, ${preset.stops[1]} 55%, ${preset.stops[2]})`;

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ background: mesh }}
      aria-hidden="true"
    >
      {/* Motif layer — each motif is a handful of absolutely-positioned dots
          driven by the keyframes in index.css. */}
      {!reduced && preset.motif === "bokeh" && (
        <div className="absolute inset-0 animate-banner-drift">
          {BOKEH_DOTS.map((dot, i) => (
            <span
              key={i}
              className="absolute rounded-full"
              style={{
                left: `${dot.x * 100}%`,
                top: `${dot.y * 100}%`,
                width: dot.r,
                height: dot.r,
                background: preset.glow,
                opacity: dot.a,
                filter: "blur(6px)",
              }}
            />
          ))}
        </div>
      )}

      {!reduced && preset.motif === "rings" && (
        <div className="absolute inset-0 animate-banner-rings">
          <span
            className="absolute left-1/2 top-1/2 h-[140%] w-[140%] -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ borderColor: `${preset.glow}33` }}
          />
          <span
            className="absolute left-1/2 top-1/2 h-[100%] w-[100%] -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ borderColor: `${preset.glow}22` }}
          />
          <span
            className="absolute left-1/2 top-1/2 h-[64%] w-[64%] -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ borderColor: `${preset.glow}1a` }}
          />
        </div>
      )}

      {!reduced && preset.motif === "sparkle" && (
        <div className="absolute inset-0">
          {SPARKLES.map((s, i) => (
            <span
              key={i}
              className="absolute animate-banner-sparkle rounded-[1px]"
              style={{
                left: `${s.x * 100}%`,
                top: `${s.y * 100}%`,
                width: s.s,
                height: s.s,
                background: preset.glow,
                boxShadow: `0 0 8px ${preset.glow}`,
                animationDelay: s.d,
              }}
            />
          ))}
        </div>
      )}

      {!reduced && preset.motif === "confetti" && (
        <div className="absolute inset-0">
          {CONFETTI_BITS.map((c, i) => (
            <span
              key={i}
              className="absolute animate-banner-confetti rounded-[1px]"
              style={{
                left: `${c.x * 100}%`,
                top: `${c.y * 100}%`,
                width: c.s,
                height: c.s * 1.6,
                background: i % 2 === 0 ? preset.glow : "#ededed",
                animationDelay: c.d,
              }}
            />
          ))}
        </div>
      )}

      {!reduced && preset.motif === "scan" && (
        <div className="absolute inset-0">
          {/* Faint vertical hairlines */}
          <div
            className="absolute inset-0 opacity-30"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${preset.glow}14 0 1px, transparent 1px 64px)`,
            }}
          />
          {/* Moving spotlight sweep */}
          <div
            className="absolute inset-y-0 w-1/3 animate-banner-scan"
            style={{
              background: `linear-gradient(90deg, transparent, ${preset.glow}1f, transparent)`,
            }}
          />
        </div>
      )}

      {withScrim && <div className="banner-scrim absolute inset-0" />}
    </div>
  );
}

/** Human label for a type's banner, via i18n. */
export function useBannerLabel(type: string | null | undefined): string {
  const { t } = useI18n();
  return t(bannerForType(type).labelKey);
}