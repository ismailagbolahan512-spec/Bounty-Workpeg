-- ============================================================
-- ONE-TIME migration. Run once in Neon, AFTER schema-full.sql and
-- BEFORE merging/deploying the email verification code.
--
-- Accounts created before email verification existed are marked
-- verified so current users are not locked out. Do NOT rerun this
-- after new signups exist, or unverified new accounts would be
-- marked verified too.
-- ============================================================

UPDATE users
SET email_verified_at = NOW()
WHERE email_verified_at IS NULL;
