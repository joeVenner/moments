-- Per-device guest identity (iOS plan, Phase 0).
-- Joining an event now returns an opaque guest token; only its SHA-256 hash is
-- stored. claimed_at marks a nickname that has been bound to a token. Rows with
-- claimed_at NULL are legacy participants that the first token-bearing join can
-- claim. Tokens are accepted but not yet required (see GUEST_TOKENS_ENFORCED).
ALTER TABLE participants ADD COLUMN claimed_at TEXT;

CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_sessions_token
  ON guest_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_participant
  ON guest_sessions (participant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_event
  ON guest_sessions (event_id);
