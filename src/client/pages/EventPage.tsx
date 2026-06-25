import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getEvent, listMoments, uploadMoment, joinEvent } from "../lib/api";
import { getNickname, setNickname as saveNickname } from "../lib/nickname";
import type { EventData } from "../lib/types";
import { NicknameGate } from "../components/NicknameGate";
import { UploadDropzone } from "../components/UploadDropzone";
import { MomentCard, type PendingMoment } from "../components/MomentCard";
import { PointsToast } from "../components/Toast";
import { MomentCardSkeleton } from "../components/Skeleton";
import { ParticipantStrip } from "../components/ParticipantStrip";
import { Leaderboard } from "../components/Leaderboard";
import { pointsForContentType } from "../lib/points";
import { useI18n } from "../lib/i18n";
import emptyFeed from "../assets/empty-feed.png";

export default function EventPage() {
  const { t, eventTypeLabel } = useI18n();
  const { slug } = useParams<{ slug: string }>();
  const [event, setEvent] = useState<EventData | null>(null);
  const [moments, setMoments] = useState<PendingMoment[]>([]);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toastPoints, setToastPoints] = useState<number | null>(null);
  const [tab, setTab] = useState<"feed" | "leaderboard">("feed");

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

  async function handleUpload(files: File[], caption: string) {
    if (!slug || !nickname || !event) return;
    setUploadError(null);
    setUploading(true);

    const pending = files.map((file) => ({
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
        _pending: true,
        _mimeType: file.type,
      })),
      ...prev,
    ]);

    const results = await Promise.allSettled(
      pending.map(async ({ file, tempId }) => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("uploader_name", nickname);
        if (caption) formData.append("caption", caption);
        const { moment, points_awarded } = await uploadMoment(slug, formData);
        setMoments((prev) => prev.map((m) => (m.id === tempId ? moment : m)));
        return points_awarded;
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

    if (totalPoints > 0) setToastPoints(totalPoints);
    if (failures > 0) {
      setUploadError(t("uploadFailed", { failed: failures, total: files.length }));
    }
    setUploading(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] px-4 py-10">
        <div className="mx-auto max-w-xl animate-pulse">
          <div className="mx-auto h-4 w-16 rounded bg-slate-200" />
          <div className="mx-auto mt-3 h-6 w-2/3 rounded bg-slate-200" />
        </div>
        <div className="mx-auto mt-10 grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
          <MomentCardSkeleton />
          <MomentCardSkeleton />
          <MomentCardSkeleton />
        </div>
      </div>
    );
  }

  if (notFound || !event) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        {t("eventNotFound")}
      </div>
    );
  }

  if (!nickname) {
    return (
      <NicknameGate
        event={event}
        onSubmit={(name, avatarSeed) => {
          saveNickname(slug!, name);
          setNicknameState(name);
          joinEvent(slug!, name, avatarSeed);
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

      <header className="border-b border-slate-200 bg-[var(--color-bg-alt)]">
        {event.cover_image_url ? (
          <img
            src={event.cover_image_url}
            alt={event.title}
            className="h-28 w-full object-cover sm:h-36"
          />
        ) : (
          <div className="h-28 w-full bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-dark)] sm:h-36" />
        )}
        <div className="px-4 py-6 text-center">
          <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-accent)]">
            {eventTypeLabel(event.type)}
          </p>
          <h1 className="text-xl font-semibold text-slate-900">{event.title}</h1>
          {event.main_characters && <p className="text-sm text-slate-600">{event.main_characters}</p>}
          <p className="mt-2 font-mono text-xs text-slate-500">
            {t("greetingName", { name: nickname })} · {t("yourPoints")}{" "}
            <span className="font-semibold text-[var(--color-accent-dark)]">{myPoints}</span>
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-xl px-4 py-6">
        <ParticipantStrip slug={slug!} />

        <div className="mt-4 flex gap-1 rounded-full border border-slate-200 bg-white p-1 font-mono text-xs">
          <button
            onClick={() => setTab("feed")}
            className={`flex-1 rounded-full py-2 transition ${
              tab === "feed"
                ? "bg-[var(--color-accent)] text-white"
                : "text-slate-500 hover:text-[var(--color-accent-dark)]"
            }`}
          >
            {t("feedTab")}
          </button>
          <button
            onClick={() => setTab("leaderboard")}
            className={`flex-1 rounded-full py-2 transition ${
              tab === "leaderboard"
                ? "bg-[var(--color-accent)] text-white"
                : "text-slate-500 hover:text-[var(--color-accent-dark)]"
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
            <div className="mt-6">
              <UploadDropzone onUpload={handleUpload} uploading={uploading} />
              {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
            </div>

            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {moments.map((moment) => (
                <MomentCard key={moment.id} moment={moment} />
              ))}
            </div>
            {moments.length === 0 && (
              <div className="mt-8 text-center">
                <img src={emptyFeed} alt="" className="mx-auto h-24 w-24" />
                <p className="mt-2 text-sm text-slate-500">{t("noMomentsYetBeFirst")}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
