-- Upload-slot fairness (uploadSessions.ts) asks, per open row, whether its
-- guest has a completed upload, and counts an event's open rows. Without
-- these, both walk every completed upload of every event.
CREATE INDEX IF NOT EXISTS idx_uploads_participant_completed
  ON uploads (participant_id) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_uploads_event_open
  ON uploads (event_id) WHERE status = 'open';
