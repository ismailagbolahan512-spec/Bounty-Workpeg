-- 029-service-locations.sql (DRAFT, revised 2026-11-13)
-- The exact address and pin of an onsite task. Kept until the business removes it: there is no
-- purge timer. Removal deletes the row and writes an audit entry without the address.
-- region_code and time_zone come from the location, so no one types a time zone by hand.
CREATE TABLE IF NOT EXISTS service_locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id    UUID NOT NULL UNIQUE REFERENCES bounties(id) ON DELETE RESTRICT,
  address_text TEXT NOT NULL CHECK (char_length(address_text) BETWEEN 5 AND 500),
  lat          NUMERIC(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          NUMERIC(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  region_code  CHAR(2) NOT NULL CHECK (region_code ~ '^[A-Z]{2}$'),
  time_zone    VARCHAR(64) NOT NULL CHECK (char_length(time_zone) BETWEEN 3 AND 64),
  created_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
