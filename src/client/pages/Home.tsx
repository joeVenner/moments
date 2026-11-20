import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n, type Lang } from "../lib/i18n";
import { appStoreUrl, EXTRA_EVENT_USD, formatUsd, HOSTING_TIERS, POPULAR_TIER_ID } from "../lib/pricing";
import firstDance from "../assets/moments/first-dance.jpg";
import toast from "../assets/moments/toast.jpg";
import cake from "../assets/moments/cake.jpg";
import danceFloor from "../assets/moments/dance-floor.jpg";
import goldenHour from "../assets/moments/golden-hour.jpg";
import speeches from "../assets/moments/speeches.jpg";

/**
 * The public landing at `/` (approved design, Landing board). Departures
 * from the design, until subscriptions are sold in the app:
 * - hosts are pointed to WhatsApp, how events are set up today, unless an
 *   App Store id is configured (`VITE_APP_STORE_ID`);
 * - guests keep the event-code box the previous home had.
 */
const WHATSAPP_URL =
  "https://wa.me/212708080301?text=Bonjour%20Moments%2C%20j%27ai%20un%20%C3%A9v%C3%A9nement%20%C3%A0%20venir%20et%20je%20souhaite%20cr%C3%A9er%20mon%20espace.";

const APP_STORE_URL = appStoreUrl(import.meta.env.VITE_APP_STORE_ID);
/** Where hosts go: the App Store once listed, WhatsApp until then. */
const HOST_HREF = APP_STORE_URL ?? WHATSAPP_URL;

const PHONE_TILES = [firstDance, toast, cake, danceFloor, goldenHour, speeches, cake, firstDance, speeches];

const STEPS = [1, 2, 3] as const;
const FEATURES = [1, 2, 3, 4, 5, 6] as const;
const FAQS = [1, 2, 3, 4] as const;
const INCLUDES = [1, 2, 3, 4] as const;
const LANGS: readonly Lang[] = ["en", "fr"];

const sectionTitle = "m-0 max-w-2xl font-display text-[clamp(32px,4vw,48px)] font-semibold leading-[1.1]";

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]";

