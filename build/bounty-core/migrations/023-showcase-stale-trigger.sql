-- ============================================================
-- Marks showcase rows stale when a mirrored field changes, on every write path.
-- Additive only. Safe to run more than once.
-- Trigger rule: bump showcase_version and set showcase_state = 'stale' only when a mirrored
-- field or public_showcase changes. A sync that only sets showcase_state/showcase_synced_at
-- therefore never re-marks its own row.
-- ============================================================

ALTER TABLE bounties ADD COLUMN IF NOT EXISTS showcase_version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bounties_showcase_mark_stale() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.public_showcase THEN
      NEW.showcase_state := 'stale';
      NEW.showcase_version := 1;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.public_showcase IS DISTINCT FROM OLD.public_showcase THEN
    NEW.showcase_state := 'stale';
    NEW.showcase_version := OLD.showcase_version + 1;
    RETURN NEW;
  END IF;

  IF NEW.public_showcase AND (
       (NEW.title, NEW.category, NEW.reward_amount, NEW.deadline, NEW.status, NEW.public_summary)
       IS DISTINCT FROM
       (OLD.title, OLD.category, OLD.reward_amount, OLD.deadline, OLD.status, OLD.public_summary)
     ) THEN
    NEW.showcase_state := 'stale';
    NEW.showcase_version := OLD.showcase_version + 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bounties_showcase_mark_stale_trg ON bounties;
CREATE TRIGGER bounties_showcase_mark_stale_trg
  BEFORE INSERT OR UPDATE ON bounties
  FOR EACH ROW EXECUTE FUNCTION bounties_showcase_mark_stale();
