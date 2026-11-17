-- Splits the single expires_at into two moments in an event's life (iOS plan,
-- Phase 0): when new uploads stop, and when everything is purged. Both are
-- nullable and default to expires_at, so legacy events behave exactly as
-- before (uploads stop, the event disappears and the daily cron purges it,
-- all at expires_at).
ALTER TABLE events ADD COLUMN uploads_close_at TEXT;
ALTER TABLE events ADD COLUMN purge_after TEXT;
