import { BrandMark } from "./BrandMark";
import { useI18n } from "../lib/i18n";
import flyerLeaves from "../assets/flyer/flyer-leaves.jpg";
import flyerCelebration from "../assets/flyer/flyer-celebration.jpg";

export type FlyerStyle = "editorial" | "poster" | "dark" | "leaves" | "celebration";

/**
 * Printable, brand-designed flyer/card for an event. Five selectable styles —
 * three simple (Editorial light paper, Poster bold accent band, Dark-native
 * charcoal) and two graphic-rich: Leaves (a decorative botanical frame with
 * QR + text composited in its center, restored from the original flyer art)
 * and Celebration (an OpenAI-generated scene of guests capturing the moment,
 * full-bleed with a dark scrim). Each style renders the QR on a light inset
 * tile so it stays scannable regardless of the surrounding surface, and the
 * mark uses the inline BrandMark (transparent) so it reads on any surface.
 *
 * The card has no fixed aspect ratio — it uses a min-height and lets content
 * define the height so nothing is ever clipped at the bottom (the previous
 * fixed 2:3 aspect with overflow-hidden cropped long titles). The outer node
 * always carries `qr-flyer` (the print-isolation hook in index.css) plus a
 * per-style modifier (`qr-flyer--editorial`, etc.) so the print stylesheet can
 * keep each variant's background/ink. Rendered as a live preview inside
 * QRPanel (sharing its QR data URL) and, when printing, isolated as the only
 * visible element on the page.
 *
 * Per Yassir: no website URL is printed on the flyer — the QR code is the only
 * way to reach the event.
 */
export function QRFlyer({
  title,
  dataUrl,
  style = "editorial",
}: {
  title: string;
  dataUrl: string;
  style?: FlyerStyle;
}) {
  const { t } = useI18n();
  const props = { title, dataUrl, cta: t };

  return (
    <div className={`qr-flyer qr-flyer--${style} w-80`} data-testid="qr-flyer">
      {style === "editorial" && <EditorialFlyer {...props} />}
      {style === "poster" && <PosterFlyer {...props} />}
      {style === "dark" && <DarkFlyer {...props} />}
      {style === "leaves" && <LeavesFlyer {...props} art={flyerLeaves} />}
      {style === "celebration" && <CelebrationFlyer {...props} art={flyerCelebration} />}
    </div>
  );
}

type T = ReturnType<typeof useI18n>["t"];
interface FlyerProps {
  title: string;
  dataUrl: string;
  cta: T;
}

/* Editorial — light paper, Fraunces serif headline, thin accent rule, centered
   QR. Wedding-invitation feel. */
function EditorialFlyer({ title, dataUrl, cta }: FlyerProps) {
  return (
    <div className="relative flex min-h-[480px] w-80 flex-col items-center overflow-hidden rounded-2xl border border-[#e7e3dc] bg-white px-8 py-10 text-center text-[#18181b]">
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

      <p className="mt-auto pt-6 font-display text-base font-semibold text-[#18181b]">{title}</p>
    </div>
  );
}

/* Poster — bold accent header band, oversized CTA, QR tile beside mono "SCAN &
   SHARE" copy. Eye-catching. */
function PosterFlyer({ title, dataUrl, cta }: FlyerProps) {
  return (
    <div className="relative flex min-h-[480px] w-80 flex-col overflow-hidden rounded-2xl border-2 border-[#c15f3c] bg-white text-[#18181b]">
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

        <p className="mt-auto pt-5 font-display text-lg font-bold text-[#c15f3c]">{title}</p>
      </div>
    </div>
  );
}

/* Dark-native — charcoal surface, accent + near-white type, hairline border, QR
   on an inset light tile. Matches the app. */
function DarkFlyer({ title, dataUrl, cta }: FlyerProps) {
  return (
    <div className="relative flex min-h-[480px] w-80 flex-col items-center overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-8 py-10 text-center">
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

      <p className="mt-auto pt-6 font-display text-base font-semibold text-[var(--color-text)]">{title}</p>
    </div>
  );
}

