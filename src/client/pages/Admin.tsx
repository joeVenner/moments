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
import { BannerProgress } from "../components/BannerProgress";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { SAMPLE_BANNERS, renderSampleBanner } from "../lib/sampleBanners";

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
  const [sampleCoverFile, setSampleCoverFile] = useState<File | null>(null);
  const [generatingBanner, setGeneratingBanner] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // A freshly generated AI banner awaiting the admin's confirm/reject. It's
  // shown in the preview but NOT applied to the form until "Confirm" — so the
  // admin can reject and regenerate without an unwanted banner being saved.
  const [pendingBannerUrl, setPendingBannerUrl] = useState<string | null>(null);
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
      setPendingBannerUrl(null);
      setSampleCoverFile(null);
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
    setSampleCoverFile(null);
    setPendingBannerUrl(null);
    setAiBannerUrl(null);
  }
  // Falls back to one of the prebuilt gradient banners when AI generation
  // failed (or isn't configured). Rendered to a PNG File so it rides the same
  // `cover` upload path as a hand-picked photo — see handleCreate, which sets
  // it onto the outgoing FormData over the (empty) file input.
  async function handleSelectSample(bannerId: string) {
    const banner = SAMPLE_BANNERS.find((b) => b.id === bannerId);
    if (!banner) return;
    setBannerError(null);
    const file = await renderSampleBanner(banner, previewTitle);

    if (coverInputRef.current) coverInputRef.current.value = "";
    setAiBannerUrl(null);
    setPendingBannerUrl(null);
    setSampleCoverFile(file);
    if (previewCoverUrlRef.current) URL.revokeObjectURL(previewCoverUrlRef.current);
    const url = URL.createObjectURL(file);
    previewCoverUrlRef.current = url;
    setPreviewCoverUrl(url);
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

      // Don't apply the banner to the form yet — hold it as a candidate so the
      // admin can review it and Confirm or Regenerate. Clear any manual cover
      // sitting in the file input (mirrors handleCoverChange's symmetric clear
      // of aiBannerUrl) so the preview reflects only this candidate.
      if (coverInputRef.current) coverInputRef.current.value = "";
      setPendingBannerUrl(banner_url);
      setAiBannerUrl(null);
      setSampleCoverFile(null);
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

  // Confirm the candidate banner: apply it to the form so it'll be saved on
  // submit, and clear the pending review state.
  function confirmBanner() {
    if (!pendingBannerUrl) return;
    setAiBannerUrl(pendingBannerUrl);
    setPendingBannerUrl(null);
  }

  // Reject the candidate and generate a fresh one. The discarded banner is
  // left orphaned in R2 (cheap, one-off) and we immediately kick off a new
  // generate using the same selfie + theme.
  function regenerateBanner() {
    setPendingBannerUrl(null);
    void handleGenerateBanner();
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
      } else if (sampleCoverFile) {
        // Override the empty native file input with our rendered banner so it
        // uploads as a normal cover (the backend ignores zero-byte cover files).
        formData.set("cover", sampleCoverFile);
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
      setPendingBannerUrl(null);
      setSampleCoverFile(null);
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
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("adminTagline")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher variant="inline" />
            <button
              onClick={handleLogout}
              className="shrink-0 whitespace-nowrap rounded-full border border-[var(--color-border)] px-3 py-1.5 font-mono text-xs text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent-dark)]"
            >
              {t("logOut")}
            </button>
          </div>
        </div>

        <form
          onSubmit={handleCreate}
          className="mt-6 flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-5"
        >
          <input
            name="title"
            required
            placeholder={t("eventTitlePlaceholder")}
            onChange={(e) => setPreviewTitle(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="type"
            required
            defaultValue="Wedding"
            onChange={(e) => setPreviewType(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
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
            className="rounded-lg border border-[var(--color-border)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <textarea
            name="description"
            placeholder={t("descriptionPlaceholder")}
            rows={2}
            className="rounded-lg border border-[var(--color-border)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-mono text-[var(--color-text-muted)]">{t("coverPhotoLabel")}</p>
            {previewCoverUrl && !aiBannerUrl ? (
              <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2">
                <img
                  src={previewCoverUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-md object-cover"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
                  {coverInputRef.current?.files?.[0]?.name ?? sampleCoverFile?.name}
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
                  className="shrink-0 font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
                >
                  ✕
                </button>
              </div>
            ) : (
              <label
                htmlFor="cover-input"
                className="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-3 text-center transition hover:border-[var(--color-accent)] active:bg-[var(--color-accent)]/10"
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

          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-[var(--color-border)] p-3">
            <p className="text-xs font-mono text-[var(--color-text-muted)]">{t("aiSelfiePrompt")}</p>
            {selfieFile ? (
              <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2">
                {selfiePreviewUrl && (
                  <img
                    src={selfiePreviewUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-md object-cover"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
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
                  className="shrink-0 font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent-dark)]"
                >
                  ✕
                </button>
              </div>
            ) : (
              <label
                htmlFor="selfie-input"
                className="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-3 text-center transition hover:border-[var(--color-accent)] active:bg-[var(--color-accent)]/10"
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
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={handleGenerateBanner}
              disabled={!selfieFile || generatingBanner}
              className="self-start rounded-lg border border-[var(--color-accent)] px-3 py-2 font-mono text-xs font-medium text-[var(--color-accent-dark)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
            >
              {generatingBanner ? t("generatingBanner") : t("generateAiBanner")}
            </button>
            {generatingBanner && <BannerProgress />}
            {bannerError && <p className="text-xs text-red-600">{bannerError}</p>}
            {pendingBannerUrl && !generatingBanner && (
              <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-alt)] p-3">
                <p className="font-mono text-xs text-[var(--color-text-muted)]">
                  {t("bannerReviewHeading")}
                </p>
                <img
                  src={pendingBannerUrl}
                  alt={t("bannerReviewAlt")}
                  className="aspect-[3/2] w-full rounded-md object-cover"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={confirmBanner}
                    className="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 font-mono text-xs font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
                  >
                    {t("confirmBanner")}
                  </button>
                  <button
                    type="button"
                    onClick={regenerateBanner}
                    disabled={generatingBanner}
                    className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent-dark)] disabled:opacity-50"
                  >
                    {t("regenerateBanner")}
                  </button>
                </div>
              </div>
            )}
            {bannerError && (
              <div className="flex flex-col gap-1.5">
                <p className="font-mono text-xs text-[var(--color-text-muted)]">{t("bannerFallbackHeading")}</p>
                <div className="grid grid-cols-3 gap-2">
                  {SAMPLE_BANNERS.map((banner) => {
                    const selected = sampleCoverFile?.name === `sample-banner-${banner.id}.png`;
                    return (
                      <button
                        key={banner.id}
                        type="button"
                        onClick={() => handleSelectSample(banner.id)}
                        className={`flex h-14 flex-col justify-end rounded-lg p-1.5 text-left ring-offset-2 transition hover:scale-[1.03] ${
                          selected ? "ring-2 ring-[var(--color-accent)]" : ""
                        }`}
                        style={{
                          backgroundImage: `linear-gradient(135deg, ${banner.stops[0]}, ${banner.stops[1]}, ${banner.stops[2]})`,
                        }}
                      >
                        <span className="rounded bg-black/25 px-1 font-mono text-[10px] font-medium text-white">
                          {t(banner.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
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
            <p className="text-sm text-[var(--color-text-muted)]">{t("noEventsYet")}</p>
          )}
          {events.map((event) => (
            <div key={event.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
              <button
                onClick={() => setExpandedSlug(expandedSlug === event.slug ? null : event.slug)}
                className="flex w-full items-center justify-between text-left"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-[var(--color-text)]">{event.title}</p>
                  <p className="truncate font-mono text-xs text-[var(--color-text-muted)]">
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
                    <p className="mb-2 font-mono text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
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
