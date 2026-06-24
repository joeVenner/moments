CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  main_characters TEXT,
  description TEXT,
  cover_image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE moments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  uploader_name TEXT NOT NULL,
  media_url TEXT NOT NULL,
  caption TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_moments_event_id ON moments (event_id);
CREATE INDEX idx_events_slug ON events (slug);
