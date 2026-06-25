import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { useI18n, randomQuote } from "../lib/i18n";
import emptyLeaderboard from "../assets/empty-leaderboard.png";
import winnerTrophy from "../assets/winner-trophy.png";

interface LeaderboardEntry {
  uploader_name: string;
  total_points: number;
  moment_count: number;
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function Leaderboard({ slug }: { slug: string }) {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [quote] = useState(() => randomQuote(lang));
  const confettiFiredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError(false);
      try {
        const res = await fetch(`/api/events/${slug}/leaderboard`);
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const data: { leaderboard: LeaderboardEntry[] } = await res.json();
        if (cancelled) return;
        setEntries(data.leaderboard);

        if (
          !confettiFiredRef.current &&
          data.leaderboard.length > 0 &&
          data.leaderboard[0].total_points > 0
        ) {
          confettiFiredRef.current = true;
          confetti({
            particleCount: 120,
            spread: 70,
            origin: { y: 0.6 },
          });
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        {t("serverUnreachable")}
      </div>
    );
  }

  if (entries === null) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-xl border border-slate-200 bg-white p-4"
          >
            <div className="h-3 w-1/3 rounded bg-slate-200" />
            <div className="mt-2 h-3 w-1/4 rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center">
        <img
          src={emptyLeaderboard}
          alt=""
          className="mx-auto h-24 w-24"
        />
        <p className="mt-2 text-sm text-slate-500">{t("noLeaderboardYet")}</p>
        <p className="mt-3 text-xs italic text-slate-400">{quote}</p>
      </div>
    );
  }

  // Top 3 podium slots only count people who've actually uploaded something.
  // Zero-point joiners sink to the plain ranked list below, never onto the podium.
  const podium = entries.filter((e) => e.moment_count > 0).slice(0, 3);
  const podiumNames = new Set(podium.map((e) => e.uploader_name));
  const rest = entries
    .map((e, idx) => ({ ...e, rank: idx + 1 }))
    .filter((e) => !podiumNames.has(e.uploader_name));

  const winner = entries[0];
  const showWinnerBanner = winner.total_points > 0;

  // Podium order for display: 2nd, 1st, 3rd (classic podium silhouette).
  const podiumDisplayOrder = [podium[1], podium[0], podium[2]];
  const heightClass = ["h-20", "h-28", "h-16"]; // matches display order: 2nd, 1st, 3rd

  return (
    <div className="space-y-4">
      <h2 className="font-serif text-lg text-slate-900">{t("topPhotographers")}</h2>

      {showWinnerBanner && (
        <div
          className="flex items-center justify-center gap-2 rounded-xl border p-3 text-center text-sm font-medium"
          style={{
            borderColor: "var(--color-accent)",
            backgroundColor: "var(--color-bg-alt)",
            color: "var(--color-accent-dark)",
          }}
        >
          <img src={winnerTrophy} alt="" className="h-8 w-8 shrink-0" />
          {t("winnerAnnouncement", { name: winner.uploader_name })}
        </div>
      )}

      {podium.length > 0 && (
        <div className="flex items-end justify-center gap-2 px-1">
          {podiumDisplayOrder.map((entry, i) => {
            if (!entry) return <div key={i} className="w-[100px]" />;
            const isFirst = entry === podium[0];
            return (
              <div
                key={entry.uploader_name}
                className="flex w-[100px] flex-col items-center"
              >
                <span className="text-2xl leading-none">
                  {MEDALS[podium.indexOf(entry)]}
                </span>
                <span
                  className="mt-1 max-w-[80px] truncate text-center text-xs font-medium text-slate-800"
                  title={entry.uploader_name}
                >
                  {entry.uploader_name}
                </span>
                <span className="font-mono text-[11px] text-slate-500">
                  {entry.total_points} {t("ptsLabel")}
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  {t("momentsLabel", { count: entry.moment_count })}
                </span>
                <div
                  className={`mt-2 flex w-full items-end justify-center rounded-t-lg ${heightClass[i]} ${
                    isFirst ? "shadow-[0_0_12px_rgba(217,119,87,0.6)]" : ""
                  }`}
                  style={{
                    backgroundColor: isFirst
                      ? "var(--color-accent)"
                      : "var(--color-bg-alt)",
                    border: isFirst ? "2px solid var(--color-accent-dark)" : "1px solid #e2e8f0",
                  }}
                >
                  <span
                    className={`pb-1 font-mono text-xs font-bold ${
                      isFirst ? "text-white" : "text-slate-500"
                    }`}
                  >
                    #{entries.indexOf(entry) + 1}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-center text-xs italic text-slate-400">{quote}</p>

      {rest.length > 0 && (
        <div className="space-y-2">
          {rest.map((entry) => (
            <div
              key={entry.uploader_name}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-xs text-slate-400">#{entry.rank}</span>
                <span className="max-w-[140px] truncate text-sm text-slate-800">
                  {entry.uploader_name}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-slate-500">
                <span>{t("momentsLabel", { count: entry.moment_count })}</span>
                <span className="font-semibold text-slate-700">
                  {entry.total_points} {t("ptsLabel")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
