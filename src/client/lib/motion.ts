import confetti from "canvas-confetti";

/** Whether the user has requested reduced motion at the OS/browser level. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Fires canvas-confetti only when the user hasn't asked for reduced motion. */
export function safeConfetti(options?: Parameters<typeof confetti>[0]): void {
  if (prefersReducedMotion()) return;
  confetti(options);
}
