import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getEvent,
  listMoments,
  uploadMoment,
  joinEvent,
  NATIVE_UPLOAD_MAX_BYTES,
  DIRECT_UPLOAD_MAX_BYTES,
} from "../lib/api";
import {
  resumableUploadMoment,
  UploadInterruptedError,
} from "../lib/multipartUpload";
import { findResumableUpload } from "../lib/uploadStore";
import { useUploadWakeLock } from "../lib/useUploadWakeLock";
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

// Server caps a feed page at 25 moments. Kept in one place so the client page
// math and the worker default stay in sync (the worker clamps its own limit to
// [1,100], so this is the contracted page size the nav is built against).
const PAGE_SIZE = 25;

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

  // Feed pagination — numbered pages. The server caps a page at PAGE_SIZE
  // moments and returns `total` (event moment count) + `your_points` (this
  // guest's running point total, so the sticky points bar stays correct even
  // though `moments` now holds only the current page). Page state is explicit
  // (no IntersectionObserver): each page button fetches its own offset, so a
  // large feed can't get "stuck" the way the silent auto-load could.
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadingPage, setLoadingPage] = useState(false);
  const [myPoints, setMyPoints] = useState(0);
  const feedTopRef = useRef<HTMLDivElement>(null);

  // Keep the screen awake while a large upload is in flight so the OS doesn't
  // dim → throttle → kill the tab's upload. Foreground keep-alive only — see
  // useUploadWakeLock + multipartUpload.ts for the resumable-chunk fallback.
  useUploadWakeLock(uploading);

  useEffect(() => {
    if (!slug) return;
    const name = getNickname(slug);
    setNicknameState(name);
    setMoments([]);
    setPage(1);
    setTotal(0);
    setMyPoints(0);
    Promise.all([
      getEvent(slug),
      listMoments(slug, { limit: PAGE_SIZE, offset: 0, uploaderName: name ?? undefined }),
    ])
      .then(([eventRes, momentsRes]) => {
        setEvent(eventRes.event);
        setMoments(momentsRes.moments);
        setTotal(momentsRes.total ?? 0);
        setMyPoints(momentsRes.your_points ?? 0);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  const loadPage = useCallback(
    async (n: number) => {
      if (!slug) return;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (n < 1 || n > totalPages) return;
      setLoadingPage(true);
      try {
        const res = await listMoments(slug, {
          limit: PAGE_SIZE,
          offset: (n - 1) * PAGE_SIZE,
          uploaderName: nickname ?? undefined,
        });
        setMoments(res.moments);
        setTotal(res.total ?? 0);
        setMyPoints(res.your_points ?? 0);
        setPage(n);
        // Jump back to the top of the feed so the new page reads from the start,
        // not stranded mid-scroll. Honors reduced-motion.
        feedTopRef.current?.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
      } catch {
        // Leave the current page in place on a failed fetch; the user can retry.
      } finally {
        setLoadingPage(false);
      }
    },
    [slug, total, nickname]
  );

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

    // Optimistic cards only make sense on page 1 (newest-at-top). On any other
    // page a prepended pending card would be in the wrong place; the upload still
    // proceeds server-side and the moment appears when the guest returns to
    // page 1. The in-place replace/filter below are harmless no-ops when we
    // didn't prepend (the tempId isn't in `moments`).
    if (page === 1) {
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
    }

    const results = await Promise.allSettled(
      pending.map(async ({ file, tempId }) => {
        // Files past the native cap go through the resumable chunked path: the
        // file is split into 8 MiB parts PUT straight to R2, so an interruption
        // only costs one part and resumes from R2's ListParts on return. Small
        // files keep the simple native multipart route. If this file already has
        // an in-progress upload (paused earlier / re-picked after a reload),
        // resume it instead of starting over.
        let result;
        if (file.size > NATIVE_UPLOAD_MAX_BYTES) {
          const resume = await findResumableUpload(slug, file);
          result = await resumableUploadMoment({
            slug,
            file,
            caption,
            uploaderName: nickname,
            resume: resume ?? undefined,
            onProgress: (loaded, total) => {
              const frac = total > 0 ? loaded / total : 0;
              setMoments((prev) =>
                prev.map((m) => (m.id === tempId ? { ...m, _progress: frac } : m))
              );
            },
          });
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
    const pausedNames: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        totalPoints += result.value;
      } else {
        failures += 1;
        const reason = result.reason;
        if (reason instanceof UploadInterruptedError) {
          // The R2 upload is left open — the guest can resume by re-selecting
          // the file (findResumableUpload will rematch it). Keep the hint clear.
          pausedNames.push(pending[i].file.name);
        }
        setMoments((prev) => prev.filter((m) => m.id !== pending[i].tempId));
      }
    });
    pending.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));

    // Keep the sticky points bar + page count in sync with this session's
    // uploads. `myPoints` is now server-derived state (not a sum over the
    // current page), and `total` drives the page nav — both need a local bump
    // to stay correct without a refetch.
    if (totalPoints > 0) setMyPoints((p) => p + totalPoints);
    const successCount = results.filter((r) => r.status === "fulfilled").length;
    if (successCount > 0) setTotal((t) => t + successCount);

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
    // A paused upload isn't a hard failure — tell the guest exactly how to
    // resume (re-select the file; the chunked uploader skips parts R2 already has).
    if (pausedNames.length > 0) {
      const pausedMsg = t("uploadPaused", { name: pausedNames[0] });
      setUploadError((prev) => (prev ? `${prev} · ${pausedMsg}` : pausedMsg));
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

            <div ref={feedTopRef} className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
            {/* Numbered page nav. Renders nothing when the whole feed fits one
                page (totalPages <= 1). Disabled while a page is loading or while
                an upload is mid-flight (navigating away mid-upload would orphan
                the optimistic pending card). */}
            <Pagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              loading={loadingPage}
              disabled={uploading}
              onPage={(n) => loadPage(n)}
            />
            {/* End-of-feed marker on the last page — so a feed that fits in one
                page (or the final page of a long one) reads as "done," not
                "broken." */}
            {moments.length > 0 && page >= Math.max(1, Math.ceil(total / PAGE_SIZE)) && (
              <p className="mt-10 text-center font-mono text-xs text-[var(--color-text-muted)]">
                {t("endOfFeed")}
              </p>
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
            // show up immediately without a page refresh. Also refetch page 1
            // with the now-known nickname so `your_points` (any moments this
            // guest uploaded on another device/session under the same name)
            // populates the sticky points bar right away — otherwise a returning
            // guest who cleared localStorage would see 0 until a page nav/reload.
            joinEvent(slug!, name, avatarSeed).finally(() => {
              setParticipantVersion((v) => v + 1);
              listMoments(slug!, { limit: PAGE_SIZE, offset: 0, uploaderName: name })
                .then((res) => {
                  setMoments(res.moments);
                  setTotal(res.total ?? 0);
                  setMyPoints(res.your_points ?? 0);
                  setPage(1);
                })
                .catch(() => {});
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * Numbered page nav for the feed. Windowed so it stays compact even for a large
 * event: always shows the first and last page, the current page ±1, with
 * ellipses for the gaps; when there are ≤7 pages it just shows them all.
 * Renders nothing when the whole feed fits one page. `disabled` is set while an
 * upload is mid-flight so a page change can't orphan an optimistic pending card.
 */
function Pagination({
  page,
  total,
  pageSize,
  loading,
  disabled,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  loading: boolean;
  disabled: boolean;
  onPage: (n: number) => void;
}) {
  const { t } = useI18n();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  let items: (number | "ellipsis")[];
  if (totalPages <= 7) {
    items = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    items = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    if (start > 2) items.push("ellipsis");
    for (let i = start; i <= end; i++) items.push(i);
    if (end < totalPages - 1) items.push("ellipsis");
    items.push(totalPages);
  }

  const baseBtn =
    "h-9 min-w-9 rounded-full px-3 text-sm transition disabled:opacity-40 disabled:cursor-not-allowed";
  const inactive = `${baseBtn} border border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]`;
  const active = `${baseBtn} bg-[var(--color-accent)] font-semibold text-white`;

  return (
    <nav className="mt-8 flex flex-wrap items-center justify-center gap-2 font-mono">
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={disabled || loading || page === 1}
        className={inactive}
        aria-label={t("pagePrev")}
      >
        ←
      </button>
      {items.map((it, i) =>
        it === "ellipsis" ? (
          <span key={`e${i}`} className="px-1 text-[var(--color-text-muted)]">
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            onClick={() => onPage(it)}
            disabled={disabled || loading}
            className={it === page ? active : inactive}
          >
            {it}
          </button>
        )
      )}
      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={disabled || loading || page === totalPages}
        className={inactive}
        aria-label={t("pageNext")}
      >
        →
      </button>
    </nav>
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