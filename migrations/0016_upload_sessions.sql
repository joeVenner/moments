-- Upload sessions for the native app (v1). Additive: web uploads leave these
-- NULL and keep working unchanged.
--
-- client_upload_id: the app's id for one queued item, so a retried init after
--   a lost response returns the same session instead of opening another.
-- participant_id: the guest who owns the session (from the guest token). No
--   foreign key on purpose: the purge deletes participants before uploads.
-- caption: stored at init, so the server can finalize without the app.
-- part_size: fixed at init, so changing the default never breaks a session
--   already in flight.
ALTER TABLE uploads ADD COLUMN client_upload_id TEXT;
ALTER TABLE uploads ADD COLUMN participant_id TEXT;
ALTER TABLE uploads ADD COLUMN caption TEXT;
ALTER TABLE uploads ADD COLUMN part_size INTEGER;

CREATE UNIQUE INDEX idx_uploads_client_upload
  ON uploads (event_id, participant_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

-- Open-session cap per guest.
CREATE INDEX idx_uploads_participant_open
  ON uploads (participant_id)
  WHERE status = 'open';
