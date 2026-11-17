-- Cursor-based feed for native clients (iOS plan, Phase 0), step 1 of 2: schema.
-- Each event has its own monotonic counter. It stamps every moment insert
-- (seq + change_seq) and every visibility/caption change (change_seq), so the
-- cursors leak nothing about other events. Clients page backwards with
-- ?before=<seq> and poll ?since=<change_seq>.
-- Schema is separate because ADD COLUMN cannot be retried; step 2 is idempotent.
CREATE TABLE IF NOT EXISTS event_feed_counters (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  value INTEGER NOT NULL
);

-- Hard-deleted moments leave a tombstone so `since` pollers can drop them.
CREATE TABLE IF NOT EXISTS moment_tombstones (
  moment_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  change_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moment_tombstones_event_change
  ON moment_tombstones (event_id, change_seq);

ALTER TABLE moments ADD COLUMN seq INTEGER;
ALTER TABLE moments ADD COLUMN change_seq INTEGER;
