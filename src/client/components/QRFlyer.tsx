import flyerFrame from "../assets/flyer-frame.png";
import logo from "../assets/logo.png";
import { useI18n } from "../lib/i18n";

/**
 * Printable, brand-designed flyer/card for an event: a decorative AI-generated
 * frame (no baked-in text or QR — see flyer-frame.png) with the real QR code
 * and crisp HTML text composited on top via CSS. Rendered as a live preview
 * inside QRPanel (sharing its QR data URL) and, when printing, isolated as
 * the only visible element on the page via the `.qr-flyer` rule in index.css
 * (visibility-based, since `display:none` ancestors can't be un-hidden by a
 * descendant's print utility — so this deliberately doesn't use a plain
 * `hidden print:block` pairing).
 */
export function QRFlyer({
  title,
  guestUrl,
  dataUrl,
}: {
  title: string;
  guestUrl: string;
  dataUrl: string;
}) {
  const { t } = useI18n();

  return (
    <div className="qr-flyer w-80" data-testid="qr-flyer">
      <div className="relative aspect-[2/3] w-80 overflow-hidden rounded-2xl">
        <img src={flyerFrame} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 flex flex-col items-center px-8 py-10 text-center">
          <div className="flex items-center gap-1.5">
            <img src={logo} alt="" className="h-7 w-7" />
            <span className="font-display text-lg font-semibold text-[var(--color-accent-dark)]">
              Moments
            </span>
          </div>

          <h2 className="mt-6 font-display text-2xl font-semibold text-[var(--color-accent-dark)]">
            {t("flyerCta")}
          </h2>
          {/* Fixed dark "paper inks" (not theme tokens): this flyer is composited
              on the light frame image and printed on white paper, so its text must
              stay dark regardless of the dark UI theme. */}
          <p className="mt-1 text-sm text-[#3f3f46]">{t("flyerCtaSubline")}</p>

          <img
            src={dataUrl}
            alt={`QR — ${title}`}
            className="mt-6 h-36 w-36 rounded-lg shadow-sm"
            data-testid="qr-flyer-image"
          />

          <p className="mt-5 text-xs text-[#52525b]">{t("flyerInstruction")}</p>
          <p className="mt-2 truncate font-display text-base font-semibold text-[#18181b]">
            {title}
          </p>
          <code className="mt-1 text-[10px] text-[#71717a] break-all">{guestUrl}</code>
        </div>
      </div>
    </div>
  );
}
