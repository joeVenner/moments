CREATE TABLE moment_reactions (
  id TEXT PRIMARY KEY,
  moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reactor_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'heart' CHECK (kind = 'heart'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (moment_id, reactor_id)
);

CREATE INDEX idx_reactions_event ON moment_reactions (event_id);
CREATE INDEX idx_reactions_moment ON moment_reactions (moment_id);
