import logo from "../assets/logo.png";
import { useI18n } from "../lib/i18n";

export function Footer() {
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
      <div className="flex items-center gap-1.5">
        <img src={logo} alt="" className="h-5 w-5 shrink-0 opacity-70" />
        <span className="font-display text-sm font-semibold text-slate-400">Moments</span>
      </div>
      <p className="max-w-xs text-xs text-slate-400">{t("footerTagline")}</p>
      <p className="font-mono text-xs text-slate-400">© {year} Moments</p>
    </footer>
  );
}
