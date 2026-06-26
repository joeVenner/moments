import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { prefersReducedMotion, safeConfetti } from "../lib/motion";
import heroIllustration from "../assets/hero-illustration.png";
import winnerTrophy from "../assets/winner-trophy.png";
import emptyFeed from "../assets/empty-feed.png";
import qrFeature from "../assets/qr-feature.png";

const MOMENTS_COUNTER_TARGET = 12482;

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
  icon: string;
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
      className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-6 text-center shadow-sm transition-all duration-700 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      <img src={icon} alt="" className="mx-auto h-20 w-20" />
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
      <section className="flex flex-col items-center gap-8 px-6 pt-20 pb-16 text-center sm:pt-28 sm:pb-24">
        <div
          className={`flex flex-col items-center gap-5 transition-all duration-700 ${
            heroVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
          }`}
        >
          <h1 className="max-w-2xl text-4xl font-semibold text-[var(--color-accent-dark)] sm:text-5xl">
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
              className="rounded-full bg-[var(--color-accent)] px-6 py-3 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
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
        <div className="w-full max-w-2xl" style={{ transform: `translateY(${heroParallax}px)` }}>
          <img
            src={heroIllustration}
            alt=""
            className={`w-full transition-all delay-150 duration-700 ${
              heroVisible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
            }`}
          />
        </div>
      </section>

      {/* Feature highlights */}
      <section className="px-6 pb-24">
        <h2 className="mx-auto max-w-lg text-center text-2xl font-semibold text-[var(--color-text)] sm:text-3xl">
          {t("featuresHeading")}
        </h2>

        <div className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-3">
          <FeatureCard
            icon={winnerTrophy}
            title={t("featurePointsTitle")}
            body={t("featurePointsBody")}
            delayMs={0}
          />
          <FeatureCard
            icon={emptyFeed}
            title={t("featureSharingTitle")}
            body={t("featureSharingBody")}
            delayMs={120}
          />
          <FeatureCard
            icon={qrFeature}
            title={t("featureScanTitle")}
            body={t("featureScanBody")}
            delayMs={240}
          />
        </div>
      </section>
    </div>
  );
}
