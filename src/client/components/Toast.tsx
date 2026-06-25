import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { safeConfetti } from "../lib/motion";

export function PointsToast({ points, onDone }: { points: number; onDone: () => void }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    safeConfetti({
      particleCount: 70,
      spread: 60,
      origin: { y: 0.6 },
    });

    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => setVisible(false), 1800);
    const remove = setTimeout(onDone, 2200);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
      clearTimeout(remove);
    };
  }, [onDone]);

  return (
    <div
      data-testid="points-toast"
      style={{ top: "calc(1.5rem + env(safe-area-inset-top))" }}
      className={`fixed left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--color-accent-dark)] px-5 py-2.5 text-sm font-mono font-medium text-white shadow-lg transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
      }`}
    >
      {t("pointsAdded", { points })}
    </div>
  );
}
