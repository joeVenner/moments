ALTER TABLE events ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public'
  CHECK (access_mode IN ('public', 'private'));
ALTER TABLE events ADD COLUMN access_pin_hash TEXT;
ALTER TABLE events ADD COLUMN access_pin_salt TEXT;
ALTER TABLE events ADD COLUMN invite_token TEXT;

CREATE UNIQUE INDEX idx_events_invite_token
  ON events (invite_token) WHERE invite_token IS NOT NULL;
