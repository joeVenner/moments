import { useState } from "react";
import { unlockEvent } from "../lib/api";
import { useI18n } from "../lib/i18n";

export function EventAccessGate({ slug, onUnlocked }: { slug: string; onUnlocked: () => void }) {
  const { t } = useI18n();
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!pin.trim()) return;
          setBusy(true);
          setError(false);
          void unlockEvent(slug, { pin: pin.trim() })
            .then(onUnlocked)
            .catch(() => setError(true))
            .finally(() => setBusy(false));
        }}
        className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-6 text-center shadow-2xl"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] text-xl text-[var(--color-accent)]">⌁</div>
        <h1 className="mt-4 text-2xl font-semibold">{t("privateEvent")}</h1>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("privateEventHint")}</p>
        <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} placeholder={t("eventPin")} className="mt-5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 text-center text-lg tracking-[0.3em] outline-none focus:border-[var(--color-accent)]" />
        {error && <p className="mt-2 text-sm text-red-400">{t("incorrectEventPin")}</p>}
        <button type="submit" data-spark disabled={busy || !pin.trim()} className="mt-3 w-full rounded-lg bg-[var(--color-accent)] px-4 py-3 font-mono text-sm text-white disabled:opacity-50">{busy ? t("unlockingEvent") : t("unlockEvent")}</button>
      </form>
    </main>
  );
}
