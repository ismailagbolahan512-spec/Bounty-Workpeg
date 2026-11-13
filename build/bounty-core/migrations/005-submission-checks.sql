-- 005: AI Submission Checker reports. Additive, and safe to run more than once.
-- Stores the findings only, never the submission text (that stays in submissions).
CREATE TABLE IF NOT EXISTS submission_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  bounty_id     UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  requested_by  UUID NOT NULL REFERENCES users(id),
  results       JSONB NOT NULL,
  ai_used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_submission_checks_submission ON submission_checks (submission_id, created_at);
