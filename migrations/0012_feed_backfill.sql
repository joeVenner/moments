-- Cursor feed, step 2 of 3: number existing moments per event in upload order
-- (rowid breaks same-second ties by insertion order) and seed each counter.
UPDATE moments
   SET seq = ranked.rn, change_seq = ranked.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at, rowid) AS rn
      FROM moments
  ) AS ranked
 WHERE ranked.id = moments.id;

INSERT OR REPLACE INTO event_feed_counters (event_id, value)
  SELECT event_id, MAX(seq) FROM moments GROUP BY event_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_moments_event_seq ON moments (event_id, seq);
-- Partial index so feed pages seek straight to visible moments.
CREATE INDEX IF NOT EXISTS idx_moments_event_visible_seq
  ON moments (event_id, seq) WHERE moderation_status = 'approved';
CREATE INDEX IF NOT EXISTS idx_moments_event_change ON moments (event_id, change_seq);
