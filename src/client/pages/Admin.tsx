import { useEffect, useState } from "react";
import { createEvent, listEvents, UnauthorizedError } from "../lib/api";
import type { EventData } from "../lib/types";
import { QRPanel } from "../components/QRPanel";
import { EventMoments } from "../components/EventMoments";
import { EventCardSkeleton } from "../components/Skeleton";
import { AdminLogin } from "../components/AdminLogin";
import { getAdminAuthHeader, clearAdminAuth } from "../lib/adminAuth";
import { useI18n } from "../lib/i18n";

const EVENT_TYPES = ["Wedding", "Gala", "Birthday", "Corporate", "Other"];

export default function Admin() {
  const { t, eventTypeLabel } = useI18n();
  const [authed, setAuthed] = useState(() => !!getAdminAuthHeader());
  const [events, setEvents] = useState<EventData[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  function handleLogout() {
    clearAdminAuth();
    setAuthed(false);
    setEvents([]);
  }

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const form = e.currentTarget;
    try {
      const formData = new FormData(form);
      const { event } = await createEvent(formData);
      setEvents((prev) => [event, ...prev]);
      setExpandedSlug(event.slug);
      form.reset();
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
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="type"
            required
            defaultValue="Wedding"
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
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <textarea
            name="description"
            placeholder={t("descriptionPlaceholder")}
            rows={2}
            className="rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
          <label className="text-xs font-mono text-slate-500">
            {t("coverPhotoLabel")}
            <input
              name="cover"
              type="file"
              accept="image/*"
              className="mt-1 block w-full text-sm"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:opacity-50"
          >
            {creating ? t("creating") : t("createEvent")}
          </button>
        </form>

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
