-- Resumable multipart uploads (P3.1 evolution). Accounting + cleanup only:
-- the resume source of truth is R2's ListParts (survives reload + cross-device),
-- so a missing/empty row here never blocks resume. We track open uploads so we
-- can (a) abort orphans left by users who never completed, and (b) keep a tidy
-- audit of what's in flight per event. The final moment row is still written by
-- the existing `register`-style complete step — this table is NOT a media index.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  uploader_name TEXT NOT NULL,
  key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  -- 'open' | 'completed' | 'aborted'
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_uploads_event ON uploads (event_id);
CREATE INDEX idx_uploads_status ON uploads (status);