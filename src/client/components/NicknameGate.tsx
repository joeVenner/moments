import { useState } from "react";
import type { EventData } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { prefersReducedMotion } from "../lib/motion";
import { AvatarPicker } from "./AvatarPicker";

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * First-visit nickname prompt, rendered as a modal overlay *on top of* the
 * event page (rather than replacing it). The hero/feed stay visible behind a
 * dimmed, blurred backdrop so the guest sees what they're joining. The modal
 * is non-dismissable — a nickname is required to participate.
 */
export function NicknameGate({
  event,
  onSubmit,
}: {
  event: EventData;
  onSubmit: (nickname: string, avatarSeed: string) => void;
}) {
  const { t, eventTypeLabel } = useI18n();
  const [name, setName] = useState("");
  const [avatarSeed, setAvatarSeed] = useState(randomSeed);
  const reduced = prefersReducedMotion();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]/80 p-4 backdrop-blur-sm animate-[fade-in_200ms_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nickname-gate-title"
    >
      <div
        className={`w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-6 shadow-2xl ${
          reduced ? "" : "animate-pop-in"
        }`}
      >
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--color-accent)]">
          {eventTypeLabel(event.type)}
        </p>
        <h2 id="nickname-gate-title" className="mt-1.5 text-2xl font-semibold text-[var(--color-text)]">
          {event.title}
        </h2>
        {event.main_characters && (
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{event.main_characters}</p>
        )}

        <div className="mt-5 flex justify-center">
          <AvatarPicker seed={avatarSeed} onChange={setAvatarSeed} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSubmit(name.trim(), avatarSeed);
          }}
          className="mt-5 flex w-full flex-col gap-3"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("enterNameToJoin")}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 text-center text-base outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
          >
            {t("joinTheFeed")}
          </button>
        </form>
      </div>
    </div>
  );
}