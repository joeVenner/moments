/** What a host sees about one event's activity. */
export interface EventAnalytics {
  summary: {
    total_moments: number;
    hidden_moments: number;
    videos: number;
    photos: number;
    storage_bytes: number;
    participants: number;
    reactions: number;
  };
  /** Moments per UTC day over the last 14 days; days with none are absent. */
  activity: { day: string; count: number }[];
  upload_states: { status: string; count: number }[];
}

/**
 * Counts for one event, shared by the web admin and the app API so both
 * show the same numbers. Read-only; five indexed queries in parallel.
 */
export async function getEventAnalytics(db: D1Database, eventId: string): Promise<EventAnalytics> {
  const [summary, participants, reactions, activity, uploadStates] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total_moments,
              COALESCE(SUM(CASE WHEN moderation_status = 'hidden' THEN 1 ELSE 0 END), 0) AS hidden_moments,
              COALESCE(SUM(CASE WHEN mime_type LIKE 'video/%' THEN 1 ELSE 0 END), 0) AS videos,
              COALESCE(SUM(CASE WHEN mime_type NOT LIKE 'video/%' OR mime_type IS NULL THEN 1 ELSE 0 END), 0) AS photos,
              COALESCE(SUM(size_bytes), 0) AS storage_bytes
         FROM moments WHERE event_id = ?`
    ).bind(eventId).first<Omit<EventAnalytics["summary"], "participants" | "reactions">>(),
    db.prepare("SELECT COUNT(*) AS count FROM participants WHERE event_id = ?").bind(eventId).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM moment_reactions WHERE event_id = ?").bind(eventId).first<{ count: number }>(),
    db.prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
         FROM moments WHERE event_id = ? AND created_at >= datetime('now', '-13 days')
        GROUP BY date(created_at) ORDER BY day ASC`
    ).bind(eventId).all<{ day: string; count: number }>(),
    db.prepare("SELECT status, COUNT(*) AS count FROM uploads WHERE event_id = ? GROUP BY status ORDER BY status")
      .bind(eventId).all<{ status: string; count: number }>(),
  ]);
  return {
    summary: {
      total_moments: summary?.total_moments ?? 0,
      hidden_moments: summary?.hidden_moments ?? 0,
      videos: summary?.videos ?? 0,
      photos: summary?.photos ?? 0,
      storage_bytes: summary?.storage_bytes ?? 0,
      participants: participants?.count ?? 0,
      reactions: reactions?.count ?? 0,
    },
    activity: activity.results,
    upload_states: uploadStates.results,
  };
}
