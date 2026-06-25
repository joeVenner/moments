import { useI18n } from "../lib/i18n";
import { useQrDataUrl } from "../lib/useQrDataUrl";
import { QRFlyer } from "./QRFlyer";

export function QRPanel({ slug, title }: { slug: string; title: string }) {
  const { t } = useI18n();
  const guestUrl = `${window.location.origin}/e/${slug}`;
  const dataUrl = useQrDataUrl(guestUrl);

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-[var(--color-bg-alt)] p-5">
      {dataUrl ? (
        <img
          data-testid="qr-code-image"
          src={dataUrl}
          alt={`QR — ${title}`}
          className="h-40 w-40 animate-[fade-in_400ms_ease-out] rounded-lg"
        />
      ) : (
        <div className="h-40 w-40 animate-pulse rounded-lg bg-slate-200" />
      )}
      <code className="text-xs text-slate-500 break-all">{guestUrl}</code>
      {dataUrl && (
        <div className="flex items-center gap-2">
          <a
            href={dataUrl}
            download={`${slug}-qr.png`}
            className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-mono font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
          >
            {t("downloadQr")}
          </a>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-full border border-[var(--color-accent)] px-4 py-1.5 text-xs font-mono font-medium text-[var(--color-accent-dark)] transition hover:bg-[var(--color-accent)]/10"
          >
            {t("printFlyer")}
          </button>
        </div>
      )}
      {dataUrl && <QRFlyer title={title} guestUrl={guestUrl} dataUrl={dataUrl} />}
    </div>
  );
}
