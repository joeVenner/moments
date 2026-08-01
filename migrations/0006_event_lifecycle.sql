ALTER TABLE events ADD COLUMN starts_at TEXT;
ALTER TABLE events ADD COLUMN expires_at TEXT;
ALTER TABLE events ADD COLUMN archived_at TEXT;

CREATE INDEX idx_events_expiration ON events (expires_at, archived_at);
