-- ============================================================
-- Workpeg showcase fields and the file-extraction job queue. Additive only.
-- Approved 2026-11-12. Nothing is dropped, renamed or rewritten.
-- Safe to run more than once.
-- Showcase state is a cache for the public mirror. PostgreSQL stays authoritative.
-- ============================================================

-- Business opt-in. Off by default, so nothing is published unless the business turns it on.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS public_showcase BOOLEAN NOT NULL DEFAULT FALSE;

-- Plain text written by the business for the public showcase. Never copied from description.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS public_summary VARCHAR(280);

-- off: not in the showcase. stale: needs a publish. published: last publish succeeded.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS showcase_state VARCHAR(20) NOT NULL DEFAULT 'off';
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS showcase_synced_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE bounties ADD CONSTRAINT bounties_showcase_state_check
    CHECK (showcase_state IN ('off', 'stale', 'published'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bounties_showcase_stale ON bounties (showcase_state) WHERE showcase_state = 'stale';

-- Jobs for the Python extraction worker. One row per submission file that needs text extracted.
-- The worker claims rows with FOR UPDATE SKIP LOCKED. The Node API only inserts them.
CREATE TABLE IF NOT EXISTS file_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_file_id UUID NOT NULL REFERENCES submission_files(id),
  status             VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         TEXT,
  extracted_text     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE file_jobs ADD CONSTRAINT file_jobs_status_check
    CHECK (status IN ('queued', 'running', 'done', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_file_jobs_queue ON file_jobs (status, created_at) WHERE status IN ('queued', 'running');
