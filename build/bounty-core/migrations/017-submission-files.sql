-- ============================================================
-- Submission files (private originals). Additive only; nothing is dropped or rewritten.
-- Run once in Neon, after 016. Files live in a private Backblaze B2 bucket; this table
-- records what was stored, its SHA-256 fingerprint, and who uploaded it.
-- ============================================================

CREATE TABLE IF NOT EXISTS submission_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  uploader_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_key   TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  content_type  TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 127),
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600),
  sha256        TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_submission_files_submission ON submission_files (submission_id);

-- Evidence is never edited or deleted. Uses the function created in migration 015.
CREATE OR REPLACE TRIGGER submission_files_append_only
  BEFORE UPDATE OR DELETE ON submission_files
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
