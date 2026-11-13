-- 030-quotations.sql (DRAFT, revised 2026-11-13)
-- A quotation is a proposal and moves no money. Its amount is in the task's currency
-- (bounties.currency), so there is no currency column here.
CREATE TABLE IF NOT EXISTS quotations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 9999999999.99),
  note        TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A provider may quote again after a decline, withdrawal or expiry: at most one PENDING quote.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_quote
  ON quotations (bounty_id, provider_id) WHERE status = 'pending';
-- One accepted quote per task.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_accepted_quote
  ON quotations (bounty_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_quotations_bounty ON quotations (bounty_id, status);
