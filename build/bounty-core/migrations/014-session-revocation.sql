-- 014: session revocation. Logout sets this column; any login token issued before it is
-- rejected by the authentication middleware. Additive and idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_after TIMESTAMPTZ;
