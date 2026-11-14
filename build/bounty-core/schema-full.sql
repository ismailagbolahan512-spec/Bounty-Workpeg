-- ============================================================
-- Bounty — full schema (single source of truth)
-- Safe to run more than once: every statement is idempotent.
-- Replaces init-dg.js (which had a syntax error and was never run
-- in production), schema-update.sql and schema-batch2.sql.
--
-- Run on a NEW database: this creates everything.
-- Run on EXISTING Neon data: this only adds what is missing.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             VARCHAR(255) UNIQUE NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  role              VARCHAR(50)  NOT NULL,
  name              VARCHAR(255) NOT NULL,
  bio               TEXT,
  avatar_url        TEXT,
  wallet_address    VARCHAR(255),
  reputation_score  DECIMAL(3,1) DEFAULT 5.0,
  total_earned      NUMERIC(14,2) NOT NULL DEFAULT 0,
  categories        TEXT[] NOT NULL DEFAULT '{}',
  skills            TEXT NOT NULL DEFAULT '',
  onboarding_done   BOOLEAN NOT NULL DEFAULT FALSE,
  website           TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL DEFAULT '',
  email_verified_at TIMESTAMPTZ,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bounties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES users(id),
  title           VARCHAR(255) NOT NULL,
  description     TEXT NOT NULL,
  category        VARCHAR(100) NOT NULL,
  difficulty      VARCHAR(50)  NOT NULL,
  reward_amount   NUMERIC(12,2) NOT NULL,
  deadline        TIMESTAMP NOT NULL,
  submission_type VARCHAR(100) NOT NULL,
  requirements    TEXT,
  status          VARCHAR(50) NOT NULL DEFAULT 'open',
  winner_id       UUID REFERENCES users(id),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id         UUID NOT NULL REFERENCES bounties(id),
  worker_id         UUID NOT NULL REFERENCES users(id),
  title             VARCHAR(255) NOT NULL,
  description       TEXT NOT NULL,
  github_link       VARCHAR(255),
  notes_to_reviewer TEXT,
  status            VARCHAR(50) NOT NULL DEFAULT 'pending',
  submitted_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id),
  bounty_id     UUID NOT NULL REFERENCES bounties(id),
  worker_id     UUID NOT NULL REFERENCES users(id),
  business_id   UUID NOT NULL REFERENCES users(id),
  amount        NUMERIC(12,2) NOT NULL,
  monad_tx_hash VARCHAR(255),
  status        VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  message    TEXT NOT NULL,
  link       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columns added after the first version of these tables. CREATE TABLE above
-- does not add columns to tables that already exist (e.g. your Neon database),
-- so each one is added here explicitly.
ALTER TABLE users ADD COLUMN IF NOT EXISTS categories TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS skills TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN avatar_url TYPE TEXT;
ALTER TABLE bounties ALTER COLUMN reward_amount TYPE NUMERIC(12,2);
ALTER TABLE payments ALTER COLUMN amount TYPE NUMERIC(12,2);
ALTER TABLE users ALTER COLUMN total_earned TYPE NUMERIC(14,2) USING COALESCE(total_earned, 0);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS notes_to_reviewer TEXT;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS winner_id UUID REFERENCES users(id);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- One approved submission per bounty (database guard against double payment).
CREATE UNIQUE INDEX IF NOT EXISTS one_approved_submission_per_bounty
  ON submissions (bounty_id) WHERE status = 'approved';

-- One submission per worker per bounty.
CREATE UNIQUE INDEX IF NOT EXISTS one_submission_per_worker_per_bounty
  ON submissions (bounty_id, worker_id);

CREATE INDEX IF NOT EXISTS idx_submissions_bounty_id ON submissions (bounty_id);
CREATE INDEX IF NOT EXISTS idx_submissions_worker_id ON submissions (worker_id);
CREATE INDEX IF NOT EXISTS idx_bounties_business_id  ON bounties (business_id);
CREATE INDEX IF NOT EXISTS idx_bounties_status       ON bounties (status);
CREATE INDEX IF NOT EXISTS idx_bounties_category     ON bounties (category);
CREATE INDEX IF NOT EXISTS idx_payments_bounty_id    ON payments (bounty_id);
CREATE INDEX IF NOT EXISTS idx_payments_worker_id    ON payments (worker_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications (user_id, created_at DESC);

-- Reviews (ratings after a bounty is completed)
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  reviewee_id UUID NOT NULL REFERENCES users(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_review_per_reviewer_per_bounty UNIQUE (bounty_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews (reviewee_id);

-- Reports (disputes, unpaid rewards, abuse)
CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id),
  reporter_id UUID NOT NULL REFERENCES users(id),
  reason      VARCHAR(50) NOT NULL,
  details     TEXT,
  status      VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_report_per_reporter_per_bounty UNIQUE (bounty_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES users(id);

-- One-time tokens for email verification and password reset.
-- Only a SHA-256 hash of each token is stored, never the token itself.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     VARCHAR(20) NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, purpose);

-- ============================================================
-- Projects, task dependencies, acceptance criteria, revisions, AI plan drafts
-- (mirrors migrations/002-projects-criteria.sql)
-- ============================================================
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

CREATE TABLE IF NOT EXISTS task_dependencies (
  bounty_id     UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  depends_on_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bounty_id, depends_on_id),
  CONSTRAINT no_self_dependency CHECK (bounty_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies (depends_on_id);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS revision_notes TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS revision_requested_at TIMESTAMPTZ;

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

-- ============================================================
-- Task workspace messages and proposed deadline changes
-- (mirrors migrations/003-workspace-messages-deadlines.sql)
-- ============================================================
CREATE TABLE IF NOT EXISTS bounty_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id  UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bounty_messages_bounty ON bounty_messages (bounty_id, created_at);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS proposed_deadline TIMESTAMPTZ;
