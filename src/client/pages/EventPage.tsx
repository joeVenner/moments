import { GUEST_REQUIRED_EVENT, GuestRequiredError, refusalAction, type GuestRequiredDetail } from "../lib/guestRequired";
import { forgetGuest } from "../lib/webLeave";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getEvent,
  getUploadCapabilities,
  listMoments,
  joinEvent,
  DIRECT_UPLOAD_MAX_BYTES,
  AccessRequiredError,
  unlockEvent,
} from "../lib/api";
import {
  resumableUploadMoment,
  UploadAlreadyRunningError,
  UploadInterruptedError,
} from "../lib/multipartUpload";
import { ACTIVE_UPLOAD_STATUSES, findResumableUpload, getUploadFile, listUploads } from "../lib/uploadStore";
import { useUploadWakeLock } from "../lib/useUploadWakeLock";
import { clearNickname, getGuestToken, getNickname, setNickname as saveNickname } from "../lib/nickname";
import { rejoinIfTokenless, sessionRejoinFlags } from "../lib/guestRejoin";
import type { EventData } from "../lib/types";
import { NicknameGate, type JoinProblem } from "../components/NicknameGate";
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
import { PAGE_RESUME_EVENT } from "../lib/uploadSync";
import { UploadManager } from "../components/UploadManager";
import { LeaveEventButton } from "../components/LeaveEventButton";
import { EventAccessGate } from "../components/EventAccessGate";
import { Highlights } from "../components/Highlights";

// Server caps a feed page at 25 moments. Kept in one place so the client page
// math and the worker default stay in sync (the worker clamps its own limit to
// [1,100], so this is the contracted page size the nav is built against).
const PAGE_SIZE = 25;
const MAX_FILE_UPLOADS = 2;

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Keyed on the slug so moving from one event to another (/e/a → /e/b, which
 * React Router renders with the same element) starts with fresh state.
 * Before, the previous event's "not found", access prompt, tab, upload state
 * and in-flight join could carry over into the next one.
 */
export default function EventPage() {
  const { slug } = useParams<{ slug: string }>();
  return <EventPageForSlug key={slug} />;
}

