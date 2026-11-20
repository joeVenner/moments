import { buildMomentMedia, type MomentMedia } from "./media";
import type { MomentRow } from "./types";

/**
 * Cursor-based moment feed for native clients. Ordering and change tracking
 * come from the per-event `seq` / `change_seq` columns that triggers maintain
 * (migrations 0011-0012), so every write path is covered without touching it.
 *
 * Contract: `change_seq` tracks visibility and caption only. Reaction counts in
 * `upserts` can be stale; clients refresh them separately.
 */

export const FEED_DEFAULT_LIMIT = 30;
export const FEED_MAX_LIMIT = 100;
export const CHANGES_MAX_LIMIT = 200;
export const HIGHLIGHTS_DEFAULT_LIMIT = 30;
export const HIGHLIGHTS_MAX_LIMIT = 50;

type RawMediaColumn =
  | "width"
  | "height"
  | "duration_ms"
  | "blurhash"
  | "thumb_key"
  | "display_key"
  | "poster_key";

/** Public feed item: raw media columns are folded into `media`. */
export type FeedMoment = Omit<
  MomentRow,
  "moderation_status" | "seq" | "change_seq" | "reaction_count" | "reacted" | RawMediaColumn
> & {
  /** The sharer's participant id; null for moments from before guest ids. */
  uploader_id: string | null;
  seq: number;
  change_seq: number;
  reaction_count: number;
  /** Whether `reactor_id` has reacted to this moment. */
  reacted: boolean;
  media: MomentMedia;
};

/** Raw row as selected; R2 keys are internal and replaced by `media` URLs. */
type FeedRow = Omit<FeedMoment, "media" | "reacted"> & {
  reacted: number;
} & { [column in RawMediaColumn]: MomentRow[column] };

function toFeedMoment(row: FeedRow): FeedMoment {
  const media = buildMomentMedia(row);
  const {
    width: _width,
    height: _height,
    duration_ms: _duration,
    blurhash: _blurhash,
    thumb_key: _thumb,
    display_key: _display,
    poster_key: _poster,
    reacted,
    ...moment
  } = row;
  return { ...moment, reacted: reacted === 1, media };
}

export interface FeedPage {
  moments: FeedMoment[];
  /** Pass as `before` for the next (older) page; null when this was the last. */
  next_before: number | null;
  /** Pass as `since` to /feed/changes to receive everything after this page. */
  cursor: number;
}

export interface FeedChanges {
  /** New or re-shown moments, plus edits to visible ones. */
  upserts: FeedMoment[];
  /** Ids of moments that were hidden or deleted. */
  removed: string[];
  cursor: number;
  /** True when more changes exist after `cursor`; poll again immediately. */
  has_more: boolean;
}

/** Parses a non-negative integer cursor; anything else is treated as absent. */
export function parseCursor(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

export function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw && /^\d{1,4}$/.test(raw) ? Number(raw) : fallback;
  return Math.min(Math.max(parsed, 1), max);
}

// `uploader_id` is the sharer's participant id (null for legacy rows), so a
// guest can mute someone; the leaderboard already pairs ids with nicknames.
const MOMENT_COLUMNS = `m.id, m.event_id, m.uploader_name, m.participant_id AS uploader_id, m.media_url, m.caption, m.points_awarded,
  m.created_at, m.size_bytes, m.mime_type, m.seq, m.change_seq,
  m.width, m.height, m.duration_ms, m.blurhash, m.thumb_key, m.display_key, m.poster_key,
  (SELECT COUNT(*) FROM moment_reactions r WHERE r.moment_id = m.id) AS reaction_count,
  EXISTS(SELECT 1 FROM moment_reactions r WHERE r.moment_id = m.id AND r.reactor_id = ?) AS reacted`;

const COUNTER_SQL = "SELECT COALESCE((SELECT value FROM event_feed_counters WHERE event_id = ?), 0) AS value";

// Larger than any seq, so "no cursor" is still an index seek (seq < bound).
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * Newest-first page of approved moments with seq < `before` (or the newest page
 * when `before` is null). The batch is one D1 transaction, so the returned
 * cursor matches exactly the rows read; later changes are > cursor.
 */
