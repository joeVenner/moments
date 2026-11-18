import { useState } from "react";
import type { EventData } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { prefersReducedMotion } from "../lib/motion";
import { AvatarPicker } from "./AvatarPicker";

/** Mirrors the worker's `MAX_NICKNAME_LENGTH` (guestIdentity.ts). */
const MAX_NICKNAME_LENGTH = 60;

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * First-visit nickname prompt, rendered as a modal overlay *on top of* the
 * event page (rather than replacing it). The hero/feed stay visible behind a
 * dimmed, blurred backdrop so the guest sees what they're joining. The modal
 * is non-dismissable — a nickname is required to participate.
 */
/** Why the join didn't go through; null when the guest is in. */
export type JoinProblem = "rate_limited" | "nickname_taken";

export function NicknameGate({
  event,
  onSubmit,
}: {
  event: EventData;
  onSubmit: (nickname: string, avatarSeed: string) => Promise<JoinProblem | null>;
}) {
  const { t, eventTypeLabel } = useI18n();
  const [name, setName] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [problem, setProblem] = useState<JoinProblem | null>(null);
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
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || isJoining) return;
            setIsJoining(true);
            setProblem(null);
            try {
              setProblem(await onSubmit(name.trim(), avatarSeed));
            } finally {
              // On success the gate unmounts and React drops this update.
              setIsJoining(false);
            }
          }}
          className="mt-5 flex w-full flex-col gap-3"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (problem === "nickname_taken") setProblem(null);
            }}
            placeholder={t("enterNameToJoin")}
            aria-label={t("enterNameToJoin")}
            maxLength={MAX_NICKNAME_LENGTH}
            readOnly={isJoining}
            aria-invalid={problem === "nickname_taken"}
            aria-describedby={problem ? "nickname-gate-problem" : undefined}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 text-center text-base outline-none focus:border-[var(--color-accent)]"
          />
          {problem && (
            <p id="nickname-gate-problem" role="alert" className="text-center text-sm text-[var(--color-accent)]">
              {t(problem === "rate_limited" ? "joinRateLimited" : "joinNicknameTaken")}
            </p>
          )}
          <button
            type="submit"
            data-spark
            disabled={!name.trim() || isJoining}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
          >
            {t("joinTheFeed")}
          </button>
        </form>
      </div>
    </div>
  );
}
