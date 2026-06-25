import { useState } from "react";
import type { EventData } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { AvatarPicker } from "./AvatarPicker";

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

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

  return (
    <div className="flex min-h-screen flex-col items-center bg-[var(--color-bg)] text-center">
      {event.cover_image_url ? (
        <img
          src={event.cover_image_url}
          alt={event.title}
          className="h-48 w-full object-cover sm:h-64"
        />
      ) : (
        <div className="h-48 w-full bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-dark)] sm:h-64" />
      )}

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-5 px-6 py-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
            {eventTypeLabel(event.type)}
          </p>
          <h1 className="text-2xl font-semibold text-slate-900">{event.title}</h1>
          {event.main_characters && <p className="mt-1 text-sm text-slate-600">{event.main_characters}</p>}
        </div>

        <AvatarPicker seed={avatarSeed} onChange={setAvatarSeed} />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSubmit(name.trim(), avatarSeed);
          }}
          className="flex w-full max-w-xs flex-col gap-3"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("enterNameToJoin")}
            className="rounded-lg border border-slate-300 bg-white px-3 py-3 text-center text-base outline-none focus:border-[var(--color-accent)]"
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
