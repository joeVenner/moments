import { BrandMark } from "./BrandMark";

export function Header() {
  return (
    // No background pill — just the camera mark + wordmark sitting on the page,
    // so it blends with a fully-dark background instead of floating in a gray
    // box. A soft drop-shadow keeps both legible over a bright cover image.
    <div
      style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      className="fixed left-3 z-40 flex items-center gap-1.5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
    >
      <BrandMark className="h-6 w-6 shrink-0" />
      <span className="font-display text-sm font-semibold text-[var(--color-text)]">
        Moments
      </span>
    </div>
  );
}