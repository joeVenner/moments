import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { prefersReducedMotion, safeConfetti } from "../lib/motion";
import firstDance from "../assets/moments/first-dance.jpg";
import toast from "../assets/moments/toast.jpg";
import cake from "../assets/moments/cake.jpg";
import danceFloor from "../assets/moments/dance-floor.jpg";
import goldenHour from "../assets/moments/golden-hour.jpg";
import speeches from "../assets/moments/speeches.jpg";
import { DotField } from "../components/DotField";

const MOMENTS_COUNTER_TARGET = 12482;

// Generated dark-theme preview "photos" for the landing moments marquee (PLAN
// P1.3). Real illustrated thumbnails (gpt-image-2, dark-native) replace the
// earlier emoji placeholders so the strip looks like an actual live feed.
const SAMPLE_MOMENTS = [
  { img: firstDance, captionKey: "momentCaptionFirstDance", name: "Léa" },
  { img: toast, captionKey: "momentCaptionToast", name: "Marco" },
  { img: cake, captionKey: "momentCaptionCake", name: "Aïsha" },
  { img: danceFloor, captionKey: "momentCaptionDanceFloor", name: "Sam" },
  { img: goldenHour, captionKey: "momentCaptionGoldenHour", name: "Priya" },
  { img: speeches, captionKey: "momentCaptionSpeeches", name: "Tom" },
] as const;

// Each marquee group holds 3× the moments so one group (~3.4kpx at sm tile width)
// is wider than any realistic viewport. The track = 2 identical groups and
// translates -50% (exactly one group) for a seamless loop; if a group were
// narrower than the viewport, the -50% end would run past the last tile into
// empty space (the "nothing after the last card" gap on wide screens).
const MARQUEE_TILES = [...SAMPLE_MOMENTS, ...SAMPLE_MOMENTS, ...SAMPLE_MOMENTS];

// Crisp inline SVG feature icons (accent-colored, scalable) — replace the old
// baked-white PNG icons that read as bright squares on the dark cards (P0.4).
function CameraIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

function SlideshowIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="m10 8 5 2.5-5 2.5V8ZM8 21h8M12 17v4" />
    </svg>
  );
}

function LockIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </svg>
  );
}

function UploadIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

function HeartIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20.8 5.7a5.4 5.4 0 0 0-7.6 0L12 6.9l-1.2-1.2a5.4 5.4 0 1 0-7.6 7.6L12 22l8.8-8.7a5.4 5.4 0 0 0 0-7.6Z" />
    </svg>
  );
}

function DownloadIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
    </svg>
  );
}

function AnalyticsIcon({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

function WhatsAppIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M20.5 11.7a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.4-4.7A8.5 8.5 0 1 1 20.5 11.7Z" />
      <path d="M8.2 7.7c.3 3.8 2.4 5.9 6.2 6.3l1.2-1.5-2.4-1.1-.9 1c-1.4-.6-2.4-1.6-3-3l1-.8-1.1-2.4-1 .5Z" />
    </svg>
  );
}

const WHATSAPP_URL =
  "https://wa.me/212708080301?text=Bonjour%20Moments%2C%20j%27ai%20un%20%C3%A9v%C3%A9nement%20%C3%A0%20venir%20et%20je%20souhaite%20cr%C3%A9er%20mon%20espace.";

const FAQ_ITEMS = [
  ["faqWhatQuestion", "faqWhatAnswer"],
  ["faqAppQuestion", "faqAppAnswer"],
  ["faqPrivateQuestion", "faqPrivateAnswer"],
  ["faqUploadQuestion", "faqUploadAnswer"],
  ["faqDownloadQuestion", "faqDownloadAnswer"],
] as const;

function useCountUp(target: number, durationMs = 1400) {
  // Reduced motion → snap to the final value (no animated ramp).
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    let frameId: number;
    const start = performance.now();

    function tick(now: number) {
      const progress = Math.min((now - start) / durationMs, 1);
      // Ease-out cubic — fast start, gentle settle, feels less mechanical than linear.
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [target, durationMs]);

  return value;
}

