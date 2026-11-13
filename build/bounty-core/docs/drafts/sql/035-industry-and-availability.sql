-- 035-industry-and-availability.sql (DRAFT, 2026-11-13)
-- Additive. Businesses record the industry they run; a business's request records the industry
-- and the services it needs (catalogue labels or typed ones). Workers record the kind of work
-- they take (on-site, remote or both) and the hours they are available, in their own time zone.
-- Not applied to the shared database. Apply only after a named approval.

ALTER TABLE users ADD COLUMN IF NOT EXISTS industry VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_modes TEXT[] NOT NULL DEFAULT '{}';
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
