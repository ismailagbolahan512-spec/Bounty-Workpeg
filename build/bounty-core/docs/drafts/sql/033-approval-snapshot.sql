-- ============================================================
-- 033: approval snapshot. Stores the exact text the user approves, and the database checks
-- it against the approved hash. Additive: one column, two constraints, and the guard
-- function from 026 is replaced so the new column is locked the same way as the hash.
-- Not applied to production. Review before any database run.
-- ============================================================

ALTER TABLE integration_confirmations ADD COLUMN IF NOT EXISTS signed_text TEXT;

-- Size limit matches MAX_PAYLOAD_BYTES (4096) in services/integration-tokens.js.
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_signed_text_size_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_signed_text_size_check
  CHECK (signed_text IS NULL OR octet_length(signed_text) <= 4096);

-- The stored text must be exactly the text that was hashed. Checked by the database.
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_signed_text_hash_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_signed_text_hash_check
  CHECK (signed_text IS NULL OR encode(sha256(convert_to(signed_text, 'UTF8')), 'hex') = payload_hash);

-- Replaces the 026 guard. Same rules, plus signed_text cannot change once written.
CREATE OR REPLACE FUNCTION integration_confirmation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'integration confirmations cannot be deleted';
  END IF;
  IF NEW.token_id IS DISTINCT FROM OLD.token_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.signed_text IS DISTINCT FROM OLD.signed_text
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'the action and payload of a confirmation cannot be changed';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'an approval cannot be changed';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'a confirmation cannot be used twice';
  END IF;
  RETURN NEW;
END;
$$;
