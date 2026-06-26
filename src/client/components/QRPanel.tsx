import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useQrDataUrl } from "../lib/useQrDataUrl";
import { QRFlyer, type FlyerStyle } from "./QRFlyer";

const STYLE_STORAGE_KEY = "moments:flyer-style";
const STYLE_ORDER: FlyerStyle[] = ["editorial", "poster", "dark"];

/** Tiny color swatch per style so the picker previews the vibe at a glance. */
const STYLE_SWATCH: Record<FlyerStyle, string> = {
  editorial: "bg-white border border-[#e7e3dc]",
  poster: "bg-[#d97757]",
  dark: "bg-[var(--color-bg)] border border-[var(--color-border)]",
};

function loadStoredStyle(): FlyerStyle {
  try {
    const v = localStorage.getItem(STYLE_STORAGE_KEY);
    if (v && (STYLE_ORDER as string[]).includes(v)) return v as FlyerStyle;
  } catch {
    // localStorage may be unavailable (private mode) — fall back to default.
  }
  return "editorial";
}

export function QRPanel({ slug, title }: { slug: string; title: string }) {
  const { t } = useI18n();
  const guestUrl = `${window.location.origin}/e/${slug}`;
  const dataUrl = useQrDataUrl(guestUrl);
  const [flyerStyle, setFlyerStyle] = useState<FlyerStyle>(loadStoredStyle);

  // Persist the admin's chosen flyer style so it survives across event edits.
  useEffect(() => {
    try {
      localStorage.setItem(STYLE_STORAGE_KEY, flyerStyle);
    } catch {
      /* ignore — non-blocking nicety */
    }
  }, [flyerStyle]);

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-5">
      {dataUrl ? (
        <img
          data-testid="qr-code-image"
          src={dataUrl}
          alt={`QR — ${title}`}
          className="h-40 w-40 animate-[fade-in_400ms_ease-out] rounded-lg"
        />
      ) : (
        <div className="h-40 w-40 animate-pulse rounded-lg bg-[var(--color-border)]" />
      )}
      <code className="text-xs text-[var(--color-text-muted)] break-all">{guestUrl}</code>

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

      {/* Style picker — three swatch buttons. Prints whichever is selected. */}
      {dataUrl && (
        <div className="flex w-80 flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
            {t("flyerStyleLabel")}
          </span>
          <div className="flex gap-2">
            {STYLE_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFlyerStyle(s)}
                aria-pressed={flyerStyle === s}
                className={`flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] transition ${
                  flyerStyle === s
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text)]"
                    : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <span className={`h-3.5 w-3.5 rounded-sm ${STYLE_SWATCH[s]}`} />
                {styleLabel(t, s)}
              </button>
            ))}
          </div>
        </div>
      )}

      {dataUrl && (
        <QRFlyer title={title} guestUrl={guestUrl} dataUrl={dataUrl} style={flyerStyle} />
      )}
    </div>
  );
}

function styleLabel(t: ReturnType<typeof useI18n>["t"], s: FlyerStyle): string {
  switch (s) {
    case "editorial":
      return t("flyerStyleEditorial");
    case "poster":
      return t("flyerStylePoster");
    case "dark":
      return t("flyerStyleDark");
  }
}