// Dark-native brand mark: a bare accent camera aperture (ring + center dot),
// no rounded-square backing. Inline SVG so it stays crisp on the dark surfaces
// and blends with a fully-dark background (the old logo.png has a baked light
// background that clashes — it's now kept only on the print flyer).
export function BrandMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="var(--color-accent)" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.8" fill="var(--color-accent)" />
    </svg>
  );
}
