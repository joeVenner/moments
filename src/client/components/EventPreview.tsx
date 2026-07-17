import { useI18n } from "../lib/i18n";
import { EventBannerScene } from "../lib/eventBanners";

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
      <p className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        {t("livePreview")}
      </p>
      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{t("livePreviewSubtitle")}</p>

      <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] text-center shadow-sm">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={title.trim() || t("previewPlaceholderTitle")}
            className="h-28 w-full object-cover"
          />
        ) : (
          <EventBannerScene type={type} className="h-28 w-full" />
        )}

        <div className="w-full min-w-0 p-4">
          {type && (
            <p className="truncate font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
              {eventTypeLabel(type)}
            </p>
          )}
          <h2 className="mt-1 truncate text-xl font-semibold text-[var(--color-text)]">
            {title.trim() || t("previewPlaceholderTitle")}
          </h2>
          <p className="mt-1 truncate text-sm text-[var(--color-text-muted)]">
            {hosts.trim() || t("previewPlaceholderHosts")}
          </p>
        </div>
      </div>
    </div>
  );
}
