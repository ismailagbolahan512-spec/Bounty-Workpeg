-- ============================================================
-- Watermarked previews of submission files. Additive only; nothing is dropped or rewritten.
-- Run once in Neon, after 017. Files uploaded before this migration have no preview.
-- A preview is a review aid for businesses, never a substitute for the original.
-- ============================================================

CREATE TABLE IF NOT EXISTS submission_file_previews (
  file_id      UUID PRIMARY KEY REFERENCES submission_files(id) ON DELETE RESTRICT,
  storage_key  TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'application/pdf')),
  size_bytes   BIGINT NOT NULL CHECK (size_bytes > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Evidence is never edited or deleted. Uses the function created in migration 015.
CREATE OR REPLACE TRIGGER submission_file_previews_append_only
  BEFORE UPDATE OR DELETE ON submission_file_previews
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
