import confetti from "canvas-confetti";

/**
 * On-brand confetti palette for the dark theme: the orange accent (+ its
 * darker shade) and near-white. Replaces canvas-confetti's default rainbow,
 * which clashes with the near-black surfaces (see CLAUDE.md → Design System).
 */
export const BRAND_CONFETTI_COLORS = ["#d97757", "#c15f3c", "#ededed"];

/** Whether the user has requested reduced motion at the OS/browser level. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Fires canvas-confetti only when the user hasn't asked for reduced motion.
 * Defaults to the brand palette so every celebration stays dark-theme legible;
 * callers can still override `colors`.
 */
export function safeConfetti(options?: Parameters<typeof confetti>[0]): void {
  if (prefersReducedMotion()) return;
  confetti({ colors: BRAND_CONFETTI_COLORS, ...options });
}
