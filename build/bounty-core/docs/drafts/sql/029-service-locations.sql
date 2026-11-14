-- 029-service-locations.sql (DRAFT, revised 2026-11-13: no coordinates)
-- The exact address of an on-site task, plus the region and time zone that let the server
-- format deadlines and visit windows for the person reading them. Kept until the business
-- removes it: there is no purge timer. Removal deletes the row and writes an audit entry
-- without the address.
CREATE TABLE IF NOT EXISTS service_locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id    UUID NOT NULL UNIQUE REFERENCES bounties(id) ON DELETE RESTRICT,
  address_text TEXT NOT NULL CHECK (char_length(address_text) BETWEEN 5 AND 500),
  region_code  CHAR(2) NOT NULL CHECK (region_code ~ '^[A-Z]{2}$'),
  time_zone    VARCHAR(64) NOT NULL CHECK (char_length(time_zone) BETWEEN 3 AND 64),
  created_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_locations_region ON service_locations (region_code);
