-- Hearts are now keyed on the guest (reactions.ts guestReactorId), so the
-- per-session device id added in 0017 is unused.
DROP INDEX IF EXISTS idx_guest_sessions_reactor;
ALTER TABLE guest_sessions DROP COLUMN reactor_id;
