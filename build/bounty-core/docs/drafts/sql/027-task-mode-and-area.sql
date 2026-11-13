-- 027-task-mode-and-area.sql (DRAFT, revised 2026-11-13: no coordinates)
-- Additive. Remote tasks need no location. On-site tasks need an area label.
-- Currency: every task has one. Existing rows get NGN, the currency rewards have always used.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'NGN';
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_currency_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_currency_check
  CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE bounties ADD COLUMN IF NOT EXISTS task_mode VARCHAR(10) NOT NULL DEFAULT 'remote';
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS area_label VARCHAR(120);

ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_task_mode_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_task_mode_check
  CHECK (task_mode IN ('remote', 'onsite'));

-- On-site tasks must say which area they are in. The pin was dropped; the business types
-- the address, and providers decide from the area label if they can reach.
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_onsite_area_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_onsite_area_check
  CHECK (task_mode = 'remote' OR (
    area_label IS NOT NULL AND char_length(area_label) BETWEEN 1 AND 120));

CREATE INDEX IF NOT EXISTS idx_bounties_onsite_open
  ON bounties (area_label) WHERE task_mode = 'onsite' AND status = 'open';
