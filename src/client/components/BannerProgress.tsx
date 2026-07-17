import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";

// gpt-image-2 edits at banner size routinely take 30-50s (the worker times out
// at 90s). Without feedback the admin assumes the app froze, so we show a live
// elapsed timer plus a bar that eases toward — but never reaches — 100% until
// the real result lands. The bar is deliberately asymptotic: progress here is
// estimated, not measured, and a bar that sticks near the end reads as honest.
const EXPECTED_MS = 45_000;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function BannerProgress() {
  const { t } = useI18n();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let frameId: number;
    const tick = (now: number) => {
      setElapsed(now - start);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []);

  // Ease-out so the bar sprints early then crawls, capped at 95% — the final
  // 5% is reserved for actual completion, handled by the caller unmounting us.
  const ratio = Math.min(elapsed / EXPECTED_MS, 1);
  const eased = 1 - Math.pow(1 - ratio, 2);
  const percent = Math.min(95, Math.round(eased * 95));

  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-[var(--color-accent-dark)]">
          {t("generatingBanner")}
        </span>
        <span className="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-alt)]">
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{t("bannerProgressHint")}</span>
    </div>
  );
}
