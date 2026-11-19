-- Each event belongs to one host. Every event so far was made by the
-- operator. SQLite can't add a REFERENCES column with a non-NULL default, so
-- the column stays nullable. The backfill leaves no NULL; one could only
-- come from an older worker during a deploy, and only the operator sees it.
ALTER TABLE events ADD COLUMN owner_user_id TEXT REFERENCES users(id);
UPDATE events SET owner_user_id = '00000000-0000-0000-0000-000000000001' WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_owner_user_id ON events (owner_user_id);
