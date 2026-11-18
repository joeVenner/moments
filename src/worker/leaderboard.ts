/**
 * Guest ranking by points from visible moments. Moments are tied to guests
 * by nickname (as on the web; moments carry no participant id yet).
 */

/** Large enough for any guest cap; keeps one response bounded. */
export const LEADERBOARD_MAX_ENTRIES = 500;

export interface LeaderboardEntry {
  participant_id: string;
  nickname: string;
  avatar_seed: string | null;
  total_points: number;
  moment_count: number;
  /** 1-based; guests with equal points share a rank (1, 1, 3). */
  rank: number;
}

type Row = Omit<LeaderboardEntry, "rank">;

/**
 * Every guest who joined, best first; earlier joiners first among ties.
 * Moments are totalled once per nickname, then joined: a per-guest join
 * would rescan the event's moments for every guest (uploader_name has no
 * index), and this endpoint is polled.
 */
export async function getLeaderboard(db: D1Database, eventId: string): Promise<LeaderboardEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS participant_id, p.nickname, p.avatar_seed,
              COALESCE(totals.points, 0) AS total_points,
              COALESCE(totals.moments, 0) AS moment_count
         FROM participants p
         LEFT JOIN (
           SELECT uploader_name, SUM(points_awarded) AS points, COUNT(*) AS moments
             FROM moments
            WHERE event_id = ? AND moderation_status = 'approved'
            GROUP BY uploader_name
         ) totals ON totals.uploader_name = p.nickname
        WHERE p.event_id = ?
        ORDER BY total_points DESC, p.joined_at ASC, p.id ASC
        LIMIT ?`
    )
    .bind(eventId, eventId, LEADERBOARD_MAX_ENTRIES)
    .all<Row>();
  return withRanks(results);
}

/** Standard competition ranking over rows already sorted by points. */
export function withRanks(rows: readonly Row[]): LeaderboardEntry[] {
  let rank = 0;
  let previous: number | null = null;
  return rows.map((row, index) => {
    if (row.total_points !== previous) {
      rank = index + 1;
      previous = row.total_points;
    }
    return { ...row, rank };
  });
}
