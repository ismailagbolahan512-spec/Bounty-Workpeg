-- ============================================================
-- 026: integration confirmations are immutable where it matters. Additive only (a new function
-- and trigger; nothing dropped or rewritten). Run once after 025, on a test database first.
-- Not applied to production. Design: docs/workpeg-identity-design.md, section 3.4.
--
-- Once a confirmation is requested, its token, action, payload hash, request time and expiry
-- can never change. Approval and consumption are each recorded once, and cannot be undone or
-- moved. Rows cannot be deleted, so the record of what was approved stays.
-- ============================================================

CREATE OR REPLACE FUNCTION integration_confirmation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'integration confirmations cannot be deleted';
  END IF;
  IF NEW.token_id IS DISTINCT FROM OLD.token_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
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

DROP TRIGGER IF EXISTS integration_confirmations_guard_trg ON integration_confirmations;
CREATE TRIGGER integration_confirmations_guard_trg
  BEFORE UPDATE OR DELETE ON integration_confirmations
  FOR EACH ROW EXECUTE FUNCTION integration_confirmation_guard();
