import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { prefersReducedMotion, safeConfetti } from "../lib/motion";
import heroIllustration from "../assets/hero-illustration.jpg";
import firstDance from "../assets/moments/first-dance.jpg";
import toast from "../assets/moments/toast.jpg";
import cake from "../assets/moments/cake.jpg";
import danceFloor from "../assets/moments/dance-floor.jpg";
import goldenHour from "../assets/moments/golden-hour.jpg";
import speeches from "../assets/moments/speeches.jpg";

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

// Crisp inline SVG feature icons (accent-colored, scalable) — replace the old
// baked-white PNG icons that read as bright squares on the dark cards (P0.4).
function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-9 w-9">
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-9 w-9">
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-9 w-9">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M7 12h10" />
    </svg>
  );
}

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

export default function Home() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // Reduced motion → render the hero at rest, skipping the mount transition.
  const [heroVisible, setHeroVisible] = useState(() => prefersReducedMotion());
  const [eventCode, setEventCode] = useState("");
  const momentsCaptured = useCountUp(MOMENTS_COUNTER_TARGET);
  const heroParallax = useScrollParallax();

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
      {/* Hero */}
      <section className="relative flex flex-col items-center gap-8 overflow-hidden px-6 pt-20 pb-16 text-center sm:pt-28 sm:pb-24">
        {/* Animated warm-orange glow backdrop (PLAN P2.2), frozen under reduced motion. */}
        <div aria-hidden className="hero-glow pointer-events-none absolute inset-0" />

        <div
          className={`relative z-10 flex flex-col items-center gap-5 transition-all duration-700 ${
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
              className="flex-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-5 py-3 text-center text-sm outline-none focus:border-[var(--color-accent)] sm:text-left"
            />
            <button
              type="submit"
              disabled={!eventCode.trim()}
              className="rounded-full bg-[var(--color-accent)] px-6 py-3 font-mono text-sm font-medium text-white shadow-lg shadow-[var(--color-accent)]/20 transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
            >
              {t("joinEvent")}
            </button>
          </form>

          <Link
            to="/admin"
            className="text-xs text-[var(--color-text-muted)] underline-offset-2 transition hover:text-[var(--color-text)] hover:underline"
          >
            {t("openAdminPanel")}
          </Link>

          <p className="font-mono text-xs text-[var(--color-text-muted)]">
            {t("momentsCapturedCounter", { count: momentsCaptured.toLocaleString() })}
          </p>
        </div>

        {/* Wrapper owns the scroll parallax transform; the img keeps its own
            mount transition so the two transforms don't overwrite each other. */}
        <div
          className="relative z-10 w-full max-w-2xl"
          style={{ transform: `translateY(${heroParallax}px)` }}
        >
          <img
            src={heroIllustration}
            alt=""
            className={`w-full rounded-3xl border border-[var(--color-border)] shadow-2xl transition-all delay-150 duration-700 ${
              heroVisible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
            }`}
          />
        </div>
      </section>

      {/* Moments marquee — a continuously scrolling peek at a live feed. The track
          holds two copies of the tiles and slides -50% for a seamless loop; hover
          pauses, reduced-motion stops it (CSS in index.css). */}
      <section className="overflow-hidden pb-16">
        <h2 className="mx-auto max-w-lg px-6 text-center text-2xl font-semibold text-[var(--color-text)] sm:text-3xl">
          {t("marqueeHeading")}
        </h2>
        <div className="no-scrollbar mt-8 overflow-x-auto">
          <div className="animate-marquee flex gap-4 px-6">
            {[...SAMPLE_MOMENTS, ...SAMPLE_MOMENTS].map((m, i) => (
              <figure
                key={`${m.captionKey}-${i}`}
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
        </div>
      </section>

      {/* Feature highlights */}
      <section className="px-6 pb-24">
        <h2 className="mx-auto max-w-lg text-center text-2xl font-semibold text-[var(--color-text)] sm:text-3xl">
          {t("featuresHeading")}
        </h2>

        <div className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-3">
          <FeatureCard
            icon={<TrophyIcon />}
            title={t("featurePointsTitle")}
            body={t("featurePointsBody")}
            delayMs={0}
          />
          <FeatureCard
            icon={<CameraIcon />}
            title={t("featureSharingTitle")}
            body={t("featureSharingBody")}
            delayMs={120}
          />
          <FeatureCard
            icon={<ScanIcon />}
            title={t("featureScanTitle")}
            body={t("featureScanBody")}
            delayMs={240}
          />
        </div>
      </section>
    </div>
  );
}
