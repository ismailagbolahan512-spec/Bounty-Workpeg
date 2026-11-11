-- 007: review reasons, funding flag and completion checklists.
-- Additive only: new nullable or defaulted columns. Safe to run twice.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Funding is 'unfunded' until a payment service records a deposit.
-- Nothing in this release can set it to 'funded'.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS funding_status VARCHAR(20) NOT NULL DEFAULT 'unfunded';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bounties_funding_status_check') THEN
    ALTER TABLE bounties ADD CONSTRAINT bounties_funding_status_check
      CHECK (funding_status IN ('unfunded', 'funded'));
  END IF;
END $$;

-- What "done" means for the task, written by the business. JSON array of short strings.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS completion_checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
