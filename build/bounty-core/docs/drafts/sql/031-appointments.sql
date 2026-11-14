-- 031-appointments.sql (DRAFT, revised)
CREATE TABLE IF NOT EXISTS appointments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id              UUID NOT NULL REFERENCES bounties(id) ON DELETE RESTRICT,
  provider_id            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at              TIMESTAMPTZ NOT NULL,
  ends_at                TIMESTAMPTZ NOT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed', 'confirmed', 'cancelled', 'superseded')),
  proposed_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_confirmed_at  TIMESTAMPTZ,
  provider_confirmed_by  UUID REFERENCES users(id) ON DELETE RESTRICT,
  business_confirmed_at  TIMESTAMPTZ,
  business_confirmed_by  UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK ((provider_confirmed_at IS NULL) = (provider_confirmed_by IS NULL)),
  CHECK ((business_confirmed_at IS NULL) = (business_confirmed_by IS NULL)),
  CHECK (status <> 'confirmed' OR (
    provider_confirmed_at IS NOT NULL AND business_confirmed_at IS NOT NULL
    AND provider_confirmed_by <> business_confirmed_by))
);

-- At most one live appointment per task. A change must supersede the old row in the same
-- transaction, before the new row is inserted, or this index rejects it.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_appointment_per_bounty
  ON appointments (bounty_id) WHERE status IN ('proposed', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_appointments_provider_time
  ON appointments (provider_id, starts_at);

CREATE TABLE IF NOT EXISTS appointment_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  actor_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event          VARCHAR(30) NOT NULL CHECK (event IN (
                   'proposed', 'confirmed_by_provider', 'confirmed_by_business',
                   'cancelled', 'superseded', 'address_disclosed')),
  details        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(details::text) <= 2048),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_events_appointment
  ON appointment_events (appointment_id, created_at);

-- Evidence is never edited or deleted. Uses the function created in migration 015.
CREATE OR REPLACE TRIGGER appointment_events_append_only
  BEFORE UPDATE OR DELETE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
