import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";

/**
 * Lightweight dot-field backdrop. It uses CSS gradients rather than a
 * continuous canvas/WebGL loop, so the event uploader keeps the main thread.
 * Pointer glow is desktop-only and updates CSS variables without React renders.
 */
export function DotField({ className = "" }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion() || !window.matchMedia("(pointer: fine)").matches) return;
    const onPointerMove = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      root.style.setProperty("--dot-x", `${event.clientX - bounds.left}px`);
      root.style.setProperty("--dot-y", `${event.clientY - bounds.top}px`);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  return (
    <div ref={rootRef} aria-hidden="true" className={`dot-field pointer-events-none ${className}`}>
      <div className="dot-field__base" />
      <div className="dot-field__glow" />
    </div>
  );
}
