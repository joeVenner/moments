import { useEffect, useState } from "react";
import { listMoments } from "../lib/api";
import type { MomentData } from "../lib/types";
import { MomentCard } from "./MomentCard";
import { MomentCardSkeleton } from "./Skeleton";

export function EventMoments({ slug }: { slug: string }) {
  const [moments, setMoments] = useState<MomentData[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMoments(null);
    listMoments(slug).then((r) => {
      if (!cancelled) setMoments(r.moments);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (moments === null) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        <MomentCardSkeleton />
        <MomentCardSkeleton />
        <MomentCardSkeleton />
      </div>
    );
  }

  const totalPoints = moments.reduce((sum, m) => sum + m.points_awarded, 0);

  return (
    <div>
      <p className="mb-2 font-mono text-xs text-slate-500">
        {moments.length} moment{moments.length === 1 ? "" : "s"} collected · {totalPoints} points total
      </p>
      {moments.length === 0 ? (
        <p className="text-sm text-slate-500">No moments collected yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {moments.map((moment) => (
            <MomentCard key={moment.id} moment={moment} />
          ))}
        </div>
      )}
    </div>
  );
}
