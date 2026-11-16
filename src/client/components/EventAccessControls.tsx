import { useState } from "react";
import type { EventData } from "../lib/types";
import { updateEventAccess } from "../lib/api";
import { useI18n } from "../lib/i18n";

export function EventAccessControls({ event, onUpdate }: { event: EventData; onUpdate: (event: EventData) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"public" | "private">(event.access_mode ?? "public");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  const isPinLengthValid = pin === "" || (pin.length >= 6 && pin.length <= 20);

  const save = async () => {
    if (!isPinLengthValid) return;
    setBusy(true);
    try {
      const result = await updateEventAccess(event.id, { mode, pin: pin || undefined });
      onUpdate(result.event);
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  const inviteUrl = event.invite_token
    ? `${window.location.origin}/e/${encodeURIComponent(event.slug)}?invite=${encodeURIComponent(event.invite_token)}`
    : "";

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <p className="font-mono text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t("eventPrivacy")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select value={mode} onChange={(event) => setMode(event.target.value as "public" | "private")} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm">
          <option value="public">{t("publicEvent")}</option>
          <option value="private">{t("privateEvent")}</option>
        </select>
        {mode === "private" && <input type="password" minLength={6} maxLength={20} value={pin} onChange={(event) => setPin(event.target.value)} placeholder={event.access_mode === "private" ? t("newPinOptional") : t("eventPin")} className="min-w-40 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm" />}
        <button type="button" disabled={busy || !isPinLengthValid} onClick={() => void save()} className="rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono text-xs text-[var(--color-accent)] disabled:opacity-50">{t("savePrivacy")}</button>
      </div>
      {mode === "private" && !isPinLengthValid && (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">{t("pinLengthHint")}</p>
      )}
      {mode === "private" && event.access_mode === "private" && pin && (
        <p className="mt-2 text-xs text-[var(--color-accent)]">{t("newPinRevokesAccess")}</p>
      )}
      {mode === "private" && inviteUrl && <button type="button" onClick={() => void navigator.clipboard.writeText(inviteUrl)} className="mt-2 font-mono text-xs text-[var(--color-accent)]">{t("copyPrivateInvite")}</button>}
    </section>
  );
}
