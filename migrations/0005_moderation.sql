ALTER TABLE moments ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (moderation_status IN ('approved', 'hidden'));

CREATE INDEX idx_moments_event_moderation
  ON moments (event_id, moderation_status, created_at DESC);
