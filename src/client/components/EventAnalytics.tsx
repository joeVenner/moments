import { useEffect, useMemo, useState } from "react";
import { getEventAnalytics, type EventAnalyticsData } from "../lib/api";
import { useI18n } from "../lib/i18n";

function formatStorage(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function EventAnalytics({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<EventAnalyticsData | null>(null);
  useEffect(() => {
    let disposed = false;
    void getEventAnalytics(slug).then((result) => { if (!disposed) setData(result); });
    return () => { disposed = true; };
  }, [slug]);
  const maxActivity = useMemo(() => Math.max(1, ...(data?.activity.map((item) => item.count) ?? [1])), [data]);
  if (!data) return <div className="h-32 animate-pulse rounded-lg bg-[var(--color-border)]" />;
  const cards = [
    [t("analyticsMoments"), data.summary.total_moments],
    [t("analyticsGuests"), data.summary.participants],
    [t("analyticsReactions"), data.summary.reactions],
    [t("analyticsStorage"), formatStorage(data.summary.storage_bytes)],
  ];
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <p className="font-mono text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t("eventAnalytics")}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cards.map(([label, value]) => <div key={String(label)} className="rounded-lg bg-[var(--color-bg-alt)] p-3"><p className="font-mono text-[10px] uppercase text-[var(--color-text-muted)]">{label}</p><p className="mt-1 text-xl font-semibold text-[var(--color-text)]">{value}</p></div>)}
      </div>
      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase text-[var(--color-text-muted)]">{t("last14Days")}</p>
        <div className="mt-2 flex h-20 items-end gap-1">
          {data.activity.length === 0 ? <p className="text-xs text-[var(--color-text-muted)]">{t("noActivityYet")}</p> : data.activity.map((item) => <div key={item.day} title={`${item.day}: ${item.count}`} className="min-w-2 flex-1 rounded-t bg-[var(--color-accent)]/70" style={{ height: `${Math.max(8, item.count / maxActivity * 100)}%` }} />)}
        </div>
      </div>
      <p className="mt-3 font-mono text-[10px] text-[var(--color-text-muted)]">{t("analyticsBreakdown", { photos: data.summary.photos, videos: data.summary.videos, hidden: data.summary.hidden_moments })}</p>
    </section>
  );
}
