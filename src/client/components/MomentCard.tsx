import type { MomentData } from "../lib/types";

function isVideo(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(url);
}

export function MomentCard({ moment }: { moment: MomentData }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {isVideo(moment.media_url) ? (
        <video src={moment.media_url} controls className="aspect-square w-full object-cover" />
      ) : (
        <img
          src={moment.media_url}
          alt={moment.caption ?? `Photo by ${moment.uploader_name}`}
          loading="lazy"
          className="aspect-square w-full object-cover"
        />
      )}
      <div className="p-3">
        <p className="font-mono text-xs font-medium text-[var(--color-accent-dark)]">
          {moment.uploader_name}
        </p>
        {moment.caption && <p className="mt-1 text-sm text-slate-700">{moment.caption}</p>}
      </div>
    </div>
  );
}
