-- /media now checks whether the requested object belongs to a hidden moment on
-- every load, so lookups by stored key must be index seeks. Derived keys are
-- mostly NULL (Phase 1 fills them), hence partial indexes.
CREATE INDEX IF NOT EXISTS idx_moments_media_url ON moments (media_url);
CREATE INDEX IF NOT EXISTS idx_moments_thumb_key ON moments (thumb_key) WHERE thumb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_moments_display_key ON moments (display_key) WHERE display_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_moments_poster_key ON moments (poster_key) WHERE poster_key IS NOT NULL;
