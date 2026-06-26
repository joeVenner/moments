import { BrandMark } from "./BrandMark";
import { useI18n } from "../lib/i18n";

export type FlyerStyle = "editorial" | "poster" | "dark";

/**
 * Printable, brand-designed flyer/card for an event. Three selectable styles —
 * Editorial (light wedding-invitation), Poster (bold accent band), Dark-native
 * (charcoal, matches the app). Each is pure CSS (no baked asset backgrounds):
 * the QR code is rendered on a light tile in every style so it stays scannable
 * regardless of the surrounding surface, and the mark uses the inline BrandMark
 * (transparent) so it reads on any background.
 *
 * The outer node always carries `qr-flyer` (the print-isolation hook in
 * index.css) plus a per-style modifier (`qr-flyer--editorial`, etc.) so the print
 * stylesheet can keep each variant's background/ink. Rendered as a live preview
 * inside QRPanel (sharing its QR data URL) and, when printing, isolated as the
 * only visible element on the page.
 */
export function QRFlyer({
  title,
  guestUrl,
  dataUrl,
  style = "editorial",
}: {
  title: string;
  guestUrl: string;
  dataUrl: string;
  style?: FlyerStyle;
}) {
  const { t } = useI18n();

  return (
    <div className={`qr-flyer qr-flyer--${style} w-80`} data-testid="qr-flyer">
      {style === "editorial" && <EditorialFlyer title={title} guestUrl={guestUrl} dataUrl={dataUrl} cta={t} />}
      {style === "poster" && <PosterFlyer title={title} guestUrl={guestUrl} dataUrl={dataUrl} cta={t} />}
      {style === "dark" && <DarkFlyer title={title} guestUrl={guestUrl} dataUrl={dataUrl} cta={t} />}
    </div>
  );
}

type T = ReturnType<typeof useI18n>["t"];
interface FlyerProps {
  title: string;
  guestUrl: string;
  dataUrl: string;
  cta: T;
}

/* Editorial — light paper, Fraunces serif headline, thin accent rule, centered
   QR. Wedding-invitation feel. */
function EditorialFlyer({ title, guestUrl, dataUrl, cta }: FlyerProps) {
  return (
    <div className="relative flex aspect-[2/3] w-80 flex-col items-center overflow-hidden rounded-2xl border border-[#e7e3dc] bg-white px-8 py-10 text-center text-[#18181b]">
      {/* Fixed dark "paper inks" (not theme tokens): this flyer is printed on
          white paper, so its text stays dark regardless of the dark UI theme. */}
      <div className="flex items-center gap-1.5 text-[#c15f3c]">
        <BrandMark className="h-6 w-6" />
        <span className="font-display text-lg font-semibold">Moments</span>
      </div>
      <div className="mt-4 h-px w-12 bg-[#d97757]" />

      <h2 className="mt-5 font-display text-[1.7rem] font-semibold leading-tight text-[#c15f3c]">
        {cta("flyerCta")}
      </h2>
      <p className="mt-1.5 text-sm text-[#3f3f46]">{cta("flyerCtaSubline")}</p>

      <img
        src={dataUrl}
        alt={`QR — ${title}`}
        className="mt-6 h-36 w-36 rounded-lg border border-[#e7e3dc] bg-white p-1.5 shadow-sm"
        data-testid="qr-flyer-image"
      />

      <p className="mt-5 text-xs leading-relaxed text-[#52525b]">{cta("flyerInstruction")}</p>

      <div className="mt-auto pt-5">
        <p className="truncate font-display text-base font-semibold text-[#18181b]">{title}</p>
        <code className="mt-1 block text-[10px] text-[#71717a] break-all">{guestUrl}</code>
      </div>
    </div>
  );
}

/* Poster — bold accent header band, oversized CTA, QR tile beside mono "SCAN &
   SHARE" copy. Eye-catching. */
function PosterFlyer({ title, guestUrl, dataUrl, cta }: FlyerProps) {
  return (
    <div className="relative flex aspect-[2/3] w-80 flex-col overflow-hidden rounded-2xl border-2 border-[#c15f3c] bg-white text-[#18181b]">
      {/* Accent header band — kept when printed via print-color-adjust: exact. */}
      <div className="flex items-center justify-between bg-[#d97757] px-5 py-3 text-white">
        <div className="flex items-center gap-1.5">
          {/* White aperture on the accent band (BrandMark is accent-on-dark, so
              inline a white variant here rather than fighting SVG attributes). */}
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="white" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="2.8" fill="white" />
          </svg>
          <span className="font-mono text-sm font-bold uppercase tracking-widest">Moments</span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-80">Live photo wall</span>
      </div>

      <div className="flex flex-1 flex-col px-6 py-6">
        <h2 className="font-display text-[2.1rem] font-extrabold leading-[1.05] text-[#18181b]">
          {cta("flyerCta").toUpperCase()}
        </h2>
        <p className="mt-2 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-[#c15f3c]">
          {cta("flyerCtaSubline")}
        </p>

        <div className="mt-6 flex items-center gap-4">
          <img
            src={dataUrl}
            alt={`QR — ${title}`}
            className="h-32 w-32 shrink-0 rounded-lg border-2 border-[#18181b] bg-white p-1.5"
            data-testid="qr-flyer-image"
          />
          <div className="font-mono text-sm font-bold uppercase leading-tight text-[#18181b]">
            Scan
            <br />
            &amp; share
            <div className="mt-2 h-1 w-10 bg-[#d97757]" />
          </div>
        </div>

        <p className="mt-5 text-xs leading-relaxed text-[#3f3f46]">{cta("flyerInstruction")}</p>

        <div className="mt-auto pt-4">
          <p className="truncate font-display text-lg font-bold text-[#c15f3c]">{title}</p>
          <code className="mt-1 block text-[10px] text-[#71717a] break-all">{guestUrl}</code>
        </div>
      </div>
    </div>
  );
}

/* Dark-native — charcoal surface, accent + near-white type, hairline border, QR
   on an inset light tile. Matches the app. */
function DarkFlyer({ title, guestUrl, dataUrl, cta }: FlyerProps) {
  return (
    <div className="relative flex aspect-[2/3] w-80 flex-col items-center overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-8 py-10 text-center">
      <div className="flex items-center gap-1.5">
        <BrandMark className="h-6 w-6" />
        <span className="font-display text-lg font-semibold text-[var(--color-accent)]">Moments</span>
      </div>
      <div className="mt-4 h-px w-12 bg-[var(--color-accent)]" />

      <h2 className="mt-5 font-display text-[1.7rem] font-semibold leading-tight text-[var(--color-text)]">
        {cta("flyerCta")}
      </h2>
      <p className="mt-1.5 text-sm text-[var(--color-text-muted)]">{cta("flyerCtaSubline")}</p>

      {/* QR on an inset light tile so the cream-background QR stays scannable
          against the charcoal surface. */}
      <div className="mt-6 rounded-lg bg-white p-2 shadow-lg">
        <img
          src={dataUrl}
          alt={`QR — ${title}`}
          className="h-32 w-32"
          data-testid="qr-flyer-image"
        />
      </div>

      <p className="mt-5 text-xs leading-relaxed text-[var(--color-text-muted)]">{cta("flyerInstruction")}</p>

      <div className="mt-auto pt-5">
        <p className="truncate font-display text-base font-semibold text-[var(--color-text)]">{title}</p>
        <code className="mt-1 block font-mono text-[10px] text-[var(--color-text-muted)] break-all">{guestUrl}</code>
      </div>
    </div>
  );
}