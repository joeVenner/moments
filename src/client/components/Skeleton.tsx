export function EventCardSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-200 bg-white p-4">
      <div className="h-4 w-2/3 rounded bg-slate-200" />
      <div className="mt-2 h-3 w-1/3 rounded bg-slate-200" />
    </div>
  );
}

export function MomentCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="aspect-square w-full bg-slate-200" />
      <div className="p-3">
        <div className="h-3 w-1/2 rounded bg-slate-200" />
      </div>
    </div>
  );
}
