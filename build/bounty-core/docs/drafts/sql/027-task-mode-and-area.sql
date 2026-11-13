-- 027-task-mode-and-area.sql (DRAFT, revised 2026-11-13)
-- Additive. Remote tasks need no location. Public area fields are approximate (two decimals).
-- Currency: every task has one. Existing rows get NGN, the currency rewards have always used.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'NGN';
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_currency_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_currency_check
  CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE bounties ADD COLUMN IF NOT EXISTS task_mode VARCHAR(10) NOT NULL DEFAULT 'remote';
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS area_label VARCHAR(120);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS approx_lat NUMERIC(6,2);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS approx_lng NUMERIC(6,2);

ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_task_mode_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_task_mode_check
  CHECK (task_mode IN ('remote', 'onsite'));

ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_onsite_area_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_onsite_area_check
  CHECK (task_mode = 'remote' OR (
    area_label IS NOT NULL AND char_length(area_label) BETWEEN 1 AND 120
    AND approx_lat BETWEEN -90 AND 90 AND approx_lng BETWEEN -180 AND 180));

CREATE INDEX IF NOT EXISTS idx_bounties_onsite_open
  ON bounties (approx_lat, approx_lng) WHERE task_mode = 'onsite' AND status = 'open';
