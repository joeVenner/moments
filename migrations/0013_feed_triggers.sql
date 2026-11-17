-- Cursor feed, step 3 of 3: triggers keep seq/change_seq current on every write
-- path (three upload inserts, admin hide/unhide, admin delete, lifecycle cleanup)
-- without touching that code.
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
  UPDATE event_feed_counters SET value = value + 1 WHERE event_id = NEW.event_id;
  UPDATE moments
     SET change_seq = (SELECT value FROM event_feed_counters WHERE event_id = NEW.event_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS moments_tombstone AFTER DELETE ON moments
BEGIN
  UPDATE event_feed_counters SET value = value + 1 WHERE event_id = OLD.event_id;
  INSERT OR REPLACE INTO moment_tombstones (moment_id, event_id, change_seq)
    VALUES (OLD.id, OLD.event_id,
            (SELECT value FROM event_feed_counters WHERE event_id = OLD.event_id));
END;
