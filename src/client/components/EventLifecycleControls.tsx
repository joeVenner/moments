import { useState } from "react";
import type { EventData } from "../lib/types";
import { updateEventLifecycle } from "../lib/api";
import { useI18n } from "../lib/i18n";

export function EventLifecycleControls({
  event,
  onUpdate,
}: {
  event: EventData;
  onUpdate: (event: EventData) => void;
}) {
  const { t } = useI18n();
  const [date, setDate] = useState(event.expires_at?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await updateEventLifecycle(event.id, {
        expires_at: date ? `${date}T23:59:59.000Z` : null,
      });
      onUpdate(result.event);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!window.confirm(t("confirmArchiveEvent"))) return;
    setBusy(true);
    try {
      const result = await updateEventLifecycle(event.id, { archive_now: true });
      onUpdate(result.event);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <p className="font-mono text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {t("eventRetention")}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          {t("expiresOn")}
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="min-w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-[var(--color-text)]" />
        </label>
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono text-xs text-[var(--color-accent)] disabled:opacity-50">{t("saveRetention")}</button>
        <button type="button" disabled={busy} onClick={() => void archive()} className="rounded-lg border border-red-900/60 px-3 py-2 font-mono text-xs text-red-400 disabled:opacity-50">{t("archiveNow")}</button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{t("retentionHint")}</p>
    </section>
  );
}
