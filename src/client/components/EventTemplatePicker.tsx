import { EVENT_TEMPLATES, type EventTemplate } from "../lib/eventTemplates";
import { EventBannerScene } from "../lib/eventBanners";
import { useI18n } from "../lib/i18n";

export function EventTemplatePicker({ onSelect }: { onSelect: (template: EventTemplate) => void }) {
  const { t } = useI18n();
  return (
    <section className="mt-6">
      <div className="flex items-end justify-between gap-3">
        <div><h2 className="text-xl font-semibold">{t("startWithTemplate")}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("templateHint")}</p></div>
      </div>
      <div className="no-scrollbar mt-3 flex gap-3 overflow-x-auto pb-2">
        {EVENT_TEMPLATES.map((template) => (
          <button key={template.id} type="button" data-spark onClick={() => onSelect(template)} className="group relative h-28 w-40 shrink-0 overflow-hidden rounded-xl border border-[var(--color-border)] text-left transition hover:border-[var(--color-accent)]">
            <EventBannerScene type={template.type} className="absolute inset-0" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 to-transparent" />
            <span className="absolute inset-x-3 bottom-3 font-mono text-xs font-medium text-white">{t(template.labelKey)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
