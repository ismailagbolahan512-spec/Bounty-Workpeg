-- 009: smart verification reports, milestones and payment eligibility records.
-- Additive only, and safe to run more than once. No existing rows are changed.

-- ---------------------------------------------------------------- verification reports
-- Advisory. A report never changes a submission's status. The business decides.
CREATE TABLE IF NOT EXISTS submission_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  bounty_id       UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  requested_by    UUID NOT NULL REFERENCES users(id),
  execution_mode  VARCHAR(20) NOT NULL,
  outcome         VARCHAR(20) NOT NULL,
  report          JSONB NOT NULL,
  ai_used         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_verifications_outcome_check
    CHECK (outcome IN ('pass', 'fail', 'needs_review'))
);
CREATE INDEX IF NOT EXISTS idx_submission_verifications_submission
  ON submission_verifications (submission_id, created_at);

-- ---------------------------------------------------------------- milestones
CREATE TABLE IF NOT EXISTS milestones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL,
  title               VARCHAR(160) NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  deliverables        TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  budget              NUMERIC(12,2) NOT NULL DEFAULT 0,
  deadline            TIMESTAMPTZ,
  worker_id           UUID REFERENCES users(id),
  status              VARCHAR(30) NOT NULL DEFAULT 'planned',
  submission_text     TEXT,
  submission_link     VARCHAR(255),
  submitted_at        TIMESTAMPTZ,
  revision_notes      TEXT,
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT milestones_status_check
    CHECK (status IN ('planned', 'in_progress', 'submitted', 'revision_requested', 'approved')),
  CONSTRAINT milestones_budget_check CHECK (budget >= 0),
  CONSTRAINT milestones_position_key UNIQUE (project_id, position)
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones (project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_worker ON milestones (worker_id);

-- A milestone waits on other milestones in the same project. Cycles are rejected in the app.
CREATE TABLE IF NOT EXISTS milestone_dependencies (
  milestone_id  UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  depends_on_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  PRIMARY KEY (milestone_id, depends_on_id),
  CONSTRAINT milestone_no_self_dependency CHECK (milestone_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_milestone_dependencies_depends_on ON milestone_dependencies (depends_on_id);

CREATE TABLE IF NOT EXISTS milestone_events (
  id           BIGSERIAL PRIMARY KEY,
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  actor_id     UUID REFERENCES users(id),
  event        VARCHAR(60) NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_milestone_events_milestone ON milestone_events (milestone_id, created_at);

-- ---------------------------------------------------------------- payment eligibility
-- Records only. Nothing here holds, transfers or releases funds. The payment integration
-- reads these rows later. One eligibility record per source item.
CREATE TABLE IF NOT EXISTS payment_eligibilities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   VARCHAR(20) NOT NULL,
  source_id     UUID NOT NULL,
  worker_id     UUID NOT NULL REFERENCES users(id),
  business_id   UUID NOT NULL REFERENCES users(id),
  amount        NUMERIC(12,2) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'eligible',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_eligibilities_source_type_check CHECK (source_type IN ('milestone', 'submission')),
  CONSTRAINT payment_eligibilities_status_check CHECK (status IN ('eligible', 'under_review')),
  CONSTRAINT payment_eligibilities_source_key UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_eligibilities_worker ON payment_eligibilities (worker_id);
