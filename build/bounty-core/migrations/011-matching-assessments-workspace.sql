-- 011: AI worker matching inputs, practical skill assessments, and workspace deliverables.
-- Additive only, and safe to run more than once. No existing rows change.

-- ---------------------------------------------------------------- worker matching inputs
-- Workers choose what to share. Nothing is shared until discoverable is true (opt-in).
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_hours INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS available_from DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT FALSE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_weekly_hours_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_weekly_hours_check CHECK (weekly_hours IS NULL OR weekly_hours BETWEEN 0 AND 80);
  END IF;
END $$;

-- ---------------------------------------------------------------- practical skill assessments
-- Optional. Assessments are created by administrators. They are never a mandatory certificate.
CREATE TABLE IF NOT EXISTS assessments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category                 VARCHAR(40) NOT NULL,
  title                    VARCHAR(160) NOT NULL,
  description              TEXT NOT NULL,
  difficulty               VARCHAR(10) NOT NULL,
  instructions             TEXT NOT NULL,
  submission_requirements  TEXT NOT NULL,
  rubric                   JSONB NOT NULL,
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assessments_difficulty_check CHECK (difficulty IN ('easy', 'medium', 'hard'))
);
CREATE INDEX IF NOT EXISTS idx_assessments_category ON assessments (category, active);

CREATE TABLE IF NOT EXISTS worker_assessments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id    UUID NOT NULL REFERENCES assessments(id),
  worker_id        UUID NOT NULL REFERENCES users(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  submission_text  TEXT,
  submission_link  VARCHAR(255),
  ai_prescore      JSONB,
  reviewer_id      UUID REFERENCES users(id),
  reviewer_notes   TEXT,
  score            INTEGER,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at     TIMESTAMPTZ,
  reviewed_at      TIMESTAMPTZ,
  CONSTRAINT worker_assessments_status_check CHECK (status IN ('in_progress', 'submitted', 'verified', 'not_verified')),
  CONSTRAINT worker_assessments_score_check CHECK (score IS NULL OR score BETWEEN 0 AND 100)
);
-- One open attempt per worker per assessment.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt_per_assessment
  ON worker_assessments (assessment_id, worker_id) WHERE status IN ('in_progress', 'submitted');
CREATE INDEX IF NOT EXISTS idx_worker_assessments_worker ON worker_assessments (worker_id, started_at);
CREATE INDEX IF NOT EXISTS idx_worker_assessments_queue ON worker_assessments (status) WHERE status = 'submitted';

CREATE TABLE IF NOT EXISTS assessment_events (
  id                    BIGSERIAL PRIMARY KEY,
  worker_assessment_id  UUID NOT NULL REFERENCES worker_assessments(id) ON DELETE CASCADE,
  actor_id              UUID REFERENCES users(id),
  event                 VARCHAR(60) NOT NULL,
  detail                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_events_attempt ON assessment_events (worker_assessment_id, created_at);

-- ---------------------------------------------------------------- workspace deliverables
-- A task's work broken into deliverables. Used for team execution and any task that is split up.
-- Links are https addresses. Files are not stored on Bounty's servers.
CREATE TABLE IF NOT EXISTS workspace_deliverables (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id      UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  worker_id      UUID REFERENCES users(id),
  title          VARCHAR(160) NOT NULL,
  component      VARCHAR(160),
  description    TEXT NOT NULL DEFAULT '',
  link           VARCHAR(255),
  status         VARCHAR(20) NOT NULL DEFAULT 'planned',
  blocked_reason TEXT,
  due_at         TIMESTAMPTZ,
  depends_on     UUID REFERENCES workspace_deliverables(id) ON DELETE SET NULL,
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_deliverables_status_check
    CHECK (status IN ('planned', 'in_progress', 'delivered', 'accepted', 'blocked')),
  CONSTRAINT workspace_deliverables_no_self_dependency CHECK (depends_on IS NULL OR depends_on <> id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_deliverables_bounty ON workspace_deliverables (bounty_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_deliverables_worker ON workspace_deliverables (worker_id);

-- Timeline of deliverable changes. Written in the same transaction as each change.
CREATE TABLE IF NOT EXISTS workspace_deliverable_events (
  id             BIGSERIAL PRIMARY KEY,
  deliverable_id UUID NOT NULL REFERENCES workspace_deliverables(id) ON DELETE CASCADE,
  actor_id       UUID REFERENCES users(id),
  event          VARCHAR(40) NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspace_deliverable_events ON workspace_deliverable_events (deliverable_id, created_at);
