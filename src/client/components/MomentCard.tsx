import { useState } from "react";
import type { MomentData } from "../lib/types";

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

function isVideoMoment(moment: PendingMoment): boolean {
  const mime = moment.mime_type ?? moment._mimeType;
  if (mime) return mime.startsWith("video/");
  return VIDEO_EXT.test(moment.media_url);
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
}

export function MomentCard({ moment, index = 0 }: { moment: PendingMoment; index?: number }) {
  const [activated, setActivated] = useState(false);
  const video = isVideoMoment(moment);
  const sizeLabel = formatSize(moment.size_bytes);
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
      ) : video ? (
        <video
          src={moment.media_url}
          controls
          autoPlay
          className="aspect-square w-full bg-black object-cover"
        />
      ) : (
        <img
          src={moment.media_url}
          alt={moment.caption ?? `Photo by ${moment.uploader_name}`}
          loading="lazy"
          decoding="async"
          className={`aspect-square w-full object-cover ${moment._pending ? "opacity-60" : ""}`}
        />
      )}
      {moment._pending && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
        </div>
      )}
      <div className="p-3">
        <p className="font-mono text-xs font-medium text-[var(--color-accent-dark)]">
          {moment.uploader_name}
        </p>
        {moment.caption && <p className="mt-1 text-sm text-[var(--color-text)]">{moment.caption}</p>}
      </div>
    </div>
  );
}
