-- ============================================================
-- Bounty — batch 2 schema (run once in Neon, after schema-update.sql)
-- Adds: reviews (ratings after completion) and reports (disputes/abuse).
-- All user references are UUID to match users.id.
-- ============================================================

CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  reviewee_id UUID NOT NULL REFERENCES users(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one review per person per bounty
  CONSTRAINT one_review_per_reviewer_per_bounty UNIQUE (bounty_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews (reviewee_id);

CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id),
  reporter_id UUID NOT NULL REFERENCES users(id),
  reason      VARCHAR(50) NOT NULL,
  details     TEXT,
  status      VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one open report per person per bounty (stops report spam)
  CONSTRAINT one_report_per_reporter_per_bounty UNIQUE (bounty_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
