-- 002: projects, task dependencies, acceptance criteria, revision requests, AI plan drafts.
-- Additive only. Safe to run once on existing data. Single-task bounties keep working:
-- project_id stays NULL and acceptance_criteria defaults to an empty array.

CREATE TABLE IF NOT EXISTS projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES users(id),
  title        VARCHAR(255) NOT NULL,
  description  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_business_id ON projects (business_id);

ALTER TABLE bounties ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_bounties_project_id ON bounties (project_id);

-- A task may wait on other tasks in the same project. Cycles are rejected in the app
-- before insert; the CHECK blocks self-dependency at the database level.
CREATE TABLE IF NOT EXISTS task_dependencies (
  bounty_id     UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  depends_on_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bounty_id, depends_on_id),
  CONSTRAINT no_self_dependency CHECK (bounty_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies (depends_on_id);

-- Revision requests: the owner asks for changes, the worker resubmits the same row.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS revision_notes TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS revision_requested_at TIMESTAMPTZ;

-- AI planning drafts. A draft is never a project until a business approves it.
CREATE TABLE IF NOT EXISTS ai_plan_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES users(id),
  prompt      TEXT NOT NULL,
  plan        JSONB NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'draft',
  project_id  UUID REFERENCES projects(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_plan_drafts_business ON ai_plan_drafts (business_id);