function useScrollParallax(factor = 0.15) {
  // Damped translateY driven by scroll position; reduced motion → stays at 0.
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    let frameId = 0;
    function update() {
      frameId = 0;
      setOffset(window.scrollY * factor);
    }
    function onScroll() {
      // Coalesce bursts of scroll events into one rAF-aligned update — no thrash.
      if (frameId === 0) frameId = requestAnimationFrame(update);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    update(); // seed for a non-zero initial scroll (e.g. refresh mid-page)
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [factor]);

  return offset;
}

function FeatureCard({
  icon,
  title,
  body,
  delayMs,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  delayMs: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Reduced motion → start already revealed so no reveal transition ever fires.
  const [visible, setVisible] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: visible ? `${delayMs}ms` : "0ms" }}
      className={`group rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-6 text-center shadow-sm transition-all duration-700 hover:border-[var(--color-accent)] ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-accent)] transition-transform duration-300 group-hover:scale-110">
        {icon}
      </div>
      <h3 className="mt-4 text-lg font-semibold text-[var(--color-text)]">{title}</h3>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

// Asymmetric hero visual (PLAN landing-wow): a scattered pile of REAL moment
// polaroids — dark-native frames, random tilt, hover lifts a card out of the
// pile. Per-card `depth` multiplies one shared scroll offset for parallax depth
// (foreground drifts more than the back field). The wrapper owns translateY so
// it never fights the figure's Tailwind `translate`/`rotate`/`scale` (independent
// CSS properties in Tailwind v4). `rotate` comes from a per-card CSS var so the
// literal `rotate-[var(--card-rot)]` class is JIT-detectable; `hover:rotate-0`
// overrides it on hover. All hover transforms gated on `motion-safe`.
const POLAROIDS = [
  { img: goldenHour, name: "Priya", note: "Lumière dorée parfaite ✨", top: "2%", left: "0%", w: "42%", rot: -7, depth: 0.45, z: "z-10", delay: 0 },
  { img: toast, name: "Marco", note: "Portez vos verres ! 🥂", top: "4%", left: "55%", w: "40%", rot: 6, depth: 0.45, z: "z-10", delay: 70 },
  { img: firstDance, name: "Léa", note: "Quelle belle bride !", top: "26%", left: "22%", w: "48%", rot: -3, depth: 1.3, z: "z-30", delay: 140 },
  { img: danceFloor, name: "Sam", note: "La piste explose 🔥", top: "42%", left: "62%", w: "38%", rot: 8, depth: 0.85, z: "z-20", delay: 210 },
  { img: cake, name: "Aïsha", note: "Le gâteau ! 🎂", top: "48%", left: "0%", w: "40%", rot: 4, depth: 0.7, z: "z-20", delay: 280 },
] as const;

function PolaroidCluster({ parallax, visible }: { parallax: number; visible: boolean }) {
  return (
    <div className="relative mx-auto aspect-[4/5] w-full max-w-sm">
      {POLAROIDS.map((p, i) => (
        <div
          key={i}
          className={`absolute ${p.z} motion-safe:hover:z-40`}
          style={{ top: p.top, left: p.left, width: p.w, transform: `translateY(${parallax * p.depth}px)` }}
        >
          <figure
            style={{ "--card-rot": `${p.rot}deg`, transitionDelay: visible ? `${p.delay}ms` : "0ms" } as React.CSSProperties}
            className={`rotate-[var(--card-rot)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-1.5 pb-8 shadow-xl shadow-black/40 transition-all duration-700 motion-safe:hover:rotate-0 motion-safe:hover:scale-105 ${
              visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
            }`}
          >
            <img src={p.img} alt="" loading="lazy" className="aspect-[3/4] w-full rounded-sm object-cover" />
            {/* Polaroid caption: guest name (mono, muted) over a short handwritten-style note. */}
            <figcaption className="mt-1.5 px-1 text-center">
              <p className="font-mono text-[10px] text-[var(--color-text-muted)]">{p.name}</p>
              <p className="mt-0.5 text-[11px] italic leading-tight text-[var(--color-text)]">{p.note}</p>
            </figcaption>
          </figure>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // Reduced motion → render the hero at rest, skipping the mount transition.
  const [heroVisible, setHeroVisible] = useState(() => prefersReducedMotion());
  const [eventCode, setEventCode] = useState("");
  const momentsCaptured = useCountUp(MOMENTS_COUNTER_TARGET);
  // Smaller base factor — per-card depth multipliers in PolaroidCluster amplify it.
  const heroParallax = useScrollParallax(0.08);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    // Defer to next frame so the initial (opacity-0) state paints first,
    // guaranteeing the transition actually animates rather than snapping in.
    const id = requestAnimationFrame(() => setHeroVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function fireConfetti() {
    safeConfetti({
      particleCount: 80,
      spread: 65,
      origin: { y: 0.7 },
    });
  }

  function handleJoinSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = eventCode.trim();
    if (!code) return;
    fireConfetti();
    navigate(`/e/${encodeURIComponent(code)}`);
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      {/* Hero — asymmetric split (PLAN landing-wow): copy + join left, scattered
          real-moment polaroid pile right. Replaces the single centered AI image. */}
      <section className="relative overflow-hidden px-6 pt-20 pb-16 sm:pt-28 sm:pb-24">
        <DotField className="absolute inset-0" />
        {/* Animated warm-orange glow backdrop (PLAN P2.2), frozen under reduced motion. */}
        <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />

        <div className="relative z-10 mx-auto flex max-w-6xl flex-col items-center gap-12 sm:flex-row sm:items-center sm:justify-center sm:gap-12">
          {/* Copy + join form */}
          <div
            className={`flex w-full max-w-md flex-col items-center gap-5 text-center transition-all duration-700 sm:w-[28rem] sm:flex-shrink-0 sm:items-start sm:text-left ${
              heroVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
            }`}
          >
            <h1 className="max-w-2xl bg-gradient-to-br from-[var(--color-text)] via-[var(--color-text)] to-[var(--color-accent)] bg-clip-text text-4xl font-semibold leading-[1.1] text-transparent sm:text-5xl">
              {t("heroHeadline")}
            </h1>
            <p className="max-w-md text-base text-[var(--color-text-muted)] sm:text-lg">{t("heroSubhead")}</p>

            <form
              onSubmit={handleJoinSubmit}
              className="mt-2 flex w-full max-w-sm flex-col gap-2 sm:flex-row"
            >
              <input
                value={eventCode}
                onChange={(e) => setEventCode(e.target.value)}
                placeholder={t("eventCodePlaceholder")}
                className="flex-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-2 text-center text-sm outline-none focus:border-[var(--color-accent)] sm:text-left"
              />
              <button
                type="submit"
                data-spark
                disabled={!eventCode.trim()}
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 py-2 font-mono text-sm font-medium text-white shadow-lg shadow-[var(--color-accent)]/20 transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
              >
                {t("joinEvent")}
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </form>

            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 font-mono text-xs text-[var(--color-text-muted)] underline decoration-[var(--color-border)] underline-offset-4 transition hover:text-[var(--color-accent)]"
            >
              <WhatsAppIcon className="h-4 w-4" />
              {t("contactUsShort")}
            </a>

            {/* Live-count stat chip — big number over a two-line label with an
                icon, so it reads as a graphic element instead of a plain text line. */}
            <div className="mt-1 inline-flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-bg)] text-[var(--color-accent)]">
                <CameraIcon className="h-5 w-5" />
              </span>
              <div className="text-left leading-tight">
                <div className="font-mono text-xl font-semibold text-[var(--color-text)]">
                  {momentsCaptured.toLocaleString()}
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {t("momentsCapturedLabel")}
                </div>
              </div>
            </div>
          </div>

          {/* Scattered polaroid pile — asymmetric, multi-element, real assets. */}
          <div className="w-full max-w-sm flex-shrink-0 sm:w-[24rem]">
            <PolaroidCluster parallax={heroParallax} visible={heroVisible} />
          </div>
        </div>
      </section>

      {/* Moments marquee — a continuously scrolling peek at a live feed. The track
          holds TWO identical groups and slides left by exactly one group width
          (-50%), so the loop is seamless and never "reaches an end." Each group is
          its own flex (gap inside only) so the seam spacing matches the internal
          gaps. Hover pauses; reduced-motion freezes (CSS in index.css). */}
      <section className="pb-16">
        <h2 className="mx-auto max-w-lg px-6 text-center text-2xl font-semibold text-[var(--color-text)] sm:text-3xl">
          {t("marqueeHeading")}
        </h2>
        <div className="marquee-mask mt-8 overflow-hidden">
          <div className="animate-marquee flex">
            {[0, 1].map((copy) => (
              <div key={copy} aria-hidden={copy === 1} className="flex shrink-0 gap-4 px-2">
                {MARQUEE_TILES.map((m, i) => (
                  <figure
                    key={`${m.captionKey}-${copy}-${i}`}
                    className="relative aspect-[3/4] w-40 shrink-0 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] sm:w-44"
                  >
                    <img
                      src={m.img}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 text-left">
                      <p className="text-sm font-medium text-[var(--color-text)]">{t(m.captionKey)}</p>
                      <p className="font-mono text-xs text-[var(--color-text-muted)]">{m.name}</p>
                    </figcaption>
                  </figure>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Product feature showcase — capabilities available in production. */}
      <section className="px-6 pb-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-accent)]">{t("featuresEyebrow")}</p>
          <h2 className="mt-3 text-3xl font-semibold text-[var(--color-text)] sm:text-4xl">
          {t("featuresHeading")}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-[var(--color-text-muted)]">{t("featuresIntro")}</p>
        </div>

        <div className="mx-auto mt-10 grid max-w-5xl gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<SlideshowIcon />}
            title={t("featureSlideshowTitle")}
            body={t("featureSlideshowBody")}
            delayMs={0}
          />
          <FeatureCard
            icon={<LockIcon />}
            title={t("featurePrivacyTitle")}
            body={t("featurePrivacyBody")}
            delayMs={80}
          />
          <FeatureCard
            icon={<UploadIcon />}
            title={t("featureResumableTitle")}
            body={t("featureResumableBody")}
            delayMs={160}
          />
          <FeatureCard
            icon={<HeartIcon />}
            title={t("featureHighlightsTitle")}
            body={t("featureHighlightsBody")}
            delayMs={0}
          />
          <FeatureCard
            icon={<DownloadIcon />}
            title={t("featureExportTitle")}
            body={t("featureExportBody")}
            delayMs={80}
          />
          <FeatureCard
            icon={<AnalyticsIcon />}
            title={t("featureControlTitle")}
            body={t("featureControlBody")}
            delayMs={160}
          />
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-center font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-accent)]">{t("faqEyebrow")}</p>
          <h2 className="mt-3 text-center text-3xl font-semibold text-[var(--color-text)] sm:text-4xl">{t("faqHeading")}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-[var(--color-text-muted)]">{t("faqIntro")}</p>
          <div className="mt-8 divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
            {FAQ_ITEMS.map(([question, answer]) => (
              <details key={question} className="group px-5 py-4 open:bg-black/10 sm:px-6">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-[var(--color-text)]">
                  {t(question)}
                  <span aria-hidden className="text-xl text-[var(--color-accent)] transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 max-w-2xl pr-8 text-sm leading-6 text-[var(--color-text-muted)]">{t(answer)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="contact-cta relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-6 py-12 text-center sm:px-12 sm:py-16">
          <div aria-hidden className="contact-cta__orb contact-cta__orb--one" />
          <div aria-hidden className="contact-cta__orb contact-cta__orb--two" />
          <div className="relative z-10 mx-auto max-w-2xl">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-accent)]">{t("contactEyebrow")}</p>
            <h2 className="mt-3 text-3xl font-semibold text-[var(--color-text)] sm:text-4xl">{t("contactTitle")}</h2>
            <p className="mx-auto mt-4 max-w-xl text-[var(--color-text-muted)]">{t("contactBody")}</p>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-spark
              className="mt-7 inline-flex items-center justify-center gap-2 rounded-full bg-[#25D366] px-5 py-3 font-mono text-sm font-semibold text-[#07150b] shadow-lg shadow-[#25D366]/15 transition hover:-translate-y-0.5 hover:bg-[#31e675]"
            >
              <WhatsAppIcon />
              {t("contactWhatsApp")}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
