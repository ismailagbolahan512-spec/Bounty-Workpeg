-- 035-industry-and-availability.sql (DRAFT, revised 2026-11-13)
-- Additive. Businesses record the industry they run; a business's request records the industry
-- and the services it needs. Workers record the kind of work they take (on-site, remote or
-- both), the areas they serve (text), and the hours they are free, in their own time zone.

ALTER TABLE users ADD COLUMN IF NOT EXISTS industry VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_modes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_area VARCHAR(240);
ALTER TABLE users ADD COLUMN IF NOT EXISTS available_start TIME;
ALTER TABLE users ADD COLUMN IF NOT EXISTS available_end TIME;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_industry_check;
ALTER TABLE users ADD CONSTRAINT users_industry_check
  CHECK (industry IS NULL OR industry ~ '^[a-z_]{2,40}$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_work_modes_check;
ALTER TABLE users ADD CONSTRAINT users_work_modes_check
  CHECK (work_modes <@ ARRAY['onsite', 'remote']::text[]);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_available_pair_check;
ALTER TABLE users ADD CONSTRAINT users_available_pair_check
  CHECK ((available_start IS NULL) = (available_end IS NULL));

-- bounties.industry already exists (execution-mode catalogue, migration 008); use service_industry.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS service_industry VARCHAR(40);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS service_labels TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_service_labels_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_service_labels_check
  CHECK (cardinality(service_labels) <= 10);
