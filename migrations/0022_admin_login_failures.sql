-- Failed admin logins (web Basic auth and app sign-in), for a lockout that
-- holds across both: 10 failures from one client, or 100 in all, within 15
-- minutes refuse every login, right or wrong. Only wrong passwords write a
-- row, and at most 10 per client, so one client can't lock everyone out.
-- Only a keyed hash of the client IP is stored; the hourly job prunes rows
-- older than the window. Break-glass: delete the rows with wrangler d1.
CREATE TABLE IF NOT EXISTS admin_login_failures (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_login_failures_created ON admin_login_failures (created_at);
CREATE INDEX IF NOT EXISTS idx_admin_login_failures_ip ON admin_login_failures (ip_hash, created_at);
