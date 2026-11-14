-- ============================================================
-- Proof-of-Ability (Phase 6). Additive only: no rows are rewritten and nothing is dropped.
-- Safe to run once in Neon. Existing submissions default to NOT shown.
-- ============================================================

-- A worker chooses which of their approved submissions appear on their public profile.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS portfolio_visible BOOLEAN NOT NULL DEFAULT FALSE;

-- The worker's own edited summary. Verified facts are never stored here; they are read from submissions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS portfolio_summary TEXT;
