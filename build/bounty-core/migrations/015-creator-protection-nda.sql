-- 015: Creator Protection, task NDAs, misuse reports, enforcement and audit.
-- Additive and idempotent. Nothing existing is dropped or rewritten.
-- Append-only tables (agreement_acceptances, audit_events, enforcement_actions)
-- are protected by triggers, so even the application cannot update or delete them.

-- ------------------------------------------------------------ task and account flags
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS confidential BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active', 'restricted', 'suspended'));

-- ------------------------------------------------------------ append-only guard
CREATE OR REPLACE FUNCTION reject_append_only_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be updated or deleted', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------ agreement acceptances
-- One row per user, agreement kind and version. Task NDAs also carry bounty_id.
-- body_sha256 pins the exact wording the user accepted.
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  kind         VARCHAR(40) NOT NULL
                 CHECK (kind IN ('creator_protection_business', 'worker_submission_ip', 'task_nda')),
  version      VARCHAR(40) NOT NULL,
  body_sha256  CHAR(64) NOT NULL,
  bounty_id    UUID REFERENCES bounties(id),
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_nda_has_bounty CHECK ((kind = 'task_nda') = (bounty_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agreement_account
  ON agreement_acceptances (user_id, kind, version) WHERE bounty_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agreement_task
  ON agreement_acceptances (user_id, kind, version, bounty_id) WHERE bounty_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreement_bounty ON agreement_acceptances (bounty_id);

CREATE OR REPLACE TRIGGER agreement_acceptances_append_only
  BEFORE UPDATE OR DELETE ON agreement_acceptances
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ------------------------------------------------------------ audit trail
CREATE TABLE IF NOT EXISTS audit_events (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID REFERENCES users(id),
  action       VARCHAR(80) NOT NULL,
  entity_type  VARCHAR(40) NOT NULL,
  entity_id    UUID,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_id, created_at);

CREATE OR REPLACE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ------------------------------------------------------------ misuse and confidentiality reports
CREATE TABLE IF NOT EXISTS misuse_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 VARCHAR(40) NOT NULL
                         CHECK (kind IN ('copyright_misuse', 'confidentiality_incident')),
  reporter_id          UUID NOT NULL REFERENCES users(id),
  accused_business_id  UUID REFERENCES users(id),
  bounty_id            UUID REFERENCES bounties(id),
  submission_id        UUID REFERENCES submissions(id),
  description          TEXT NOT NULL,
  evidence             TEXT,
  status               VARCHAR(40) NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted', 'under_review',
                                           'additional_information_required', 'resolved', 'rejected')),
  findings             TEXT,
  reviewed_by          UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_misuse_status ON misuse_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_misuse_reporter ON misuse_reports (reporter_id);

-- ------------------------------------------------------------ enforcement (append-only)
-- A 'reverse' row points at the action it undoes. Current state is derived from the log.
CREATE TABLE IF NOT EXISTS enforcement_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id),
  action               VARCHAR(40) NOT NULL
                         CHECK (action IN ('warning', 'restrict_publishing', 'suspend', 'reverse')),
  reverses_action_id   UUID REFERENCES enforcement_actions(id),
  report_id            UUID REFERENCES misuse_reports(id),
  reason               TEXT NOT NULL,
  created_by           UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reverse_has_target CHECK ((action = 'reverse') = (reverses_action_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_enforcement_user ON enforcement_actions (user_id, created_at);

CREATE OR REPLACE TRIGGER enforcement_actions_append_only
  BEFORE UPDATE OR DELETE ON enforcement_actions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ------------------------------------------------------------ appeals
CREATE TABLE IF NOT EXISTS enforcement_appeals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enforcement_action_id UUID NOT NULL REFERENCES enforcement_actions(id),
  user_id               UUID NOT NULL REFERENCES users(id),
  statement             TEXT NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'upheld', 'overturned')),
  decision_note         TEXT,
  decided_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_appeal
  ON enforcement_appeals (enforcement_action_id) WHERE status = 'open';
-- One appeal per enforcement action, ever: a decided appeal cannot be re-opened by a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appeal_per_action
  ON enforcement_appeals (enforcement_action_id);
