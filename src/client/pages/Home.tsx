import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";

export default function Home() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] px-6 text-center">
      <h1 className="text-4xl font-semibold text-[var(--color-accent-dark)]">Moments</h1>
      <p className="max-w-sm text-sm text-slate-600">{t("appTagline")}</p>
      <Link
        to="/admin"
        className="mt-2 rounded-full bg-[var(--color-accent)] px-5 py-2 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
      >
        {t("openAdminPanel")}
      </Link>
    </div>
  );
}
