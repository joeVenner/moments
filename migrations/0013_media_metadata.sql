-- Media metadata for native clients (iOS plan, Phase 0). All nullable: existing
-- and web-uploaded moments have none, and the thumbnail pipeline (Phase 1)
-- fills the *_key columns later. Clients fall back to media_url when absent.
-- Derived R2 keys MUST stay under events/<event_id>/ so /media keeps applying
-- the private-event gate and lifecycle cleanup deletes them with the event.
ALTER TABLE moments ADD COLUMN width INTEGER;
ALTER TABLE moments ADD COLUMN height INTEGER;
ALTER TABLE moments ADD COLUMN duration_ms INTEGER;
ALTER TABLE moments ADD COLUMN blurhash TEXT;
ALTER TABLE moments ADD COLUMN thumb_key TEXT;
ALTER TABLE moments ADD COLUMN display_key TEXT;
ALTER TABLE moments ADD COLUMN poster_key TEXT;

-- Filling these in (Phase 1 thumbnail pipeline, client metadata) must reach
-- clients that already synced the moment, so they bump change_seq too.
DROP TRIGGER IF EXISTS moments_bump_change_seq;
CREATE TRIGGER moments_bump_change_seq
AFTER UPDATE OF moderation_status, caption, width, height, duration_ms, blurhash,
                thumb_key, display_key, poster_key ON moments
WHEN OLD.moderation_status IS NOT NEW.moderation_status
  OR OLD.caption IS NOT NEW.caption
  OR OLD.width IS NOT NEW.width
  OR OLD.height IS NOT NEW.height
  OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.blurhash IS NOT NEW.blurhash
  OR OLD.thumb_key IS NOT NEW.thumb_key
  OR OLD.display_key IS NOT NEW.display_key
  OR OLD.poster_key IS NOT NEW.poster_key
BEGIN
  INSERT OR IGNORE INTO event_feed_counters (event_id, value) VALUES (NEW.event_id, 0);
  UPDATE event_feed_counters SET value = value + 1 WHERE event_id = NEW.event_id;
  UPDATE moments
     SET change_seq = (SELECT value FROM event_feed_counters WHERE event_id = NEW.event_id)
   WHERE id = NEW.id;
END;
