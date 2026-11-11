-- 008: task classification and execution modes.
-- Additive, except for one index that is replaced (see "winner guard" below).
-- Safe to run more than once.

-- ---------------------------------------------------------------- bounties
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) NOT NULL DEFAULT 'competitive';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bounties_execution_mode_check') THEN
    ALTER TABLE bounties ADD CONSTRAINT bounties_execution_mode_check
      CHECK (execution_mode IN ('first_valid', 'competitive', 'team', 'independent'));
  END IF;
END $$;

ALTER TABLE bounties ADD COLUMN IF NOT EXISTS industry VARCHAR(80);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS job_type VARCHAR(80);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS max_workers INTEGER NOT NULL DEFAULT 3;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS winner_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS independent_target INTEGER;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS closure_reason VARCHAR(40);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS requires_authorization BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS nda_text TEXT;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS authorization_statement TEXT;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS rules_of_engagement TEXT;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS permitted_targets TEXT;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS prohibited_activities TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bounties_max_workers_check') THEN
    ALTER TABLE bounties ADD CONSTRAINT bounties_max_workers_check CHECK (max_workers BETWEEN 1 AND 50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bounties_winner_limit_check') THEN
    ALTER TABLE bounties ADD CONSTRAINT bounties_winner_limit_check CHECK (winner_limit BETWEEN 1 AND 50);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bounties_execution_mode ON bounties (execution_mode);

-- ------------------------------------------------ worker participation
-- A worker takes a slot on a task (accepts it, or is assigned by the business
-- in team mode). Security tasks record the NDA and rules-of-engagement acceptance.
CREATE TABLE IF NOT EXISTS bounty_participants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id          UUID NOT NULL REFERENCES bounties(id),
  worker_id          UUID NOT NULL REFERENCES users(id),
  status             VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'assigned', 'closed', 'withdrawn')),
  nda_accepted_at    TIMESTAMPTZ,
  roe_accepted_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_participation_per_worker_per_bounty UNIQUE (bounty_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_bounty ON bounty_participants (bounty_id, status);

-- ------------------------------------------------------- winners and assessments
-- Every approved result. exclusive = TRUE means at most one row per bounty.
CREATE TABLE IF NOT EXISTS bounty_winners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id     UUID NOT NULL REFERENCES bounties(id),
  submission_id UUID NOT NULL UNIQUE REFERENCES submissions(id),
  worker_id     UUID NOT NULL REFERENCES users(id),
  exclusive     BOOLEAN NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_winners_bounty ON bounty_winners (bounty_id);

-- Backfill: every existing winner was the single approved submission of its bounty.
INSERT INTO bounty_winners (bounty_id, submission_id, worker_id, exclusive)
SELECT b.id, s.id, s.worker_id, TRUE
FROM bounties b
JOIN submissions s ON s.bounty_id = b.id AND s.worker_id = b.winner_id AND s.status = 'approved'
WHERE NOT EXISTS (SELECT 1 FROM bounty_winners w WHERE w.bounty_id = b.id);

-- Winner guard: the old index allowed only one approved submission per bounty, which
-- blocks competitive (several winners) and independent assessment. The guard now lives on
-- bounty_winners and applies only where exactly one winner is allowed.
DROP INDEX IF EXISTS one_approved_submission_per_bounty;
CREATE UNIQUE INDEX IF NOT EXISTS one_exclusive_winner_per_bounty
  ON bounty_winners (bounty_id) WHERE exclusive;

-- ------------------------------------------------------------ audit trail
CREATE TABLE IF NOT EXISTS execution_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id  UUID NOT NULL REFERENCES bounties(id),
  actor_id   UUID REFERENCES users(id),
  event      VARCHAR(60) NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_execution_events_bounty ON execution_events (bounty_id, created_at);

-- Backfill: every existing submitter takes a slot, so capacity counts stay correct for old tasks.
INSERT INTO bounty_participants (bounty_id, worker_id, status)
SELECT DISTINCT s.bounty_id, s.worker_id, 'active' FROM submissions s
ON CONFLICT (bounty_id, worker_id) DO NOTHING;
