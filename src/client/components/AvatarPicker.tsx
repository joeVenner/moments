import { useMemo } from "react";
import { useI18n } from "../lib/i18n";
import { renderAvatarSvg } from "../lib/avatar";

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

// The curated eyes/mouth allowlists live in `lib/avatar.ts` and are shared with
// every other place a seed is rendered (participant strip, etc.) — see the
// comment there for why the same options must be applied everywhere.

export function AvatarPicker({
  seed,
  onChange,
}: {
  seed: string;
  onChange: (seed: string) => void;
}) {
  const { t } = useI18n();

  const svg = useMemo(() => renderAvatarSvg(seed), [seed]);

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
        {t("chooseAvatar")}
      </p>
      <div
        key={seed}
        className="animate-pop-punch flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-4 border-white shadow-md [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <button
        type="button"
        onClick={() => onChange(randomSeed())}
        className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
      >
        {t("shuffleAvatar")}
      </button>
    </div>
  );
}
