-- Host accounts. Today there is one: the operator, who signs in with the
-- admin password. Sign in with Apple adds hosts later; a host's id becomes
-- the App Store appAccountToken, so it is a lowercase UUID (the operator's
-- is fixed). Deleting an account marks the row, so billing records keep
-- their owner.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('host', 'operator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

INSERT OR IGNORE INTO users (id, role) VALUES ('00000000-0000-0000-0000-000000000001', 'operator');

-- Every session belongs to a user. Rows from before this migration (and
-- any opened by older code until it is replaced) are the operator's.
ALTER TABLE host_sessions ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE host_sessions SET user_id = '00000000-0000-0000-0000-000000000001' WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_host_sessions_user_id ON host_sessions (user_id);
