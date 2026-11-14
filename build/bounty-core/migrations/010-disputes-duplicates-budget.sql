-- 010: duplicate submission flags, dispute resolution centre, payment holds.
-- Additive only, and safe to run more than once. No existing rows change.

-- ---------------------------------------------------------------- duplicate flags
-- One row per pair of submissions in the same bounty. The pair is stored in canonical order
-- (submission_id < related_submission_id), so the same pair can never be stored twice.
-- A flag is a prompt for review. It is never a finding of misconduct.
CREATE TABLE IF NOT EXISTS submission_overlaps (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id               UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  submission_id           UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  related_submission_id   UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  score                   NUMERIC(4,3) NOT NULL,
  signals                 JSONB NOT NULL,
  security                BOOLEAN NOT NULL DEFAULT FALSE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'open',
  review_note             TEXT,
  reviewed_by             UUID REFERENCES users(id),
  reviewed_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_overlaps_status_check
    CHECK (status IN ('open', 'duplicate', 'independent', 'dismissed')),
  CONSTRAINT submission_overlaps_order_check CHECK (submission_id < related_submission_id),
  CONSTRAINT submission_overlaps_pair_key UNIQUE (submission_id, related_submission_id)
);
CREATE INDEX IF NOT EXISTS idx_submission_overlaps_bounty ON submission_overlaps (bounty_id, status);
CREATE INDEX IF NOT EXISTS idx_submission_overlaps_related ON submission_overlaps (related_submission_id);

-- ---------------------------------------------------------------- disputes
CREATE TABLE IF NOT EXISTS disputes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id        UUID REFERENCES bounties(id),
  milestone_id     UUID REFERENCES milestones(id),
  submission_id    UUID REFERENCES submissions(id),
  raised_by        UUID NOT NULL REFERENCES users(id),
  respondent_id    UUID NOT NULL REFERENCES users(id),
  category         VARCHAR(40) NOT NULL,
  title            VARCHAR(160) NOT NULL,
  description      TEXT NOT NULL,
  status           VARCHAR(30) NOT NULL DEFAULT 'open',
  decision_outcome VARCHAR(30),
  decision_text    TEXT,
  payment_decision VARCHAR(20),
  decided_by       UUID REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT disputes_target_check CHECK ((bounty_id IS NOT NULL) <> (milestone_id IS NOT NULL)),
  CONSTRAINT disputes_parties_check CHECK (raised_by <> respondent_id),
  CONSTRAINT disputes_category_check CHECK (category IN (
    'unfair_rejection', 'changed_requirements', 'non_payment', 'missed_deadline',
    'inadequate_deliverables', 'unreasonable_revisions', 'unauthorised_scope_change',
    'confidentiality_breach', 'misrepresentation', 'other')),
  CONSTRAINT disputes_status_check CHECK (status IN (
    'open', 'awaiting_response', 'under_review', 'awaiting_evidence', 'escalated', 'resolved')),
  CONSTRAINT disputes_outcome_check CHECK (decision_outcome IS NULL OR decision_outcome IN (
    'upheld_raiser', 'upheld_respondent', 'partial', 'no_action')),
  CONSTRAINT disputes_payment_check CHECK (payment_decision IS NULL OR payment_decision IN ('release', 'withhold')),
  CONSTRAINT disputes_escalation_check CHECK (escalation_count BETWEEN 0 AND 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_dispute_per_bounty_party
  ON disputes (bounty_id, raised_by) WHERE bounty_id IS NOT NULL AND status <> 'resolved';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_dispute_per_milestone_party
  ON disputes (milestone_id, raised_by) WHERE milestone_id IS NOT NULL AND status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_disputes_raised_by ON disputes (raised_by);
CREATE INDEX IF NOT EXISTS idx_disputes_respondent ON disputes (respondent_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status, updated_at);

CREATE TABLE IF NOT EXISTS dispute_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispute_messages_dispute ON dispute_messages (dispute_id, created_at);

-- Evidence is text or an https link. Files are not stored in the database.
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  added_by    UUID NOT NULL REFERENCES users(id),
  kind        VARCHAR(10) NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dispute_evidence_kind_check CHECK (kind IN ('text', 'link'))
);
CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute ON dispute_evidence (dispute_id, created_at);

CREATE TABLE IF NOT EXISTS dispute_events (
  id          BIGSERIAL PRIMARY KEY,
  dispute_id  UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id),
  event       VARCHAR(60) NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispute_events_dispute ON dispute_events (dispute_id, created_at);
