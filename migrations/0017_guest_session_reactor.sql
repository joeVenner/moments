-- The reactor id a guest session hearts with. Bound on the session's first
-- reaction; when the device presents another id (e.g. the app was
-- reinstalled but kept its keychain token), the session's hearts move to the
-- new id, so one session never holds hearts under two ids.
ALTER TABLE guest_sessions ADD COLUMN reactor_id TEXT;

-- One session per reactor id within an event, so moving a session's hearts
-- can never carry another session's hearts with it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_sessions_reactor
  ON guest_sessions (event_id, reactor_id) WHERE reactor_id IS NOT NULL;
