import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import confetti from "canvas-confetti";
import { useI18n } from "../lib/i18n";
import heroIllustration from "../assets/hero-illustration.png";
import winnerTrophy from "../assets/winner-trophy.png";
import emptyFeed from "../assets/empty-feed.png";
import qrFeature from "../assets/qr-feature.png";

const MOMENTS_COUNTER_TARGET = 12482;

function useCountUp(target: number, durationMs = 1400) {
  const [value, setValue] = useState(0);

  useEffect(() => {
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
  const [visible, setVisible] = useState(false);

  useEffect(() => {
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
      className={`rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm transition-all duration-700 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      <img src={icon} alt="" className="mx-auto h-20 w-20" />
      <h3 className="mt-4 text-lg font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm text-slate-600">{body}</p>
    </div>
  );
}

export default function Home() {
  const { t } = useI18n();
  const [heroVisible, setHeroVisible] = useState(false);
  const momentsCaptured = useCountUp(MOMENTS_COUNTER_TARGET);

  useEffect(() => {
    // Defer to next frame so the initial (opacity-0) state paints first,
    // guaranteeing the transition actually animates rather than snapping in.
    const id = requestAnimationFrame(() => setHeroVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function fireConfetti() {
    confetti({
      particleCount: 80,
      spread: 65,
      origin: { y: 0.7 },
      colors: ["#d97757", "#c15f3c", "#fcfaf6"],
    });
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
          <p className="max-w-md text-base text-slate-600 sm:text-lg">{t("heroSubhead")}</p>
          <Link
            to="/admin"
            onClick={fireConfetti}
            className="mt-2 rounded-full bg-[var(--color-accent)] px-6 py-3 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
          >
            {t("openAdminPanel")}
          </Link>
          <p className="font-mono text-xs text-slate-400">
            {t("momentsCapturedCounter", { count: momentsCaptured.toLocaleString() })}
          </p>
        </div>

        <img
          src={heroIllustration}
          alt=""
          className={`w-full max-w-2xl transition-all delay-150 duration-700 ${
            heroVisible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
          }`}
        />
      </section>

      {/* Feature highlights */}
      <section className="px-6 pb-24">
        <h2 className="mx-auto max-w-lg text-center text-2xl font-semibold text-slate-900 sm:text-3xl">
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
