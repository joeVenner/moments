import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useI18n } from "../lib/i18n";

export function QRPanel({ slug, title }: { slug: string; title: string }) {
  const { t } = useI18n();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const guestUrl = `${window.location.origin}/e/${slug}`;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(guestUrl, {
      width: 320,
      margin: 2,
      color: { dark: "#C15F3C", light: "#FCFAF6" },
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [guestUrl]);

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
        <a
          href={dataUrl}
          download={`${slug}-qr.png`}
          className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-mono font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
        >
          {t("downloadQr")}
        </a>
      )}
    </div>
  );
}