function ExternalLink({ href, className, label, children }: { href: string; className: string; label?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${className} ${FOCUS_RING}`}>
      {label ? <span className="sr-only">{label}</span> : null}
      <span aria-hidden={label ? true : undefined}>{children}</span>
      <span className="sr-only"> {t("landingNewTab")}</span>
    </a>
  );
}

function Check() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0 text-[var(--color-accent)]">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div role="group" aria-label={t("landingLanguage")} className="flex rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-[3px]">
      {LANGS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLang(option)}
          aria-pressed={lang === option}
          className={`h-[34px] min-w-11 rounded-[9px] text-[13px] font-semibold text-[var(--color-text)] ${FOCUS_RING} ${
            lang === option ? "bg-[var(--color-border)]" : "bg-transparent"
          }`}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function JoinForm() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [code, setCode] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    navigate(`/e/${encodeURIComponent(trimmed)}`);
  }

  return (
    <form id="join" onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-2">
      <label htmlFor="event-code" className="text-sm text-[var(--color-text-muted)]">
        {t("landingJoinLabel")}
      </label>
      <div className="flex gap-2">
        <input
          id="event-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t("landingJoinPlaceholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`h-12 min-w-0 flex-1 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] ${FOCUS_RING}`}
        />
        <button
          type="submit"
          disabled={!code.trim()}
          className={`h-12 rounded-[14px] border border-[var(--color-border)] px-5 text-[15px] font-semibold text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)] disabled:opacity-50 ${FOCUS_RING}`}
        >
          {t("landingJoinButton")}
        </button>
      </div>
    </form>
  );
}

function PhoneMock() {
  const { t } = useI18n();
  return (
    <div
      role="img"
      aria-label={t("landingPhoneLabel")}
      className="relative mx-auto h-[650px] w-[320px] max-w-full shrink-0 overflow-hidden rounded-[52px] border-[10px] border-[var(--color-bg-alt)] bg-[var(--color-bg)] shadow-phone"
    >
      <div className="flex flex-col gap-2.5 px-3.5 pt-11">
        <span className="font-display text-[21px] font-semibold">Sara &amp; Omar</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">{t("landingPhoneStats")}</span>
        <div className="-mx-3.5 mt-1 grid grid-cols-3 gap-0.5">
          {[...PHONE_TILES, ...PHONE_TILES].map((tile, index) => (
            <img key={index} src={tile} alt="" loading="lazy" className="aspect-square w-full object-cover" />
          ))}
        </div>
      </div>
      <span className="absolute top-[250px] left-3.5 flex h-[30px] items-center gap-1.5 rounded-[15px] bg-[var(--color-text)] px-3 text-xs font-semibold text-[var(--color-bg)]">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor" className="text-[var(--color-accent)]" />
        </svg>
        {t("landingPhoneToast")}
      </span>
      <span className="absolute right-3.5 bottom-[22px] flex h-[42px] items-center rounded-[21px] bg-[var(--color-accent)] px-4 text-[13px] font-semibold text-[var(--color-bg)]">
        {t("landingPhoneShare")}
      </span>
    </div>
  );
}

export default function Home() {
  const { t, lang } = useI18n();
  const legalBase = lang === "fr" ? "/fr" : "";
  const hostLabel = APP_STORE_URL ? t("landingAppStore") : t("landingHostCta");

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <nav aria-label="Main" className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-7 gap-y-4 px-4 py-5 sm:px-6">
        <a href="#top" className="mr-auto font-display text-[26px] font-bold text-[var(--color-text)]">
          Moments
        </a>
        <div className="hidden flex-wrap gap-x-6 gap-y-1 text-[15px] md:flex">
          <a href="#how" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("landingNavHow")}</a>
          <a href="#features" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("landingNavFeatures")}</a>
          <a href="#pricing" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("landingNavPricing")}</a>
          <a href="#faq" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("landingNavFaq")}</a>
        </div>
        <LanguageToggle />
        <ExternalLink
          href={HOST_HREF}
          className="flex h-11 items-center rounded-xl bg-[var(--color-accent)] px-[18px] text-[15px] font-semibold text-[var(--color-bg)] hover:bg-[var(--color-accent-dark)]"
        >
          {APP_STORE_URL ? t("landingGetApp") : t("landingHostCta")}
        </ExternalLink>
      </nav>

      <header id="top" className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute -top-[260px] -right-[220px] h-[900px] w-[900px] rounded-full border border-[var(--color-ring)]" />
        <div aria-hidden className="pointer-events-none absolute -top-[120px] -right-20 h-[620px] w-[620px] rounded-full border border-[var(--color-ring-strong)]" />
        <div aria-hidden className="absolute top-[120px] left-[8%] h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]" />
        <div aria-hidden className="absolute top-[70px] left-[46%] h-1.5 w-1.5 rounded-full bg-[var(--color-text)]" />

        <div className="relative mx-auto flex max-w-[1200px] flex-wrap items-center gap-14 px-4 pt-14 pb-24 sm:px-6">
          <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-6">
            <span className="flex h-8 items-center gap-2 self-start rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3.5 text-sm text-[var(--color-text-muted)]">
              <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
              {t("landingEyebrow")}
            </span>
            <h1 className="m-0 font-display text-[clamp(44px,6vw,76px)] leading-[1.02] font-semibold tracking-[-1.5px]">
              {t("landingHeroTitle1")}
              <br />
              <span className="text-[var(--color-accent)]">{t("landingHeroTitle2")}</span>
            </h1>
            <p className="m-0 max-w-[540px] text-[19px] leading-[29px] text-[var(--color-text-muted)]">{t("landingHeroSub")}</p>
            <ExternalLink
              href={HOST_HREF}
              className="flex h-14 items-center gap-2.5 self-start rounded-2xl bg-[var(--color-text)] px-[22px] text-base font-semibold text-[var(--color-bg)] hover:opacity-90"
            >
              {hostLabel}
            </ExternalLink>
            <JoinForm />
            <span className="text-sm text-[var(--color-text-muted)]">{t("landingHeroNote")}</span>
          </div>
          <PhoneMock />
        </div>
      </header>

      <section id="how" aria-labelledby="how-title" className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-12 px-4 py-24 sm:px-6">
          <h2 id="how-title" className={sectionTitle}>{t("landingHowTitle")}</h2>
          <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5 p-0">
            {STEPS.map((step) => (
              <li key={step} className="flex flex-col gap-3.5 rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent)] font-display text-[22px] font-bold text-[var(--color-bg)]">
                  {step}
                </span>
                <span className="text-[21px] font-semibold">{t(`landingStep${step}Title`)}</span>
                <span className="text-base leading-6 text-[var(--color-text-muted)]">{t(`landingStep${step}Body`)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="features" aria-labelledby="features-title" className="border-y border-[var(--color-border)] bg-[var(--color-bg-deep)]">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-12 px-4 py-24 sm:px-6">
          <h2 id="features-title" className={sectionTitle}>{t("landingFeaturesTitle")}</h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-10">
            {FEATURES.map((feature) => (
              <div key={feature} className="flex flex-col gap-2.5 border-t border-[var(--color-border)] pt-5">
                <span className="text-[19px] font-semibold">{t(`landingFeature${feature}Title`)}</span>
                <span className="text-base leading-6 text-[var(--color-text-muted)]">{t(`landingFeature${feature}Body`)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" aria-labelledby="pricing-title">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-4 py-24 sm:px-6">
          <div className="flex max-w-[680px] flex-col gap-3.5">
            <h2 id="pricing-title" className={sectionTitle}>{t("landingPricingTitle")}</h2>
            <p className="m-0 text-lg leading-[27px] text-[var(--color-text-muted)]">{t("landingPricingSub")}</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4">
            {HOSTING_TIERS.map((tier, index) => {
              const isPopular = tier.productId === POPULAR_TIER_ID;
              return (
                <div
                  key={tier.productId}
                  className={`relative flex flex-col gap-4 rounded-3xl bg-[var(--color-bg-alt)] p-[26px] ${
                    isPopular ? "border-2 border-[var(--color-accent)]" : "border border-[var(--color-border)]"
                  }`}
                >
                  {isPopular && (
                    <span className="absolute -top-[13px] left-6 flex h-[26px] items-center rounded-[13px] bg-[var(--color-accent)] px-3 text-xs font-bold text-[var(--color-bg)]">
                      {t("landingPopular")}
                    </span>
                  )}
                  <div className="flex flex-col gap-1">
                    <span className="text-[15px] text-[var(--color-text-muted)]">{t(`landingFit${index + 1}`)}</span>
                    <span className="font-display text-[34px] font-semibold">{t("landingGuests", { count: tier.guestCap })}</span>
                  </div>
                  <span className="text-lg font-semibold">
                    {formatUsd(tier.monthlyUsd, lang)}
                    <span className="text-sm font-normal text-[var(--color-text-muted)]">{t("landingPerMonth")}</span>
                  </span>
                  <ExternalLink
                    href={HOST_HREF}
                    label={t("landingChoosePlan", { count: tier.guestCap })}
                    className={`flex h-12 items-center justify-center rounded-[14px] border text-[15px] font-semibold ${
                      isPopular
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)] hover:bg-[var(--color-accent-dark)]"
                        : "border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    {t("landingChoose")}
                  </ExternalLink>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-start gap-x-10 gap-y-5 rounded-3xl border border-[var(--color-border)] p-[26px]">
            <span className="flex-none text-[17px] font-semibold">{t("landingIncludesTitle")}</span>
            <ul className="m-0 grid flex-[1_1_520px] list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6 gap-y-3 p-0">
              {INCLUDES.map((item) => (
                <li key={item} className="flex gap-2.5 text-[15px] leading-[21px]">
                  <Check />
                  {t(`landingInclude${item}`, { price: formatUsd(EXTRA_EVENT_USD, lang) })}
                </li>
              ))}
            </ul>
          </div>
          <p className="m-0 text-sm text-[var(--color-text-muted)]">{t("landingPricingNote")}</p>
        </div>
      </section>

      <section id="faq" aria-labelledby="faq-title" className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex max-w-[860px] flex-col gap-7 px-4 py-24 sm:px-6">
          <h2 id="faq-title" className={sectionTitle}>{t("landingFaqTitle")}</h2>
          {FAQS.map((faq) => (
            <details key={faq} className="border-b border-[var(--color-border)] py-[22px]">
              <summary className="cursor-pointer text-[19px] font-semibold">{t(`landingFaq${faq}Question`)}</summary>
              <p className="mt-3 mb-0 text-base leading-[25px] text-[var(--color-text-muted)]">{t(`landingFaq${faq}Answer`)}</p>
            </details>
          ))}
        </div>
      </section>

      <section aria-labelledby="cta-title" className="px-4 pb-24 sm:px-6">
        <div className="mx-auto flex max-w-[1152px] flex-col items-center gap-[18px] rounded-[32px] bg-[var(--color-accent)] px-8 py-[72px] text-center text-[var(--color-bg)]">
          <h2 id="cta-title" className="m-0 max-w-[760px] font-display text-[clamp(32px,4.5vw,54px)] leading-[1.08] font-semibold">
            {t("landingCtaTitle")}
          </h2>
          <p className="m-0 text-lg">{t("landingCtaSub")}</p>
          <ExternalLink
            href={HOST_HREF}
            className="flex h-14 items-center rounded-2xl bg-[var(--color-bg)] px-[26px] text-base font-semibold text-[var(--color-text)] hover:opacity-90"
          >
            {hostLabel}
          </ExternalLink>
        </div>
      </section>

      <footer className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-7 gap-y-3 px-4 pt-7 pb-10 text-sm text-[var(--color-text-muted)] sm:px-6">
          <span className="mr-auto font-display text-lg font-semibold text-[var(--color-text)]">Moments</span>
          <a href={`${legalBase}/privacy`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("footerPrivacy")}</a>
          <a href={`${legalBase}/terms`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("footerTerms")}</a>
          <ExternalLink href={WHATSAPP_URL} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            {t("landingContact")}
          </ExternalLink>
          <span>© 2026 Moments</span>
        </div>
      </footer>
    </div>
  );
}
