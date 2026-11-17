-- Cursor feed, step 2 of 2: backfill, indexes and triggers in ONE migration so
-- they apply atomically. With the triggers in a later file, an upload landing
-- between the two would keep seq = NULL forever and never reach the feed.
-- Every statement is idempotent, so a failed run can be retried.
--
-- Number existing moments per event in upload order (rowid breaks same-second
-- ties by insertion order) and seed each counter.
UPDATE moments
   SET seq = ranked.rn, change_seq = ranked.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at, rowid) AS rn
      FROM moments
  ) AS ranked
 WHERE ranked.id = moments.id;

INSERT OR REPLACE INTO event_feed_counters (event_id, value)
  SELECT event_id, MAX(seq) FROM moments GROUP BY event_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_moments_event_seq ON moments (event_id, seq);
-- Partial index so feed pages seek straight to visible moments.
CREATE INDEX IF NOT EXISTS idx_moments_event_visible_seq
  ON moments (event_id, seq) WHERE moderation_status = 'approved';
CREATE INDEX IF NOT EXISTS idx_moments_event_change ON moments (event_id, change_seq);

-- Triggers keep seq/change_seq current on every write path (three upload
-- inserts, admin hide/unhide, admin delete, lifecycle cleanup) without touching
-- that code. Each one ensures its event's counter row exists first, so a
-- missing row can never null out a NOT NULL column and abort the write.
CREATE TRIGGER IF NOT EXISTS moments_assign_seq AFTER INSERT ON moments
BEGIN
  INSERT OR IGNORE INTO event_feed_counters (event_id, value) VALUES (NEW.event_id, 0);
  UPDATE event_feed_counters SET value = value + 1 WHERE event_id = NEW.event_id;
  UPDATE moments
     SET seq = (SELECT value FROM event_feed_counters WHERE event_id = NEW.event_id),
         change_seq = (SELECT value FROM event_feed_counters WHERE event_id = NEW.event_id)
   WHERE id = NEW.id;
END;

-- Only these columns fire it, so the seq/change_seq UPDATEs above never recurse.
CREATE TRIGGER IF NOT EXISTS moments_bump_change_seq
AFTER UPDATE OF moderation_status, caption ON moments
WHEN OLD.moderation_status IS NOT NEW.moderation_status OR OLD.caption IS NOT NEW.caption
BEGIN
  INSERT OR IGNORE INTO event_feed_counters (event_id, value) VALUES (NEW.event_id, 0);
  UPDATE event_feed_counters SET value = value + 1 WHERE event_id = NEW.event_id;
  UPDATE moments
     SET change_seq = (SELECT value FROM event_feed_counters WHERE event_id = NEW.event_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS moments_tombstone AFTER DELETE ON moments
BEGIN
  INSERT OR IGNORE INTO event_feed_counters (event_id, value) VALUES (OLD.event_id, 0);
  UPDATE event_feed_counters SET value = value + 1 WHERE event_id = OLD.event_id;
  INSERT OR REPLACE INTO moment_tombstones (moment_id, event_id, change_seq)
    VALUES (OLD.id, OLD.event_id,
            (SELECT value FROM event_feed_counters WHERE event_id = OLD.event_id));
END;
