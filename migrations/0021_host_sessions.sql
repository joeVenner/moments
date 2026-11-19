-- Sign-in sessions for hosts in the native app (POST /api/v1/admin/session).
-- Only the SHA-256 of the bearer token is stored. credential_tag is an HMAC
-- of the credentials the session was opened with: changing ADMIN_USER or
-- ADMIN_PASSWORD (or EVENT_ACCESS_SECRET) ends every open session. Signing
-- out deletes the row; expired rows are deleted on the next sign-in.
CREATE TABLE IF NOT EXISTS host_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('operator')),
  credential_tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_sessions_token_hash ON host_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_host_sessions_expires_at ON host_sessions (expires_at);