export async function getFeedPage(
  db: D1Database,
  input: { eventId: string; before: number | null; limit: number; reactorId: string }
): Promise<FeedPage> {
  const [counter, rows] = await db.batch<Record<string, unknown>>([
    db.prepare(COUNTER_SQL).bind(input.eventId),
    db
      .prepare(
        `SELECT ${MOMENT_COLUMNS} FROM moments m
          WHERE m.event_id = ? AND m.moderation_status = 'approved' AND m.seq < ?
          ORDER BY m.seq DESC LIMIT ?`
      )
      .bind(input.reactorId, input.eventId, input.before ?? NO_UPPER_BOUND, input.limit + 1),
  ]);
  const moments = (rows.results as FeedRow[]).slice(0, input.limit).map(toFeedMoment);
  const hasOlder = rows.results.length > input.limit;
  return {
    moments,
    next_before: hasOlder ? moments[moments.length - 1].seq : null,
    cursor: Number(counter.results[0]?.value ?? 0),
  };
}

/**
 * Most-hearted visible moments, newest first among ties (the web's
 * highlights order, with seq as the tiebreak).
 */
export async function getHighlights(
  db: D1Database,
  input: { eventId: string; limit: number; reactorId: string }
): Promise<FeedMoment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MOMENT_COLUMNS} FROM moments m
        WHERE m.event_id = ? AND m.moderation_status = 'approved'
        ORDER BY reaction_count DESC, m.seq DESC LIMIT ?`
    )
    .bind(input.reactorId, input.eventId, input.limit)
    .all<FeedRow>();
  return results.map(toFeedMoment);
}

/** Everything that changed in an event after `since`, oldest change first. */
export async function getFeedChanges(
  db: D1Database,
  input: { eventId: string; since: number; limit: number; reactorId: string }
): Promise<FeedChanges> {
  const [counter, rows, tombstones] = await db.batch<Record<string, unknown>>([
    db.prepare(COUNTER_SQL).bind(input.eventId),
    db
      .prepare(
        `SELECT ${MOMENT_COLUMNS}, m.moderation_status FROM moments m
          WHERE m.event_id = ? AND m.change_seq > ?
          ORDER BY m.change_seq ASC LIMIT ?`
      )
      .bind(input.reactorId, input.eventId, input.since, input.limit + 1),
    db
      .prepare(
        `SELECT moment_id, change_seq FROM moment_tombstones
          WHERE event_id = ? AND change_seq > ?
          ORDER BY change_seq ASC LIMIT ?`
      )
      .bind(input.eventId, input.since, input.limit + 1),
  ]);
  const snapshot = Number(counter.results[0]?.value ?? 0);

  // Merge both streams by change_seq and keep the first `limit` changes, so
  // the returned cursor never skips a change that did not fit in this page.
  type Change =
    | { changeSeq: number; kind: "moment"; row: FeedRow & { moderation_status: string } }
    | { changeSeq: number; kind: "tombstone"; momentId: string };
  const merged: Change[] = [
    ...(rows.results as (FeedRow & { moderation_status: string })[]).map(
      (row): Change => ({ changeSeq: row.change_seq, kind: "moment", row })
    ),
    ...(tombstones.results as { moment_id: string; change_seq: number }[]).map(
      (row): Change => ({ changeSeq: row.change_seq, kind: "tombstone", momentId: row.moment_id })
    ),
  ].sort((a, b) => a.changeSeq - b.changeSeq);

  const page = merged.slice(0, input.limit);
  const hasMore = merged.length > input.limit;
  const upserts: FeedMoment[] = [];
  const removed: string[] = [];
  for (const change of page) {
    if (change.kind === "tombstone") {
      removed.push(change.momentId);
    } else if (change.row.moderation_status === "approved") {
      const { moderation_status: _status, ...row } = change.row;
      upserts.push(toFeedMoment(row));
    } else {
      removed.push(change.row.id);
    }
  }

  return {
    upserts,
    removed,
    // A `since` ahead of the counter (e.g. after a restore) resyncs to it.
    cursor: hasMore ? page[page.length - 1].changeSeq : snapshot,
    has_more: hasMore,
  };
}
