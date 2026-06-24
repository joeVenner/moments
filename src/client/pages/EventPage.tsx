import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getEvent, listMoments, uploadMoment } from "../lib/api";
import { getNickname, setNickname as saveNickname } from "../lib/nickname";
import type { EventData, MomentData } from "../lib/types";
import { NicknameGate } from "../components/NicknameGate";
import { UploadDropzone } from "../components/UploadDropzone";
import { MomentCard } from "../components/MomentCard";
import { PointsToast } from "../components/Toast";

export default function EventPage() {
  const { slug } = useParams<{ slug: string }>();
  const [event, setEvent] = useState<EventData | null>(null);
  const [moments, setMoments] = useState<MomentData[]>([]);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toastPoints, setToastPoints] = useState<number | null>(null);

  useEffect(() => {
    if (!slug) return;
    setNicknameState(getNickname(slug));
    Promise.all([getEvent(slug), listMoments(slug)])
      .then(([eventRes, momentsRes]) => {
        setEvent(eventRes.event);
        setMoments(momentsRes.moments);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleUpload(file: File, caption: string) {
    if (!slug || !nickname) return;
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("uploader_name", nickname);
      if (caption) formData.append("caption", caption);
      const { moment, points_awarded } = await uploadMoment(slug, formData);
      setMoments((prev) => [moment, ...prev]);
      setToastPoints(points_awarded);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  }

  if (notFound || !event) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Event not found.
      </div>
    );
  }

  if (!nickname) {
    return (
      <NicknameGate
        event={event}
        onSubmit={(name) => {
          saveNickname(slug!, name);
          setNicknameState(name);
        }}
      />
    );
  }

  const myPoints = moments
    .filter((m) => m.uploader_name === nickname)
    .reduce((sum, m) => sum + m.points_awarded, 0);

  return (
    <div className="min-h-screen bg-[var(--color-bg)] pb-12">
      {toastPoints !== null && (
        <PointsToast points={toastPoints} onDone={() => setToastPoints(null)} />
      )}

      <header className="border-b border-slate-200 bg-[var(--color-bg-alt)] px-4 py-6 text-center">
        <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
          {event.type}
        </p>
        <h1 className="text-xl font-semibold text-slate-900">{event.title}</h1>
        {event.main_characters && <p className="text-sm text-slate-600">{event.main_characters}</p>}
        <p className="mt-2 font-mono text-xs text-slate-500">
          Hi {nickname} · Your points: <span className="font-semibold text-[var(--color-accent-dark)]">{myPoints}</span>
        </p>
      </header>

      <div className="mx-auto max-w-xl px-4 py-6">
        <UploadDropzone onUpload={handleUpload} uploading={uploading} />
        {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moments.map((moment) => (
            <MomentCard key={moment.id} moment={moment} />
          ))}
        </div>
        {moments.length === 0 && (
          <p className="mt-8 text-center text-sm text-slate-500">
            No moments yet — be the first to share one!
          </p>
        )}
      </div>
    </div>
  );
}
