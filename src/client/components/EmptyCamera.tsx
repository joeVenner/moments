/**
 * Line-art camera used for the empty-feed state. Pure SVG with no background,
 * stroked in the muted text token with an accent lens — so it blends into the
 * dark page instead of sitting on a baked-in white box like the old
 * `empty-feed.png` did. Inherits color via `currentColor`.
 */
export function EmptyCamera({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 96 96"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* viewfinder / flash hump */}
      <path d="M36 26h24l4 6H32z" />
      {/* body */}
      <rect x={12} y={30} width={72} height={44} rx={9} />
      {/* lens */}
      <circle cx={48} cy={52} r={15} />
      <circle cx={48} cy={52} r={7} stroke="var(--color-accent)" />
      <circle cx={48} cy={52} r={2.5} fill="var(--color-accent)" stroke="none" />
      {/* indicator dot */}
      <circle cx={70} cy={40} r={2.2} fill="currentColor" stroke="none" />
    </svg>
  );
}