-- Signed, revocable private-event access.
-- access_version is embedded in every signed access grant; bumping it (on a
-- PIN change) revokes every grant issued before. Version 1 also still accepts
-- the legacy raw invite_token cookie so guests already inside an event are not
-- locked out by the deploy.
ALTER TABLE events ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1;

-- Failed PIN attempts, used to throttle brute force per (event, client).
-- ip_hash is an HMAC of the client IP, never the raw address.
CREATE TABLE IF NOT EXISTS access_failures (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_failures_event_ip
  ON access_failures (event_id, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_access_failures_created
  ON access_failures (created_at);
