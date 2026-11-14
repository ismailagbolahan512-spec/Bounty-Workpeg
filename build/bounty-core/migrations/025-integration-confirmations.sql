-- ============================================================
-- 025: integration confirmations (user approval for sensitive Workpeg actions). Additive only.
-- Run once after 024, on a test database first. Not applied to production.
-- Design: docs/workpeg-identity-design.md, section 3.4. A token can request one of these
-- actions, but only the signed-in user can approve it, in the Bounty web UI. Approval is
-- single-use and expires within 15 minutes.
-- ============================================================

CREATE TABLE IF NOT EXISTS integration_confirmations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id     UUID NOT NULL REFERENCES integration_tokens(id) ON DELETE RESTRICT,
  action       TEXT NOT NULL CHECK (action IN (
                 'bounties:publish', 'applications:write', 'submissions:write'
               )),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  approved_at  TIMESTAMPTZ,
  consumed_at  TIMESTAMPTZ,
  CHECK (expires_at > requested_at),
  CHECK (expires_at <= requested_at + INTERVAL '15 minutes'),
  CHECK (consumed_at IS NULL OR approved_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR consumed_at >= approved_at)
);

CREATE INDEX IF NOT EXISTS idx_integration_confirmations_token ON integration_confirmations (token_id);
