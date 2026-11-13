-- ============================================================
-- 024: integration tokens (Workpeg, scoped and revocable). Additive only; nothing is dropped
-- or rewritten. Run once after 023, on a test database first. Not applied to production.
-- Design: docs/workpeg-identity-design.md, section 3.1.
-- Only a SHA-256 hash of each token is stored. The plaintext is shown once, at issue.
-- ============================================================

CREATE TABLE IF NOT EXISTS integration_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash     TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label          TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  scopes         TEXT[] NOT NULL CHECK (
                   cardinality(scopes) BETWEEN 1 AND 6
                   AND scopes <@ ARRAY[
                     'bounties:read', 'bounties:draft', 'bounties:publish',
                     'applications:write', 'submissions:write', 'workspace:read'
                   ]::TEXT[]
                 ),
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 200),
  rotated_from   UUID REFERENCES integration_tokens(id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_user ON integration_tokens (user_id);