/* Leaves — graphic-rich style built on the decorative botanical frame restored
   from the original flyer art (flyer-leaves.jpg). Unlike the photographic
   Celebration style, this is a *frame*: the image carries a light center meant
   for compositing, so there's no dark scrim — text uses fixed dark "paper inks"
   (like Editorial/Poster) so it reads on the frame's light center, and the QR
   sits on a subtle white tile. This is the "tree leaves" look Yassir asked to
   bring back. */
function LeavesFlyer({ title, dataUrl, cta, art }: FlyerProps & { art: string }) {
  return (
    <div className="relative flex min-h-[480px] w-80 flex-col items-center overflow-hidden rounded-2xl text-center text-[#18181b]">
      <img
        src={art}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover"
      />

      <div className="relative z-10 flex w-full flex-col items-center px-8 py-10">
        <div className="flex items-center gap-1.5 text-[#c15f3c]">
          <BrandMark className="h-6 w-6" />
          <span className="font-display text-lg font-semibold">Moments</span>
        </div>

        <h2 className="mt-6 font-display text-[1.7rem] font-semibold leading-tight text-[#c15f3c]">
          {cta("flyerCta")}
        </h2>
        <p className="mt-1.5 text-sm text-[#3f3f46]">{cta("flyerCtaSubline")}</p>

        <div className="mt-6 rounded-lg bg-white/95 p-1.5 shadow-md ring-1 ring-[#e7e3dc]">
          <img
            src={dataUrl}
            alt={`QR — ${title}`}
            className="h-36 w-36"
            data-testid="qr-flyer-image"
          />
        </div>

        <p className="mt-5 text-xs leading-relaxed text-[#52525b]">{cta("flyerInstruction")}</p>

        <p className="mt-auto pt-6 font-display text-base font-semibold text-[#18181b]">{title}</p>
      </div>
    </div>
  );
}

/* Celebration — graphic-rich style backed by an OpenAI-generated scene of
   guests raising phones to capture the moment. Full-bleed photographic art, so
   a dark scrim guarantees text legibility and the QR sits on a white inset tile
   (the one scannable surface over the art). Light ink throughout. */
function CelebrationFlyer({ title, dataUrl, cta, art }: FlyerProps & { art: string }) {
  return (
    <div className="relative flex min-h-[480px] w-80 flex-col items-center overflow-hidden rounded-2xl border border-[var(--color-border)] text-center text-white">
      <img
        src={art}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* Scrim: stronger at top (over the busiest art) and bottom (behind the
          title), lighter through the middle so the art still reads. */}
      <div
        className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.62)_0%,rgba(0,0,0,0.32)_38%,rgba(0,0,0,0.45)_70%,rgba(0,0,0,0.78)_100%)]"
      />

      <div className="relative z-10 flex w-full flex-col items-center px-8 py-10">
        <div className="flex items-center gap-1.5 text-[#d97757]">
          <BrandMark className="h-6 w-6" />
          <span className="font-display text-lg font-semibold">Moments</span>
        </div>

        <h2 className="mt-6 font-display text-[1.7rem] font-semibold leading-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
          {cta("flyerCta")}
        </h2>
        <p className="mt-1.5 text-sm text-white/85">{cta("flyerCtaSubline")}</p>

        {/* QR on a white inset tile — the one scannable surface over the art. */}
        <div className="mt-6 rounded-xl bg-white p-2.5 shadow-xl">
          <img
            src={dataUrl}
            alt={`QR — ${title}`}
            className="h-36 w-36"
            data-testid="qr-flyer-image"
          />
        </div>

        <p className="mt-5 text-xs leading-relaxed text-white/80">{cta("flyerInstruction")}</p>

        <p className="mt-auto pt-6 font-display text-base font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
          {title}
        </p>
      </div>
    </div>
  );
}