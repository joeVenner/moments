import { useI18n } from "../lib/i18n";

export function EventPreview({
  title,
  type,
  hosts,
  coverUrl,
}: {
  title: string;
  type: string;
  hosts: string;
  coverUrl: string | null;
}) {
  const { t, eventTypeLabel } = useI18n();

  return (
    <div>
      <p className="font-mono text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t("livePreview")}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">{t("livePreviewSubtitle")}</p>

      <div className="mx-auto mt-3 max-w-[280px] overflow-hidden rounded-2xl border border-slate-200 bg-[var(--color-bg)] text-center shadow-sm">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={title.trim() || t("previewPlaceholderTitle")}
            className="h-28 w-full object-cover"
          />
        ) : (
          <div className="h-28 w-full bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-dark)]" />
        )}

        <div className="w-full min-w-0 p-4">
          {type && (
            <p className="truncate font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
              {eventTypeLabel(type)}
            </p>
          )}
          <h2 className="mt-1 truncate text-xl font-semibold text-slate-900">
            {title.trim() || t("previewPlaceholderTitle")}
          </h2>
          <p className="mt-1 truncate text-sm text-slate-600">
            {hosts.trim() || t("previewPlaceholderHosts")}
          </p>
        </div>
      </div>
    </div>
  );
}
