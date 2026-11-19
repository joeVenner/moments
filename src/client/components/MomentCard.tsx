import { useEffect, useState } from "react";
import type { MomentData } from "../lib/types";
import { toggleMomentReaction } from "../lib/api";
import { gridPhotoSources, videoPoster } from "../lib/gridImage";

// Admin URLs carry a signed ?mv= view query, so match the path part only.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(?:\?|$)/i;

function isVideoMoment(moment: PendingMoment): boolean {
  const mime = moment.mime_type ?? moment._mimeType;
  if (mime) return mime.startsWith("video/");
  return VIDEO_EXT.test(moment.media_url);
}

function isStreamMoment(moment: PendingMoment): boolean {
  return moment.media_url.includes(".cloudflarestream.com/") && moment.media_url.includes("/iframe");
}

/** "12 MB" / "1.4 GB" — null when the size was never recorded (older uploads). */
function formatSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export interface PendingMoment extends MomentData {
  _pending?: boolean;
  _mimeType?: string;
  /** Upload progress 0..1 for large resumable uploads (undefined = indeterminate). */
  _progress?: number;
}

export function MomentCard({ moment, index = 0, slug }: { moment: PendingMoment; index?: number; slug?: string }) {
  const [activated, setActivated] = useState(false);
  // Which of the photo's images is shown: a broken thumbnail moves on to the
  // original once (gridPhotoSources), never back and forth.
  const [photoSourceIndex, setPhotoSourceIndex] = useState(0);
  const photoSources = gridPhotoSources(moment);
  const photoSource = photoSources[Math.min(photoSourceIndex, photoSources.length - 1)];
  const poster = videoPoster(moment);
  // The URL whose still failed: a changed poster gets its own try.
  const [failedPoster, setFailedPoster] = useState<string | null>(null);
  const [reactionCount, setReactionCount] = useState(moment.reaction_count ?? 0);
  const [reacted, setReacted] = useState(Boolean(moment.reacted));
  const [reacting, setReacting] = useState(false);
  const video = isVideoMoment(moment);
  const stream = isStreamMoment(moment);
  const sizeLabel = formatSize(moment.size_bytes);
  const pendingPercent = Math.round((moment._progress ?? 0) * 100);
  const pendingPercentLabel = (moment._progress ?? 0) > 0 && pendingPercent === 0 ? "<1%" : `${pendingPercent}%`;
  useEffect(() => {
    setReactionCount(moment.reaction_count ?? 0);
    setReacted(Boolean(moment.reacted));
  }, [moment.id, moment.reaction_count, moment.reacted]);
  // Stagger the pop-in so the grid fills in like a cascade rather than all at
  // once. Cap the delay so a long feed doesn't make late items lag on scroll.
  const delay = `${Math.min(index, 8) * 40}ms`;

  // Heavy-file rule (feed perf Stage 1): a video never mounts its <video> on
  // render — that would pull bytes/metadata for every card the moment the feed
  // opens. Instead we show a neutral placeholder tile (accent play triangle)
  // plus the file size when we know it, and only mount the real <video src>
  // once the user taps it (autoplay). Range support on /media/* lets the
  // browser seek without re-downloading the whole file.
  const showVideoPlaceholder = video && (!activated || moment._pending);

  return (
    <div
      style={{ animationDelay: delay }}
      className="animate-pop-in relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] transition-transform duration-150 ease-out active:scale-95 hover:scale-[1.02]"
    >
      {showVideoPlaceholder ? (
        <button
          type="button"
          onClick={() => setActivated(true)}
          aria-label="Play video"
          className="group relative block aspect-square w-full bg-[var(--color-bg)]"
        >
          {stream ? (
            <img
              src={moment.media_url.replace("/iframe", "/thumbnails/thumbnail.jpg?height=480&fit=crop")}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover opacity-70"
            />
          ) : poster && poster !== failedPoster && !moment._pending ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              // Without a usable still the plain placeholder stays.
              onError={() => setFailedPoster(poster)}
              className="absolute inset-0 h-full w-full object-cover opacity-70"
            />
          ) : null}
          {/* Subtle diagonal scan-lines so the placeholder reads as "video, tap to play". */}
          <div
            className="absolute inset-0 opacity-[0.08]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, var(--color-text) 0, var(--color-text) 1px, transparent 1px, transparent 9px)",
            }}
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow-lg transition group-hover:scale-110">
              <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </span>
          {sizeLabel && (
            <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
              {sizeLabel}
            </span>
          )}
        </button>
      ) : stream ? (
        <iframe
          src={`${moment.media_url}?autoplay=true`}
          title={moment.caption ?? `Video by ${moment.uploader_name}`}
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          className="aspect-square w-full border-0 bg-black"
        />
      ) : video ? (
        <video
          src={moment.media_url}
          controls
          autoPlay
          className="aspect-square w-full bg-black object-cover"
        />
      ) : (
        <img
          src={photoSource}
          alt={moment.caption ?? `Photo by ${moment.uploader_name}`}
          loading="lazy"
          decoding="async"
          onError={() => setPhotoSourceIndex((current) => (current + 1 < photoSources.length ? current + 1 : current))}
          className={`aspect-square w-full object-cover ${moment._pending ? "opacity-60" : ""}`}
        />
      )}
      {moment._pending && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {moment._progress != null ? (
            // Real per-part progress for large resumable uploads — a thin accent
            // bar across the bottom of the card, plus the percentage.
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 p-2">
              <span className="font-mono text-[10px] text-white">
                {pendingPercentLabel}
              </span>
              <div className="h-1 w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-150 ease-out"
                  style={{ width: `${Math.max(pendingPercent, moment._progress > 0 ? 1 : 0)}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
        </div>
      )}
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-mono text-xs font-medium text-[var(--color-accent-dark)]">
            {moment.uploader_name}
          </p>
          {slug && !moment._pending && (
            <button
              type="button"
              disabled={reacting}
              aria-label={reacted ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={reacted}
              onClick={() => {
                setReacting(true);
                void toggleMomentReaction(slug, moment.id)
                  .then((result) => {
                    setReacted(result.reacted);
                    setReactionCount(result.reaction_count);
                  })
                  // Refused (rate limit, or join required) or offline: the heart
                  // keeps its current state, which is still what the server has.
                  .catch(() => {})
                  .finally(() => setReacting(false));
              }}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-mono text-[10px] transition ${reacted ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"}`}
            >
              <span aria-hidden>{reacted ? "♥" : "♡"}</span>
              {reactionCount}
            </button>
          )}
        </div>
        {moment.caption && <p className="mt-1 text-sm text-[var(--color-text)]">{moment.caption}</p>}
      </div>
    </div>
  );
}
