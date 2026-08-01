import { useEffect, useState } from "react";
import { deleteAdminMoment, listAdminMoments, setMomentModeration } from "../lib/api";
import type { MomentData } from "../lib/types";
import { MomentCard } from "./MomentCard";
import { MomentCardSkeleton } from "./Skeleton";
import { useI18n } from "../lib/i18n";

export function EventMoments({ slug, title = slug }: { slug: string; title?: string }) {
  const { t } = useI18n();
  const [moments, setMoments] = useState<MomentData[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMoments(null);
    listAdminMoments(slug).then((r) => {
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
  const selectedMoments = moments.filter((moment) => selected.has(moment.id));

  const applyStatus = async (ids: string[], status: "approved" | "hidden") => {
    setBusy(true);
    try {
      const updated = await Promise.all(ids.map((id) => setMomentModeration(id, status)));
      const byId = new Map(updated.map(({ moment }) => [moment.id, moment]));
      setMoments((current) => current?.map((moment) => byId.get(moment.id) ?? moment) ?? []);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ids: string[]) => {
    if (!window.confirm(t("confirmDeleteMoments", { count: ids.length }))) return;
    setBusy(true);
    try {
      await Promise.all(ids.map(deleteAdminMoment));
      setMoments((current) => current?.filter((moment) => !ids.includes(moment.id)) ?? []);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  const download = async (items: MomentData[]) => {
    setBusy(true);
    try {
      const { downloadMomentsZip } = await import("../lib/zipExport");
      await downloadMomentsZip(title, items);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-2 font-mono text-xs text-[var(--color-text-muted)]">
        {t("momentsCollected", { count: moments.length, points: totalPoints })}
      </p>
      {moments.length > 0 && (
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          {selectedMoments.length > 0 && <button type="button" disabled={busy} onClick={() => void download(selectedMoments)} className="rounded-full border border-[var(--color-border)] px-3 py-1 font-mono text-xs text-[var(--color-accent)] disabled:opacity-50">{t("downloadSelected")}</button>}
          <button type="button" disabled={busy} onClick={() => void download(moments)} className="rounded-full border border-[var(--color-border)] px-3 py-1 font-mono text-xs text-[var(--color-accent)] disabled:opacity-50">{t("downloadAlbum")}</button>
        </div>
      )}
      {selectedMoments.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
          <span className="mr-auto font-mono text-xs text-[var(--color-text-muted)]">
            {t("momentsSelected", { count: selectedMoments.length })}
          </span>
          <button type="button" disabled={busy} onClick={() => void applyStatus([...selected], "approved")} className="rounded-full border border-[var(--color-border)] px-3 py-1 font-mono text-xs text-emerald-400 disabled:opacity-50">{t("approveMoments")}</button>
          <button type="button" disabled={busy} onClick={() => void applyStatus([...selected], "hidden")} className="rounded-full border border-[var(--color-border)] px-3 py-1 font-mono text-xs text-amber-400 disabled:opacity-50">{t("hideMoments")}</button>
          <button type="button" disabled={busy} onClick={() => void remove([...selected])} className="rounded-full border border-red-900/60 px-3 py-1 font-mono text-xs text-red-400 disabled:opacity-50">{t("deleteMoments")}</button>
        </div>
      )}
      {moments.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t("noMomentsCollected")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moments.map((moment) => (
            <div key={moment.id} className={`relative rounded-xl ${moment.moderation_status === "hidden" ? "opacity-55" : ""}`}>
              <label className="absolute left-2 top-2 z-10 flex cursor-pointer items-center gap-1 rounded-full bg-black/70 px-2 py-1 font-mono text-[10px] text-white backdrop-blur">
                <input
                  type="checkbox"
                  checked={selected.has(moment.id)}
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(moment.id); else next.delete(moment.id);
                    return next;
                  })}
                />
                {t("selectMoment")}
              </label>
              {moment.moderation_status === "hidden" && <span className="absolute right-2 top-2 z-10 rounded-full bg-amber-950/90 px-2 py-1 font-mono text-[10px] text-amber-300">{t("hiddenMoment")}</span>}
              <MomentCard moment={moment} />
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => void applyStatus([moment.id], moment.moderation_status === "hidden" ? "approved" : "hidden")} className="font-mono text-[11px] text-[var(--color-accent)] disabled:opacity-50">
                  {moment.moderation_status === "hidden" ? t("restoreMoment") : t("hideMoment")}
                </button>
                <button type="button" disabled={busy} onClick={() => void remove([moment.id])} className="font-mono text-[11px] text-red-400 disabled:opacity-50">{t("deleteMoment")}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
