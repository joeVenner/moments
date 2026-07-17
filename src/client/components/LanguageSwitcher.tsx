import { useLocation } from "react-router-dom";
import { useI18n, type Lang } from "../lib/i18n";

const LANGS: Lang[] = ["en", "fr"];

type Variant = "floating" | "inline";

export function LanguageSwitcher({ variant = "floating" }: { variant?: Variant }) {
  const { lang, setLang } = useI18n();

  const buttons = (
    <>
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
    </>
  );

  // Inline: embeddable in a page header (e.g. the admin form). No fixed
  // positioning — just the pill group.
  if (variant === "inline") {
    return (
      <div className="flex shrink-0 gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-1 font-mono text-xs">
        {buttons}
      </div>
    );
  }

  // Floating: the global top-right pill. Hide it on /admin (duplicated by the
  // inline switcher in the admin header) and on /e/:slug (no language control
  // on the guest event page, per Yassir).
  const { pathname } = useLocation();
  if (pathname.startsWith("/admin") || pathname.startsWith("/e/")) return null;

  return (
    <div
      style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      className="fixed right-3 z-40 flex gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)]/90 p-1 font-mono text-xs shadow-sm backdrop-blur"
    >
      {buttons}
    </div>
  );
}