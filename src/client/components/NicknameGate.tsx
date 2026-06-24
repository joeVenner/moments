import { useState } from "react";
import type { EventData } from "../lib/types";

export function NicknameGate({
  event,
  onSubmit,
}: {
  event: EventData;
  onSubmit: (nickname: string) => void;
}) {
  const [name, setName] = useState("");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-[var(--color-bg)] px-6 text-center">
      {event.cover_image_url && (
        <img
          src={event.cover_image_url}
          alt={event.title}
          className="h-32 w-32 rounded-full border-4 border-white object-cover shadow-md"
        />
      )}
      <div>
        <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
          {event.type}
        </p>
        <h1 className="text-2xl font-semibold text-slate-900">{event.title}</h1>
        {event.main_characters && <p className="mt-1 text-sm text-slate-600">{event.main_characters}</p>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
        className="flex w-full max-w-xs flex-col gap-3"
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter your name to join"
          className="rounded-lg border border-slate-300 bg-white px-3 py-3 text-center text-base outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
        >
          Join the Feed
        </button>
      </form>
    </div>
  );
}
