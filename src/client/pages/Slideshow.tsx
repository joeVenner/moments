import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { EventAccessGate } from "../components/EventAccessGate";
import { getEvent, listMoments } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { slideshowLoadFailure } from "../lib/slideshowLoad";
import type { MomentData } from "../lib/types";
import waitingIllustration from "../assets/illustrations/live-gallery-waiting.webp";

const REFRESH_MS = 8_000;
const ADVANCE_MS = 6_000;

function isStreamEmbed(url: string): boolean {
  return url.includes("cloudflarestream.com/") && url.endsWith("/iframe");
}

export default function Slideshow() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useI18n();
  const [moments, setMoments] = useState<MomentData[]>([]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // A private event this browser hasn't unlocked: show the PIN form, and
  // load again (bumping accessVersion) once it's open.
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessVersion, setAccessVersion] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const [, momentsResponse] = await Promise.all([
          getEvent(slug),
          listMoments(slug, { limit: 100, offset: 0 }),
        ]);
        if (disposed) return;
        setMoments(momentsResponse.moments);
        setIndex((current) => Math.min(current, Math.max(0, momentsResponse.moments.length - 1)));
      } catch (error) {
        if (disposed) return;
        if (slideshowLoadFailure(error) === "access_required") {
          // No point polling until the PIN is entered.
          window.clearInterval(timer);
          setAccessRequired(true);
        } else {
          setNotFound(true);
        }
      }
    };
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    void refresh();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [slug, accessVersion]);

  useEffect(() => {
    if (paused || moments.length < 2) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % moments.length),
      ADVANCE_MS
    );
    return () => window.clearInterval(timer);
  }, [paused, moments.length]);

  const active = moments[index];
  const mediaKind = useMemo(() => {
    if (!active) return "image";
    if (isStreamEmbed(active.media_url)) return "stream";
    return active.mime_type?.startsWith("video/") ? "video" : "image";
  }, [active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setIndex((current) => (current + 1) % Math.max(1, moments.length));
      if (event.key === "ArrowLeft") setIndex((current) => (current - 1 + moments.length) % Math.max(1, moments.length));
      if (event.key === " ") {
        event.preventDefault();
        setPaused((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moments.length]);

  if (accessRequired && slug) {
    return <EventAccessGate slug={slug} onUnlocked={() => {
      setAccessRequired(false);
      setAccessVersion((value) => value + 1);
    }} />;
  }

  if (notFound) {
    return <div className="flex min-h-screen items-center justify-center">{t("eventNotFound")}</div>;
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_top,#d9775730,transparent_50%)]" />
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 bg-gradient-to-b from-black/80 to-transparent p-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:p-6">
        <div className="flex shrink-0 items-center gap-1.5" aria-label="Moments">
          <BrandMark className="h-6 w-6 shrink-0" />
          <span className="font-display text-sm font-semibold">Moments</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            className="rounded-full border border-white/20 bg-black/30 px-3 py-2 font-mono text-xs backdrop-blur"
          >
            {paused ? t("resumeSlideshow") : t("pauseSlideshow")}
          </button>
          <Link to={`/e/${encodeURIComponent(slug ?? "")}`} className="rounded-full border border-white/20 bg-black/30 px-3 py-2 font-mono text-xs backdrop-blur">
            {t("closeSlideshow")}
          </Link>
        </div>
      </header>

      <div className="relative z-10 flex min-h-screen items-center justify-center p-4 pt-24 pb-20 sm:p-12 sm:pt-28">
        {!active ? (
          <div className="max-w-md text-center">
            <img
              src={waitingIllustration}
              alt=""
              className="mx-auto aspect-[3/2] w-full rounded-3xl border border-white/10 object-cover shadow-2xl shadow-orange-950/30"
            />
            <p className="mt-5 text-lg text-white/70">{t("slideshowWaiting")}</p>
          </div>
        ) : (
          <figure key={active.id} className="animate-hero-rise flex max-h-[75vh] max-w-6xl flex-col items-center">
            {mediaKind === "stream" ? (
              <iframe src={active.media_url} allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowFullScreen className="aspect-video max-h-[68vh] w-[min(90vw,1100px)] rounded-2xl border border-white/10 bg-black shadow-2xl" title={active.caption ?? t("videoMoment")} />
            ) : mediaKind === "video" ? (
              <video src={active.media_url} autoPlay muted loop playsInline controls className="max-h-[68vh] max-w-[92vw] rounded-2xl border border-white/10 bg-black object-contain shadow-2xl" />
            ) : (
              <img src={active.media_url} alt={active.caption ?? ""} className="max-h-[68vh] max-w-[92vw] rounded-2xl border border-white/10 object-contain shadow-2xl" />
            )}
            <figcaption className="mt-5 max-w-2xl text-center">
              {active.caption && <p className="text-lg sm:text-xl">{active.caption}</p>}
              <p className="mt-1 font-mono text-xs text-white/55">{t("sharedBy", { name: active.uploader_name })}</p>
            </figcaption>
          </figure>
        )}
      </div>

      {moments.length > 0 && (
        <footer className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-3 bg-gradient-to-t from-black/80 to-transparent p-5 font-mono text-xs text-white/60">
          <button type="button" onClick={() => setIndex((value) => (value - 1 + moments.length) % moments.length)} aria-label={t("previousMoment")}>←</button>
          <span>{index + 1} / {moments.length}</span>
          <button type="button" onClick={() => setIndex((value) => (value + 1) % moments.length)} aria-label={t("nextMoment")}>→</button>
        </footer>
      )}
    </main>
  );
}
