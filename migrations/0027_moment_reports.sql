-- A guest flags a moment for the host to look at (App Store guideline 1.2).
-- One report per guest per moment; a report goes with its moment, its
-- reporter (a guest who leaves) and its event.
CREATE TABLE IF NOT EXISTS moment_reports (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_reports_reporter ON moment_reports (moment_id, participant_id);
CREATE INDEX IF NOT EXISTS idx_moment_reports_event ON moment_reports (event_id, created_at);
