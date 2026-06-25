import { useI18n, type Lang } from "../lib/i18n";

const LANGS: Lang[] = ["en", "fr"];

export function LanguageSwitcher() {
  const { lang, setLang } = useI18n();

  return (
    <div
      style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      className="fixed right-3 z-40 flex gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)]/90 p-1 font-mono text-xs shadow-sm backdrop-blur"
    >
      {LANGS.map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`rounded-full px-2 py-1 transition ${
            lang === l
              ? "bg-[var(--color-accent)] text-white"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
