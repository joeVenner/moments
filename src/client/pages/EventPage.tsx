import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getEvent,
  listMoments,
  uploadMoment,
  directUploadMoment,
  joinEvent,
  NATIVE_UPLOAD_MAX_BYTES,
  DIRECT_UPLOAD_MAX_BYTES,
} from "../lib/api";
import { getNickname, setNickname as saveNickname } from "../lib/nickname";
import type { EventData } from "../lib/types";
import { NicknameGate } from "../components/NicknameGate";
import { UploadDropzone } from "../components/UploadDropzone";
import { MomentCard, type PendingMoment } from "../components/MomentCard";
import { PointsToast, MilestoneBanner } from "../components/Toast";
import { MomentCardSkeleton } from "../components/Skeleton";
import { ParticipantStrip } from "../components/ParticipantStrip";
import { Leaderboard } from "../components/Leaderboard";
import { pointsForContentType, highestMilestoneCrossed } from "../lib/points";
import { prefersReducedMotion } from "../lib/motion";
import { EventBannerScene } from "../lib/eventBanners";
import { useI18n } from "../lib/i18n";
import { EmptyCamera } from "../components/EmptyCamera";

export default function EventPage() {
  const { t } = useI18n();
  const { slug } = useParams<{ slug: string }>();
  const [event, setEvent] = useState<EventData | null>(null);
  const [moments, setMoments] = useState<PendingMoment[]>([]);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toastPoints, setToastPoints] = useState<number | null>(null);
  const [milestoneReached, setMilestoneReached] = useState<number | null>(null);
  const [tab, setTab] = useState<"feed" | "leaderboard">("feed");
  // Bumped after a join so the ParticipantStrip refetches immediately (a newly
  // joined guest otherwise wouldn't appear until a page refresh).
  const [participantVersion, setParticipantVersion] = useState(0);

  // Feed perf Stage 1 — offset-paginated infinite scroll. The server caps a page
  // at 25 moments; we append the next page when the sentinel scrolls into view.
  // `offsetRef`/`hasMoreRef`/`loadingMoreRef` back the IntersectionObserver so its
  // callback (a stale-ish closure) always reads fresh flags instead of captured
  // state, and so optimistic uploads (which prepend to `moments`) never shift
  // the server offset.
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slug) return;
    setNicknameState(getNickname(slug));
    setMoments([]);
    setHasMore(true);
    hasMoreRef.current = true;
    offsetRef.current = 0;
    Promise.all([getEvent(slug), listMoments(slug, { limit: 25, offset: 0 })])
      .then(([eventRes, momentsRes]) => {
        setEvent(eventRes.event);
        setMoments(momentsRes.moments);
        setHasMore(momentsRes.hasMore);
        hasMoreRef.current = momentsRes.hasMore;
        offsetRef.current = momentsRes.moments.length;
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  const loadMore = useCallback(async () => {
    if (!slug || loadingMoreRef.current || !hasMoreRef.current) return;
    setLoadingMore(true);
    loadingMoreRef.current = true;
    try {
      const res = await listMoments(slug, { limit: 25, offset: offsetRef.current });
      setMoments((prev) => [...prev, ...res.moments]);
      offsetRef.current += res.moments.length;
      hasMoreRef.current = res.hasMore;
      setHasMore(res.hasMore);
    } catch {
      hasMoreRef.current = false;
      setHasMore(false);
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [slug]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore();
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const myPoints = moments
    .filter((m) => m.uploader_name === nickname)
    .reduce((sum, m) => sum + m.points_awarded, 0);

  async function handleUpload(files: File[], caption: string) {
    if (!slug || !nickname || !event) return;
    const pointsBefore = myPoints;
    setUploadError(null);

    // Reject oversized files up front with a clear message. The presigned
    // path caps at 512MB server-side (presign.ts MAX_DIRECT_UPLOAD_BYTES); without
    // this guard a phone video over the cap would start "uploading" then fail
    // with a generic error. Skip them and report; upload the rest normally.
    const tooLarge = files.filter((f) => f.size > DIRECT_UPLOAD_MAX_BYTES);
    const accepted = files.filter((f) => f.size <= DIRECT_UPLOAD_MAX_BYTES);
    if (tooLarge.length > 0) {
      setUploadError(t("filesTooLarge", { skipped: tooLarge.length, maxMb: 512 }));
    }
    if (accepted.length === 0) {
      setUploading(false);
      return;
    }

    setUploading(true);

    const pending = accepted.map((file) => ({
      file,
      tempId: `pending-${crypto.randomUUID()}`,
      previewUrl: URL.createObjectURL(file),
    }));

    setMoments((prev) => [
      ...pending.map(({ file, tempId, previewUrl }) => ({
        id: tempId,
        event_id: event.id,
        uploader_name: nickname,
        media_url: previewUrl,
        caption: caption || null,
        points_awarded: pointsForContentType(file.type),
        created_at: new Date().toISOString(),
        size_bytes: file.size,
        mime_type: file.type || null,
        _pending: true,
        _mimeType: file.type,
      })),
      ...prev,
    ]);

    const results = await Promise.allSettled(
      pending.map(async ({ file, tempId }) => {
        // Files past the native cap can't fit the Worker's request body — send them
        // straight to R2 via a presigned PUT; everything else takes the multipart route.
        let result;
        if (file.size > NATIVE_UPLOAD_MAX_BYTES) {
          result = await directUploadMoment(slug, file, caption, nickname);
        } else {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("uploader_name", nickname);
          if (caption) formData.append("caption", caption);
          result = await uploadMoment(slug, formData);
        }
        setMoments((prev) => prev.map((m) => (m.id === tempId ? result.moment : m)));
        return result.points_awarded;
      })
    );

    let totalPoints = 0;
    let failures = 0;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        totalPoints += result.value;
      } else {
        failures += 1;
        setMoments((prev) => prev.filter((m) => m.id !== pending[i].tempId));
      }
    });
    pending.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));

    if (totalPoints > 0) {
      setToastPoints(totalPoints);
      const pointsAfter = pointsBefore + totalPoints;
      const milestone = highestMilestoneCrossed(pointsBefore, pointsAfter);
      if (milestone !== null) setMilestoneReached(milestone);
    }
    if (failures > 0) {
      const failMsg = t("uploadFailed", { failed: failures, total: pending.length });
      // Preserve the "too large" message if some files were skipped up front,
      // rather than overwriting it with the per-upload failure count.
      setUploadError((prev) => (prev ? `${prev} · ${failMsg}` : failMsg));
    }
    setUploading(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] px-4 py-10">
        <div className="mx-auto max-w-3xl">
          <div className="h-[40vh] min-h-[260px] animate-pulse overflow-hidden rounded-2xl bg-[var(--color-bg-alt)]" />
          <div className="mx-auto mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <MomentCardSkeleton />
            <MomentCardSkeleton />
            <MomentCardSkeleton />
            <MomentCardSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !event) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-text-muted)]">
        {t("eventNotFound")}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)] pb-12">
      {toastPoints !== null && (
        <PointsToast points={toastPoints} onDone={() => setToastPoints(null)} />
      )}
      {milestoneReached !== null && (
        <MilestoneBanner
          key={milestoneReached}
          points={milestoneReached}
          onDone={() => setMilestoneReached(null)}
        />
      )}

      <EventHero event={event} />

      {/* Sticky greeting + points bar — stays visible while the feed scrolls.
          Hidden until the guest has picked a nickname (it has nothing to show
          before then, and the nickname modal is covering the page anyway). */}
      {nickname && (
        <div className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-alt)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-bg-alt)]/80">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-2.5">
            <p className="truncate font-mono text-xs text-[var(--color-text-muted)]">
              {t("greetingName", { name: nickname })}
            </p>
            <p className="font-mono text-xs">
              <span className="text-[var(--color-text-muted)]">{t("yourPoints")} </span>
              <span className="font-semibold text-[var(--color-accent-dark)]">{myPoints}</span>
            </p>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* Event description — rendered as a dedicated, fully-readable block in the
            body rail (not crammed into the hero overlay). The hero keeps only the
            identity (type/title/characters); the description lives here where it has
            room and is clearly legible. The accent left-rule ties it to the brand. */}
        {event.description && (
          <div className="mb-6 border-l-2 border-[var(--color-accent)] pl-4">
            <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-text)] sm:text-[15px]">
              {event.description}
            </p>
          </div>
        )}

        <ParticipantStrip slug={slug!} version={participantVersion} />

        <div className="mt-4 flex gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-1 font-mono text-xs">
          <button
            onClick={() => setTab("feed")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 transition ${
              tab === "feed"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
            }`}
          >
            {t("feedTab")}
            {moments.length > 0 && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                  tab === "feed"
                    ? "bg-white/20"
                    : "bg-[var(--color-border)] text-[var(--color-text)]"
                }`}
              >
                {moments.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab("leaderboard")}
            className={`flex-1 rounded-full py-2 transition ${
              tab === "leaderboard"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
            }`}
          >
            {t("leaderboardTab")}
          </button>
        </div>

        {tab === "leaderboard" ? (
          <div key="leaderboard" className="mt-6 animate-[fade-in_250ms_ease-out]">
            <Leaderboard slug={slug!} />
          </div>
        ) : (
          <div key="feed" className="animate-[fade-in_250ms_ease-out]">
            {nickname && (
              <div className="mt-6">
                <UploadDropzone onUpload={handleUpload} uploading={uploading} />
                {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
              </div>
            )}

            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {moments.map((moment, i) => (
                <MomentCard key={moment.id} moment={moment} index={i} />
              ))}
            </div>
            {moments.length === 0 && (
              <div className="mt-12 text-center text-[var(--color-text-muted)]">
                <EmptyCamera className="mx-auto h-24 w-24 opacity-70" />
                <p className="mt-3 text-sm">{t("noMomentsYetBeFirst")}</p>
              </div>
            )}
            {/* Infinite-scroll sentinel + explicit control. The ref'd button is
                what the IntersectionObserver watches: it has real height (unlike
                the old empty grid), so auto-load on scroll fires reliably, AND it
                gives a visible, clickable way to reach the next page. Disabled
                while a page is loading. */}
            {hasMore && (
              <div ref={sentinelRef} className="mt-8 flex justify-center">
                <button
                  type="button"
                  onClick={() => loadMore()}
                  disabled={loadingMore}
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-5 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-60"
                >
                  {loadingMore ? t("loadingMore") : t("loadMore")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* First-visit nickname prompt as a modal over the page (hero/feed show
          behind the dimmed backdrop) rather than replacing the whole page. */}
      {!nickname && (
        <NicknameGate
          event={event}
          onSubmit={(name, avatarSeed) => {
            saveNickname(slug!, name);
            setNicknameState(name);
            // Join, then bump the strip so the new guest (and their avatar)
            // show up immediately without a page refresh.
            joinEvent(slug!, name, avatarSeed).finally(() =>
              setParticipantVersion((v) => v + 1)
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * Full-bleed event hero. The cover image is anchored to the TOP — the top of
 * the photo shows at the top of the page and the bottom tucks behind the
 * bottom-up scrim (object-top + a 24% below-the-fold overscan). A gentle scroll
 * parallax shifts the image up into that overscan, revealing lower parts
 * without ever exposing a gap. When there's no cover, a type-aware animated
 * banner scene takes its place (the default fallback). Title/type/characters
 * overlay the bottom on the scrim; the description lives in the body rail
 * below (where it has room to read in full). Parallax + the hero-rise
 * entrance are skipped under prefers-reduced-motion.
 */
function EventHero({ event }: { event: EventData }) {
  const { eventTypeLabel } = useI18n();
  const mediaRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();
  const hasCover = Boolean(event.cover_image_url);

  useEffect(() => {
    if (reduced || !hasCover) return;
    let raf = 0;
    function onScroll() {
      const el = mediaRef.current;
      if (!el) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Damped parallax: shift the image UP a fraction of the scroll distance,
        // revealing progressively lower parts. The image is overscanned 24%
        // below the fold, so this never exposes a gap — the top stays flush
        // and the bottom stays tucked behind the scrim.
        const y = Math.min(window.scrollY, 320) * 0.18;
        el.style.transform = `translate3d(0, -${y}px, 0)`;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [reduced, hasCover]);

  return (
    <div className="relative h-[40vh] min-h-[260px] w-full overflow-hidden bg-[var(--color-bg-alt)]">
      {/* Media layer. The cover image is anchored near the top (object-top) but
          nudged down ~10% so a sliver of the very top is cropped — gives the
          composition a little breathing room instead of jamming against the
          page edge. It's overscanned below the fold so the scroll-parallax can
          shift it up into that headroom without exposing a gap; the bottom
          tucks behind the scrim + overflow. The no-cover scene fills the box
          exactly (no parallax runs for it). */}
      <div ref={mediaRef} className="absolute inset-0 will-change-transform">
        {hasCover ? (
          <img
            src={event.cover_image_url!}
            alt={event.title}
            className="absolute left-0 -top-[10%] h-[132%] w-full object-cover object-top"
          />
        ) : (
          <EventBannerScene type={event.type} className="absolute inset-0 h-full w-full" />
        )}
      </div>

      {/* Legibility scrim + title block. Left-aligned inside the same max-w-3xl
          rail as the body so the title belongs to the banner, not the form. */}
      <div className="banner-scrim absolute inset-0" />
      <div className="absolute inset-x-0 bottom-0">
        <div className="mx-auto max-w-3xl px-4 pb-5 pt-16">
          <div className={reduced ? "" : "animate-hero-rise"}>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--color-accent)]">
              {eventTypeLabel(event.type)}
            </p>
            <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-[var(--color-text)] sm:text-4xl">
              {event.title}
            </h1>
            {event.main_characters && (
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{event.main_characters}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}