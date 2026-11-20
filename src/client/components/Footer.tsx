import { BrandMark } from "./BrandMark";
import { useI18n } from "../lib/i18n";

export function Footer() {
  const { t, lang } = useI18n();
  // Static pages in public/, outside the SPA: plain links, not router links.
  const legalBase = lang === "fr" ? "/fr" : "";
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto flex w-full max-w-md flex-col items-center gap-1.5 px-6 py-8 text-center">
      <div className="flex items-center gap-1.5">
        <BrandMark className="h-5 w-5 shrink-0 opacity-80" />
        <span className="font-display text-sm font-semibold text-[var(--color-text-muted)]">Moments</span>
      </div>
      <p className="max-w-xs text-xs text-[var(--color-text-muted)]">{t("footerTagline")}</p>
      <nav aria-label="Legal" className="flex gap-4 text-xs">
        <a href={`${legalBase}/privacy`} className="text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline">
          {t("footerPrivacy")}
        </a>
        <a href={`${legalBase}/terms`} className="text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline">
          {t("footerTerms")}
        </a>
      </nav>
      <p className="font-mono text-xs text-[var(--color-text-muted)]">© {year} Moments</p>
    </footer>
  );
}
