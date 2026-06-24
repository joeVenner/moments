CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  nickname TEXT NOT NULL,
  avatar_seed TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, nickname)
);

CREATE INDEX idx_participants_event_id ON participants (event_id);
