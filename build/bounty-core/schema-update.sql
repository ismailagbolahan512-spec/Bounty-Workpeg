-- ============================================================
-- Bounty backend — REQUIRED schema updates (run once in Neon)
-- The existing 4 tables stay as-is; these statements add the
-- columns/constraints the API needs for correctness & safety.
-- ============================================================

-- 1) submissions.notes_to_reviewer was accepted by the API spec
--    but did not exist in the table.
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS notes_to_reviewer TEXT;

-- 2) Track the winner + completion time on the bounty itself.
ALTER TABLE bounties
  ADD COLUMN IF NOT EXISTS winner_id    INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 3) CRITICAL: at most ONE approved submission per bounty.
--    This is the database-level guard against double payments,
--    even if two approve requests race past application checks.
CREATE UNIQUE INDEX IF NOT EXISTS one_approved_submission_per_bounty
  ON submissions (bounty_id)
  WHERE status = 'approved';

-- 4) One submission per worker per bounty (remove if you later
--    want to allow resubmissions).
CREATE UNIQUE INDEX IF NOT EXISTS one_submission_per_worker_per_bounty
  ON submissions (bounty_id, worker_id);

-- 5) Foreign-key indexes (PG does NOT create these automatically;
--    without them every join/filter on these columns is a seq scan).
CREATE INDEX IF NOT EXISTS idx_submissions_bounty_id ON submissions (bounty_id);
CREATE INDEX IF NOT EXISTS idx_submissions_worker_id ON submissions (worker_id);
CREATE INDEX IF NOT EXISTS idx_bounties_business_id  ON bounties  (business_id);
CREATE INDEX IF NOT EXISTS idx_bounties_status       ON bounties  (status);
CREATE INDEX IF NOT EXISTS idx_bounties_category     ON bounties  (category);
CREATE INDEX IF NOT EXISTS idx_payments_bounty_id    ON payments  (bounty_id);
CREATE INDEX IF NOT EXISTS idx_payments_worker_id    ON payments  (worker_id);

-- 6) Money must never be float. If existing columns are FLOAT/REAL,
--    convert them (adjust precision to your needs):
-- ALTER TABLE bounties ALTER COLUMN reward_amount TYPE NUMERIC(12,2);
-- ALTER TABLE payments ALTER COLUMN amount       TYPE NUMERIC(12,2);
-- ALTER TABLE users    ALTER COLUMN total_earned TYPE NUMERIC(14,2) USING COALESCE(total_earned, 0);