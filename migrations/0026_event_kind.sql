-- What an event is, for billing: events from before hosting plans ('legacy'),
-- the operator's own ('operator'), or one a plan paid for ('main', or the
-- one-month 'test' event). Plan events follow their plan's limits; the
-- others keep today's behaviour (no guest cap).
ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy', 'operator', 'main', 'test'));
