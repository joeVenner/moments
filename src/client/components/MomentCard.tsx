import type { MomentData } from "../lib/types";

function isVideo(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(url);
}

export interface PendingMoment extends MomentData {
  _pending?: boolean;
  _mimeType?: string;
}

export function MomentCard({ moment }: { moment: PendingMoment }) {
  const video = moment._mimeType ? moment._mimeType.startsWith("video/") : isVideo(moment.media_url);
  return (
    <div className="animate-pop-in relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] transition-transform duration-150 ease-out active:scale-95 hover:scale-[1.02]">
      {video ? (
        <video src={moment.media_url} controls className="aspect-square w-full object-cover" />
      ) : (
        <img
          src={moment.media_url}
          alt={moment.caption ?? `Photo by ${moment.uploader_name}`}
          loading="lazy"
          className={`aspect-square w-full object-cover ${moment._pending ? "opacity-60" : ""}`}
        />
      )}
      {moment._pending && (
        <div className="absolute inset-0 flex items-center justify-center">
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
