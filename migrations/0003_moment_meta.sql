-- Feed performance: store each moment's byte size + MIME type so the client can
-- detect heavy files (videos, >50MB) and render a placeholder instead of
-- loading the full original on feed open. Nullable so existing rows survive
-- (older moments just fall back to URL-based detection, no heavy badge).
ALTER TABLE moments ADD COLUMN size_bytes INTEGER;
ALTER TABLE moments ADD COLUMN mime_type TEXT;