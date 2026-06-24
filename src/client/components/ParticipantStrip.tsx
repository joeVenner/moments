import { useEffect, useState } from "react";
import { createAvatar } from "@dicebear/core";
import { funEmoji } from "@dicebear/collection";
import { useI18n } from "../lib/i18n";

interface Participant {
  id: string;
  nickname: string;
  avatar_seed: string | null;
  joined_at: string;
}

const PLACEHOLDER_COLORS = [
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#a3e635",
  "#34d399",
  "#22d3ee",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
];

function placeholderColor(nickname: string): string {
  let hash = 0;
  for (let i = 0; i < nickname.length; i++) {
    hash = (hash * 31 + nickname.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % PLACEHOLDER_COLORS.length;
  return PLACEHOLDER_COLORS[index];
}

function ParticipantAvatar({ participant }: { participant: Participant }) {
  if (!participant.avatar_seed) {
    return (
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full text-base font-semibold text-white"
        style={{ backgroundColor: placeholderColor(participant.nickname) }}
      >
        {participant.nickname.charAt(0).toUpperCase()}
      </div>
    );
  }

  const svg = createAvatar(funEmoji, { seed: participant.avatar_seed }).toString();
  return (
    <div
      className="h-12 w-12 overflow-hidden rounded-full border-2 border-white shadow-sm [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function ParticipantStrip({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [participants, setParticipants] = useState<Participant[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/events/${slug}/participants`);
        if (!res.ok) throw new Error(`Request failed with ${res.status}`);
        const data = (await res.json()) as { participants: Participant[] };
        if (!cancelled) setParticipants(data.participants);
      } catch {
        if (!cancelled) setParticipants(null);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!participants || participants.length === 0) return null;

  return (
    <div>
      <p className="mb-2 font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
        {t("participantsJoined", { count: participants.length })}
      </p>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {participants.map((participant) => (
          <div key={participant.id} className="flex flex-shrink-0 flex-col items-center gap-1">
            <ParticipantAvatar participant={participant} />
            <span className="max-w-[60px] truncate text-xs text-slate-600">
              {participant.nickname}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
