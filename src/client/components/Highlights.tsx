import { useEffect, useState } from "react";
import type { MomentData } from "../lib/types";
import { listHighlights } from "../lib/api";
import { MomentCard } from "./MomentCard";
import { MomentCardSkeleton } from "./Skeleton";
import { useI18n } from "../lib/i18n";

export function Highlights({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [moments, setMoments] = useState<MomentData[] | null>(null);

  useEffect(() => {
    let disposed = false;
    void listHighlights(slug).then(({ moments }) => {
      if (!disposed) setMoments(moments);
    });
    return () => { disposed = true; };
  }, [slug]);

  if (!moments) return <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3"><MomentCardSkeleton /><MomentCardSkeleton /></div>;
  if (moments.length === 0) return <p className="mt-8 text-center text-sm text-[var(--color-text-muted)]">{t("noHighlightsYet")}</p>;
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {moments.map((moment, index) => <MomentCard key={moment.id} moment={moment} index={index} slug={slug} />)}
    </div>
  );
}
