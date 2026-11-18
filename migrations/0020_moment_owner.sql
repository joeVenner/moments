-- The guest who shared a moment (from their guest token), on every path that
-- creates one: web direct, web multipart, web Stream and app sessions. NULL
-- for tokenless uploads (until GUEST_TOKENS_ENFORCED) and admin-made rows.
ALTER TABLE moments ADD COLUMN participant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_moments_participant
  ON moments (event_id, participant_id) WHERE participant_id IS NOT NULL;
