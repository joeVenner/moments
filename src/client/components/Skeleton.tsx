export function EventCardSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
      <div className="h-4 w-2/3 rounded bg-[var(--color-border)]" />
      <div className="mt-2 h-3 w-1/3 rounded bg-[var(--color-border)]" />
    </div>
  );
}

export function MomentCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
      <div className="aspect-square w-full bg-[var(--color-border)]" />
      <div className="p-3">
        <div className="h-3 w-1/2 rounded bg-[var(--color-border)]" />
      </div>
    </div>
  );
}