function EventPageForSlug() {
  const { t } = useI18n();
  const { slug } = useParams<{ slug: string }>();
  const [event, setEvent] = useState<EventData | null>(null);
  const [moments, setMoments] = useState<PendingMoment[]>([]);
  const [nickname, setNicknameState] = useState<string | null>(null);
  // Whether this browser holds the guest's token (what "Leave" needs). State,
  // not a render-time read: a background rejoin can issue it later.
  const [hasGuestToken, setHasGuestToken] = useState(false);
  const isLeavingRef = useRef(false);
  const isForgettingRef = useRef(false);
  // Why the nickname prompt is back (another device owns the saved name).
  const [gateProblem, setGateProblem] = useState<JoinProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessVersion, setAccessVersion] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [toastPoints, setToastPoints] = useState<number | null>(null);
  const [milestoneReached, setMilestoneReached] = useState<number | null>(null);
  const [tab, setTab] = useState<"feed" | "highlights" | "leaderboard">("feed");
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

  // The server refused this guest's token (they left from another tab, or
  // the event was reset): forget them here and ask them to join again.
  useEffect(() => {
    if (!slug) return;
    let isCurrent = true;
    const onRefused = (event: Event) => {
      const detail = (event as CustomEvent<GuestRequiredDetail>).detail;
      // During a Leave the server revokes the token before this page forgets
      // it: a request refused in that window is the leave, not a problem.
      // Parallel part uploads can also report the same refusal several times.
      if (detail?.slug !== slug || isLeavingRef.current || isForgettingRef.current) return;
      const action = refusalAction(detail, getGuestToken(slug));
      if (action === "ignore") return;
      const showGate = () => {
        isForgettingRef.current = false;
        if (!isCurrent) return;
        setNicknameState(null);
        setHasGuestToken(false);
        setGateProblem("guest_required");
        setMyPoints(0);
        setUploadError(null);
      };
      isForgettingRef.current = true;
      if (action === "gate") showGate();
      else void forgetGuest(slug).finally(showGate);
    };
    window.addEventListener(GUEST_REQUIRED_EVENT, onRefused);
    return () => {
      isCurrent = false;
      window.removeEventListener(GUEST_REQUIRED_EVENT, onRefused);
    };
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    let isCurrent = true;
    const name = getNickname(slug);
    setNicknameState(name);
    setHasGuestToken(getGuestToken(slug) !== null);
    setGateProblem(null);
    setMoments([]);
    setPage(1);
    setTotal(0);
    setMyPoints(0);
    void getUploadCapabilities()
      .then((capabilities) => setStreamEnabled(capabilities.stream_tus))
      .catch(() => setStreamEnabled(false));
    const inviteToken = new URLSearchParams(window.location.search).get("invite");
    const unlock = inviteToken ? unlockEvent(slug, { invite_token: inviteToken }) : Promise.resolve();
    unlock.then(() => {
      if (inviteToken) window.history.replaceState({}, "", window.location.pathname);
      return Promise.all([
        getEvent(slug),
        listMoments(slug, { limit: PAGE_SIZE, offset: 0, uploaderName: name ?? undefined }),
      ]);
    })
      .then(([eventRes, momentsRes]) => {
        setAccessRequired(false);
        setEvent(eventRes.event);
        setMoments(momentsRes.moments);
        setTotal(momentsRes.total ?? 0);
        setMyPoints(momentsRes.your_points ?? 0);
        // After the event loaded (a private event is unlocked by now): a saved
        // nickname without a guest token joins again in the background.
        if (!name) return;
        void rejoinIfTokenless(slug, name, { getGuestToken, join: joinEvent, ...sessionRejoinFlags }).then((problem) => {
          if (isCurrent) setHasGuestToken(getGuestToken(slug) !== null);
          if (problem !== "nickname_taken") return;
          // Cleared even if this effect is stale: the "tried" flag is spent, so
          // the next run must find no nickname and show the prompt.
          clearNickname(slug);
          if (!isCurrent) return;
          setNicknameState(null);
          setGateProblem(problem);
        });
      })
      .catch((error) => {
        if (error instanceof AccessRequiredError || error instanceof Error && error.message.includes("access")) {
          setAccessRequired(true);
        } else {
          setNotFound(true);
        }
      })
      .finally(() => setLoading(false));
    return () => {
      isCurrent = false;
    };
  }, [slug, accessVersion]);

  // Resume staged files on cold start, when connectivity returns, and when iOS
  // gives the page execution time again. Background Sync covers browsers that
  // support it; this path is the universal fallback.
  useEffect(() => {
    if (!slug || !nickname) return;
    let disposed = false;
    let running = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshFeed = async () => {
      const response = await listMoments(slug, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        uploaderName: nickname,
      });
      if (disposed) return;
      setMoments(response.moments);
      setTotal(response.total ?? 0);
      setMyPoints(response.your_points ?? 0);
    };

    const resumeStaged = async () => {
      if (disposed || running || !navigator.onLine) return;
      running = true;
      let completed = false;
      let shouldRetry = false;
      try {
        const uploads = (await listUploads(slug)).sort((a, b) => a.createdAt - b.createdAt);
        for (const upload of uploads.filter((row) => ACTIVE_UPLOAD_STATUSES.has(row.status))) {
          if (disposed) break;
          const file = await getUploadFile(upload);
          if (!file) continue;
          setUploading(true);
          try {
            if (upload.backend === "stream") {
              if (!streamEnabled) {
                shouldRetry = true;
                continue;
              }
              const { streamUploadMoment } = await import("../lib/streamUpload");
              await streamUploadMoment({
                slug,
                file,
                caption: upload.caption ?? "",
                uploaderName: upload.uploaderName,
                resume: upload,
              });
            } else {
              await resumableUploadMoment({
                slug,
                file,
                caption: upload.caption ?? "",
                uploaderName: upload.uploaderName,
                resume: upload,
              });
            }
            completed = true;
          } catch (error) {
            if (
              !(error instanceof UploadAlreadyRunningError) &&
              !(error instanceof GuestRequiredError) &&
              (!(error instanceof Error) || error.name !== "StreamUploadAlreadyRunningError")
            ) {
              shouldRetry = true;
            }
          }
        }
        if (completed) await refreshFeed();
      } finally {
        running = false;
        if (!disposed) setUploading(false);
        if (shouldRetry && !disposed) retryTimer = setTimeout(() => void resumeStaged(), 15_000);
      }
    };

    const onOnline = () => void resumeStaged();
    const onVisible = () => {
      if (document.visibilityState === "visible") void resumeStaged();
    };
    const onServiceWorkerComplete = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string }>).detail;
      if (!detail?.slug || detail.slug === slug) void refreshFeed();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener(PAGE_RESUME_EVENT, onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("moment-upload-completed", onServiceWorkerComplete);
    void resumeStaged();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener(PAGE_RESUME_EVENT, onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("moment-upload-completed", onServiceWorkerComplete);
    };
  }, [slug, nickname, page, streamEnabled]);

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
    // Ask the browser not to evict staged upload files under storage pressure.
    // This is best-effort and intentionally happens during the user's click.
    void navigator.storage?.persist?.().catch(() => false);

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
          _progress: 0,
        })),
        ...prev,
      ]);
    }

    const results = await mapSettledWithConcurrency(
      pending,
      MAX_FILE_UPLOADS,
      async ({ file, tempId }) => {
        const effectiveFile = file;

        // Every moment uses the durable multipart queue. A small file is a valid
        // one-part multipart upload, so photos now get the same resume, manager,
        // retry, and cancellation behavior as large videos.
        const resume = await findResumableUpload(slug, effectiveFile);
        const progress = (loaded: number, total: number) => {
          const up = total > 0 ? loaded / total : 0;
          setMoments((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, _progress: up } : m))
          );
        };
        const useStream = resume?.backend === "stream" || (!resume && streamEnabled && effectiveFile.type.startsWith("video/"));
        const result = useStream
          ? await import("../lib/streamUpload").then(({ streamUploadMoment }) => streamUploadMoment({
              slug,
              file: effectiveFile,
              caption,
              uploaderName: nickname,
              resume,
              onProgress: progress,
            }))
          : await resumableUploadMoment({
              slug,
              file: effectiveFile,
              caption,
              uploaderName: nickname,
              resume,
              onProgress: progress,
            });
        setMoments((prev) => prev.map((m) => (m.id === tempId ? result.moment : m)));
        return result.points_awarded;
      }
    );

    let totalPoints = 0;
    let failures = 0;
    const pausedNames: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        totalPoints += result.value;
      } else {
        const reason = result.reason;
        if (reason instanceof UploadInterruptedError || reason?.name === "StreamUploadInterruptedError") {
          // The durable queue owns it now and will retry automatically.
          pausedNames.push(pending[i].file.name);
        } else if (
          !(reason instanceof UploadAlreadyRunningError) &&
          reason?.name !== "StreamUploadAlreadyRunningError" &&
          !(reason instanceof GuestRequiredError && refusalAction(reason, getGuestToken(slug)) !== "ignore")
        ) {
          // A guest_required refusal that sends the guest to the gate isn't
          // counted; one for an older token (another tab rejoined) is a failure.
          failures += 1;
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
    // A paused upload isn't a hard failure; it remains staged locally.
    if (pausedNames.length > 0) {
      const pausedMsg = t("uploadPaused", { name: pausedNames[0] });
      setUploadError((prev) => (prev ? `${prev} · ${pausedMsg}` : pausedMsg));
    }
    setUploading(false);
  }

  if (accessRequired && slug) {
    return <EventAccessGate slug={slug} onUnlocked={() => {
      setLoading(true);
      setAccessVersion((value) => value + 1);
    }} />;
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
            <div className="flex items-center gap-2">
              <p className="font-mono text-xs">
                <span className="text-[var(--color-text-muted)]">{t("yourPoints")} </span>
                <span className="font-semibold text-[var(--color-accent-dark)]">{myPoints}</span>
              </p>
              {/* Only a guest with a token owns anything to delete. */}
              {hasGuestToken && (
                <LeaveEventButton
                  slug={slug!}
                  onLeavingChange={(isLeaving) => {
                    isLeavingRef.current = isLeaving;
                  }}
                  disabled={uploading}
                  onLeft={() => {
                    // Requests still in flight from before the leave come back refused:
                    // ignore them until this browser joins again.
                    isLeavingRef.current = true;
                    setNicknameState(null);
                    setHasGuestToken(false);
                    setGateProblem(null);
                    setMyPoints(0);
                    setParticipantVersion((v) => v + 1);
                    // Their moments are gone: show the feed without them.
                    listMoments(slug!, { limit: PAGE_SIZE, offset: 0 })
                      .then((res) => {
                        setMoments(res.moments);
                        setTotal(res.total ?? 0);
                        setPage(1);
                      })
                      .catch(() => {});
                  }}
                />
              )}
            </div>
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
          <button
            onClick={() => setTab("highlights")}
            className={`flex-1 rounded-full py-2 transition ${
              tab === "highlights"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
            }`}
          >
            {t("highlightsTab")}
          </button>
        </div>

        <div className="mt-3 flex justify-end">
          <Link
            to={`/e/${encodeURIComponent(slug!)}/slideshow`}
            data-spark
            className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-2 font-mono text-xs text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <span aria-hidden>▻</span>
            {t("openSlideshow")}
          </Link>
        </div>

        {tab === "leaderboard" ? (
          <div key="leaderboard" className="mt-6 animate-[fade-in_250ms_ease-out]">
            <Leaderboard slug={slug!} />
          </div>
        ) : tab === "highlights" ? (
          <div key="highlights" className="animate-[fade-in_250ms_ease-out]">
            <Highlights slug={slug!} />
          </div>
        ) : (
          <div key="feed" className="animate-[fade-in_250ms_ease-out]">
            {nickname && (
              <div className="mt-6">
                <UploadDropzone onUpload={handleUpload} uploading={uploading} />
                <UploadManager slug={slug!} />
                {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
              </div>
            )}

            <div ref={feedTopRef} className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {moments.map((moment, i) => (
                <MomentCard key={moment.id} moment={moment} index={i} slug={slug!} />
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
          initialProblem={gateProblem}
          onSubmit={async (name, avatarSeed) => {
            // Join first: a rate limit or a taken nickname keeps the form open
            // (the guest has no token yet). Other failures still let them in.
            const outcome = await joinEvent(slug!, name, avatarSeed);
            if (outcome === "rate_limited" || outcome === "nickname_taken") return outcome;
            saveNickname(slug!, name);
            setNicknameState(name);
            setHasGuestToken(getGuestToken(slug!) !== null);
            isLeavingRef.current = false;
            setGateProblem(null);
            // Bump the strip so the new guest (and their avatar) show up
            // immediately without a page refresh. Also refetch page 1 with the
            // now-known nickname so `your_points` (any moments this guest
            // uploaded on another device/session under the same name) populates
            // the sticky points bar right away — otherwise a returning guest who
            // cleared localStorage would see 0 until a page nav/reload.
            setParticipantVersion((v) => v + 1);
            listMoments(slug!, { limit: PAGE_SIZE, offset: 0, uploaderName: name })
              .then((res) => {
                setMoments(res.moments);
                setTotal(res.total ?? 0);
                setMyPoints(res.your_points ?? 0);
                setPage(1);
              })
              .catch(() => {});
            return null;
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
