import { useEffect, useRef, useState } from "react";
import { createEvent, generateBanner, listEvents, UnauthorizedError } from "../lib/api";
import type { EventData } from "../lib/types";
import { QRPanel } from "../components/QRPanel";
import { EventMoments } from "../components/EventMoments";
import { EventCardSkeleton } from "../components/Skeleton";
import { AdminLogin } from "../components/AdminLogin";
import { EventPreview } from "../components/EventPreview";
import { getAdminAuthHeader, clearAdminAuth } from "../lib/adminAuth";
import { useI18n } from "../lib/i18n";

const EVENT_TYPES = ["Wedding", "Gala", "Birthday", "Corporate", "Other"];
const MAX_SELFIE_BYTES = 8 * 1024 * 1024; // mirrors src/worker/banner.ts MAX_SELFIE_BYTES

export default function Admin() {
  const { t, eventTypeLabel } = useI18n();
  const [authed, setAuthed] = useState(() => !!getAdminAuthHeader());
  const [events, setEvents] = useState<EventData[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [previewTitle, setPreviewTitle] = useState("");
  const [previewType, setPreviewType] = useState("Wedding");
  const [previewHosts, setPreviewHosts] = useState("");
  const [previewCoverUrl, setPreviewCoverUrl] = useState<string | null>(null);
  const previewCoverUrlRef = useRef<string | null>(null);

  const [selfieFile, setSelfieFile] = useState<File | null>(null);
  const [selfiePreviewUrl, setSelfiePreviewUrl] = useState<string | null>(null);
  const [bannerTheme, setBannerTheme] = useState("");
  const [aiBannerUrl, setAiBannerUrl] = useState<string | null>(null);
  const [generatingBanner, setGeneratingBanner] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const selfieInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authed) return;
    listEvents()
      .then((r) => setEvents(r.events))
      .catch((err) => {
        if (err instanceof UnauthorizedError) {
          clearAdminAuth();
          setAuthed(false);
        }
      })
      .finally(() => setLoading(false));
  }, [authed]);

  useEffect(() => {
    return () => {
      if (previewCoverUrlRef.current) URL.revokeObjectURL(previewCoverUrlRef.current);
    };
  }, []);

  // Derives a thumbnail preview URL from selfieFile without touching the
  // (already-verified) handleSelfieChange logic. Revokes the previous object
  // URL whenever selfieFile changes (including reset to null) and on unmount.
  useEffect(() => {
    if (!selfieFile) {
      setSelfiePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selfieFile);
    setSelfiePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selfieFile]);

  function handleLogout() {
    clearAdminAuth();
    setAuthed(false);
    setEvents([]);
  }

  function handleCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (previewCoverUrlRef.current) {
      URL.revokeObjectURL(previewCoverUrlRef.current);
      previewCoverUrlRef.current = null;
    }
    if (file) {
      // A manually-picked cover file wins over any AI banner on submit (the
      // backend's precedence rule), so drop the AI banner state here too —
      // keeps the live preview consistent with what will actually be sent.
      setAiBannerUrl(null);
      const url = URL.createObjectURL(file);
      previewCoverUrlRef.current = url;
      setPreviewCoverUrl(url);
    } else {
      setPreviewCoverUrl(null);
    }
  }

  function handleSelfieChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setBannerError(null);
    setSelfieFile(file);
  }

  // Clears a manually-picked cover file. Mirrors the "no file" branch of
  // handleCoverChange exactly (revoke + null the ref + clear preview), plus
  // resetting the native input's value since setting .value doesn't fire
  // onChange on its own.
  function clearCover() {
    if (coverInputRef.current) coverInputRef.current.value = "";
    if (previewCoverUrlRef.current) {
      URL.revokeObjectURL(previewCoverUrlRef.current);
      previewCoverUrlRef.current = null;
    }
    setPreviewCoverUrl(null);
  }

  // Clears the selected selfie file; the selfiePreviewUrl effect above
  // handles revoking its object URL automatically.
  function clearSelfie() {
    if (selfieInputRef.current) selfieInputRef.current.value = "";
    setSelfieFile(null);
    setBannerError(null);
  }

  async function handleGenerateBanner() {
    if (!selfieFile) return;
    setBannerError(null);

    if (selfieFile.size > MAX_SELFIE_BYTES) {
      setBannerError(t("selfieTooLarge"));
      return;
    }

    setGeneratingBanner(true);
    try {
      const fd = new FormData();
      fd.append("selfie", selfieFile);
      fd.append("theme", bannerTheme);
      const { banner_url } = await generateBanner(fd);

      // A freshly generated AI banner should win over any manual cover file
      // already sitting in the file input (mirrors handleCoverChange's
      // symmetric clear of aiBannerUrl) — otherwise the preview shows the AI
      // banner but the backend's "manual file wins" rule would silently save
      // the stale manual cover instead.
      if (coverInputRef.current) coverInputRef.current.value = "";
      setAiBannerUrl(banner_url);
      if (previewCoverUrlRef.current) {
        URL.revokeObjectURL(previewCoverUrlRef.current);
        previewCoverUrlRef.current = null;
      }
      setPreviewCoverUrl(banner_url);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        clearAdminAuth();
        setAuthed(false);
        return;
      }
      const message = err instanceof Error ? err.message : "";
      setBannerError(/not configured/i.test(message) ? t("aiBannerUnavailable") : t("aiBannerFailed"));
    } finally {
      setGeneratingBanner(false);
    }
  }

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const form = e.currentTarget;
    try {
      const formData = new FormData(form);
      if (aiBannerUrl) {
        formData.set("cover_image_url", aiBannerUrl);
      }
      const { event } = await createEvent(formData);
      setEvents((prev) => [event, ...prev]);
      setExpandedSlug(event.slug);
      form.reset();
      setPreviewTitle("");
      setPreviewType("Wedding");
      setPreviewHosts("");
      if (previewCoverUrlRef.current) {
        URL.revokeObjectURL(previewCoverUrlRef.current);
        previewCoverUrlRef.current = null;
      }
      setPreviewCoverUrl(null);
      setSelfieFile(null);
      setBannerTheme("");
      setAiBannerUrl(null);
      setBannerError(null);
      if (selfieInputRef.current) selfieInputRef.current.value = "";
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        clearAdminAuth();
        setAuthed(false);
        return;
      }
      setError(err instanceof Error ? err.message : t("failedToCreateEvent"));
    } finally {
      setCreating(false);
    }
  }

  if (!authed) {
    return <AdminLogin onSuccess={() => setAuthed(true)} />;
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)] px-4 pb-10 pt-16">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-mono text-2xl font-semibold text-[var(--color-accent-dark)]">
              Moments — Admin
            </h1>
            <p className="mt-1 text-sm text-slate-600">{t("adminTagline")}</p>
          </div>
          <button
            onClick={handleLogout}
            className="shrink-0 whitespace-nowrap rounded-full border border-slate-300 px-3 py-1.5 font-mono text-xs text-slate-600 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent-dark)]"
          >
            {t("logOut")}
          </button>
        </div>

        <form
          onSubmit={handleCreate}
          className="mt-6 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <input
            name="title"
            required
            placeholder={t("eventTitlePlaceholder")}
            onChange={(e) => setPreviewTitle(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="type"
            required
            defaultValue="Wedding"
            onChange={(e) => setPreviewType(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          >
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {eventTypeLabel(type)}
              </option>
            ))}
          </select>
          <input
            name="main_characters"
            placeholder={t("hostsPlaceholder")}
            onChange={(e) => setPreviewHosts(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <textarea
            name="description"
            placeholder={t("descriptionPlaceholder")}
            rows={2}
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-mono text-slate-500">{t("coverPhotoLabel")}</p>
            {previewCoverUrl && !aiBannerUrl ? (
              <div className="flex items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2">
                <img
                  src={previewCoverUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-md object-cover"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {coverInputRef.current?.files?.[0]?.name}
                </span>
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  className="shrink-0 whitespace-nowrap font-mono text-xs text-[var(--color-accent-dark)] hover:underline"
                >
                  {t("changePhoto")}
                </button>
                <button
                  type="button"
                  onClick={clearCover}
                  aria-label={t("removePhoto")}
                  className="shrink-0 font-mono text-xs text-slate-400 hover:text-[var(--color-accent-dark)]"
                >
                  ✕
                </button>
              </div>
            ) : (
              <label
                htmlFor="cover-input"
                className="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-[var(--color-bg-alt)] px-3 py-3 text-center transition hover:border-[var(--color-accent)] active:bg-[var(--color-accent)]/10"
              >
                <span className="font-mono text-sm text-[var(--color-accent-dark)]">
                  {t("tapToChoosePhoto")}
                </span>
              </label>
            )}
            <input
              id="cover-input"
              ref={coverInputRef}
              name="cover"
              type="file"
              accept="image/*"
              onChange={handleCoverChange}
              className="hidden"
            />
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-slate-300 p-3">
            <p className="text-xs font-mono text-slate-500">{t("aiSelfiePrompt")}</p>
            {selfieFile ? (
              <div className="flex items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2">
                {selfiePreviewUrl && (
                  <img
                    src={selfiePreviewUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-md object-cover"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {selfieFile.name}
                </span>
                <button
                  type="button"
                  onClick={() => selfieInputRef.current?.click()}
                  className="shrink-0 whitespace-nowrap font-mono text-xs text-[var(--color-accent-dark)] hover:underline"
                >
                  {t("changePhoto")}
                </button>
                <button
                  type="button"
                  onClick={clearSelfie}
                  aria-label={t("removePhoto")}
                  className="shrink-0 font-mono text-xs text-slate-400 hover:text-[var(--color-accent-dark)]"
                >
                  ✕
                </button>
              </div>
            ) : (
              <label
                htmlFor="selfie-input"
                className="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-[var(--color-bg-alt)] px-3 py-3 text-center transition hover:border-[var(--color-accent)] active:bg-[var(--color-accent)]/10"
              >
                <span className="font-mono text-sm text-[var(--color-accent-dark)]">
                  {t("tapToChoosePhoto")}
                </span>
              </label>
            )}
            <input
              id="selfie-input"
              ref={selfieInputRef}
              type="file"
              accept="image/*"
              data-testid="selfie-input"
              onChange={handleSelfieChange}
              className="hidden"
            />
            <input
              type="text"
              value={bannerTheme}
              onChange={(e) => setBannerTheme(e.target.value)}
              placeholder={t("bannerThemePlaceholder")}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={handleGenerateBanner}
              disabled={!selfieFile || generatingBanner}
              className="self-start rounded-lg border border-[var(--color-accent)] px-3 py-2 font-mono text-xs font-medium text-[var(--color-accent-dark)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
            >
              {generatingBanner ? t("generatingBanner") : t("generateAiBanner")}
            </button>
            {bannerError && <p className="text-xs text-red-600">{bannerError}</p>}
          </div>

          {aiBannerUrl && <input type="hidden" name="cover_image_url" value={aiBannerUrl} />}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
          >
            {creating ? t("creating") : t("createEvent")}
          </button>
        </form>

        <div className="mt-6">
          <EventPreview
            title={previewTitle}
            type={previewType}
            hosts={previewHosts}
            coverUrl={previewCoverUrl}
          />
        </div>

        <div className="mt-8 flex flex-col gap-3">
          {loading && (
            <>
              <EventCardSkeleton />
              <EventCardSkeleton />
            </>
          )}
          {!loading && events.length === 0 && (
            <p className="text-sm text-slate-500">{t("noEventsYet")}</p>
          )}
          {events.map((event) => (
            <div key={event.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <button
                onClick={() => setExpandedSlug(expandedSlug === event.slug ? null : event.slug)}
                className="flex w-full items-center justify-between text-left"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{event.title}</p>
                  <p className="truncate font-mono text-xs text-slate-500">
                    {eventTypeLabel(event.type)} · /e/{event.slug}
                  </p>
                </div>
                <span className="ml-3 shrink-0 whitespace-nowrap font-mono text-xs text-[var(--color-accent)]">
                  {expandedSlug === event.slug ? t("hideDetails") : t("viewDetails")}
                </span>
              </button>
              {expandedSlug === event.slug && (
                <div className="mt-4 flex flex-col gap-4">
                  <QRPanel slug={event.slug} title={event.title} />
                  <div>
                    <p className="mb-2 font-mono text-xs font-medium uppercase tracking-wide text-slate-500">
                      {t("collectedMoments")}
                    </p>
                    <EventMoments slug={event.slug} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
