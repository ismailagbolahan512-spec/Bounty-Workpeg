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
-- 032-appointment-scope.sql (DRAFT, revised 2026-11-13)
-- Widens the allowed integration-token scopes to include hospitality scopes:
--   services:read     — business-only, used by the Workpeg peg to read a business's own requests
--   appointments:write — reserved for a future write path (not used yet)
-- The scopes list is validated in code before this CHECK runs, so a bad role still fails fast.
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scopes_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 8
  AND scopes <@ ARRAY[
    'bounties:read', 'bounties:draft', 'bounties:publish',
    'applications:write', 'submissions:write', 'workspace:read',
    'services:read', 'appointments:write'
  ]::TEXT[]);

ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_action_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_action_check CHECK (
  action IN ('bounties:publish', 'applications:write', 'submissions:write', 'appointments:write'));
-- ============================================================
-- 033: approval snapshot. Stores the exact text the user approves, and the database checks
-- it against the approved hash. Additive: one column, two constraints, and the guard
-- function from 026 is replaced so the new column is locked the same way as the hash.
-- Not applied to production. Review before any database run.
-- ============================================================

ALTER TABLE integration_confirmations ADD COLUMN IF NOT EXISTS signed_text TEXT;

-- Size limit matches MAX_PAYLOAD_BYTES (4096) in services/integration-tokens.js.
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_signed_text_size_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_signed_text_size_check
  CHECK (signed_text IS NULL OR octet_length(signed_text) <= 4096);

-- The stored text must be exactly the text that was hashed. Checked by the database.
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_signed_text_hash_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_signed_text_hash_check
  CHECK (signed_text IS NULL OR encode(sha256(convert_to(signed_text, 'UTF8')), 'hex') = payload_hash);

-- Replaces the 026 guard. Same rules, plus signed_text cannot change once written.
CREATE OR REPLACE FUNCTION integration_confirmation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'integration confirmations cannot be deleted';
  END IF;
  IF NEW.token_id IS DISTINCT FROM OLD.token_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.signed_text IS DISTINCT FROM OLD.signed_text
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'the action and payload of a confirmation cannot be changed';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'an approval cannot be changed';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'a confirmation cannot be used twice';
  END IF;
  RETURN NEW;
END;
$$;
-- 034-appointment-messages.sql (DRAFT, for review, not applied)
-- Chat for one appointment, between its provider and its business, plus short status lines
-- such as "on my way". Append-only: a message is never edited or deleted, the same rule as the
-- appointment history. Author must be a party to the appointment: enforced in code (not a CHECK).
CREATE TABLE IF NOT EXISTS appointment_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  author_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind           VARCHAR(10) NOT NULL CHECK (kind IN ('message', 'status')),
  body           TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000),
  status_code    VARCHAR(20) CHECK (status_code IN ('on_the_way', 'arrived', 'started', 'finished')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'message' AND body IS NOT NULL AND status_code IS NULL)
    OR (kind = 'status' AND status_code IS NOT NULL AND body IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_appointment_messages_thread
  ON appointment_messages (appointment_id, created_at);

CREATE OR REPLACE TRIGGER appointment_messages_append_only
  BEFORE UPDATE OR DELETE ON appointment_messages
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
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

-- 036-worker-notes-urgent-reviews
-- What the worker needs to know (gate codes, parking, who to ask): shown with the address only
-- after both sides confirm. urgent marks a guest who is waiting, so providers see it first.
ALTER TABLE service_locations ADD COLUMN IF NOT EXISTS worker_notes TEXT
  CHECK (worker_notes IS NULL OR char_length(worker_notes) <= 500);
ALTER TABLE service_locations ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT FALSE;

-- One review per person per visit, after the provider marks the visit finished.
CREATE TABLE IF NOT EXISTS service_reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  reviewer_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rating         SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  note           TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (appointment_id, reviewer_id)
);

-- 037-payment-made
-- Hospitality is paid directly between the two sides. Nothing is held in escrow and no money moves
-- through Bounty. Each side records that payment was made or received; the visit is paid once both have.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS business_paid_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider_received_at TIMESTAMPTZ;
ALTER TABLE appointment_events DROP CONSTRAINT IF EXISTS appointment_events_event_check;
ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_event_check CHECK (event IN (
  'proposed', 'confirmed_by_provider', 'confirmed_by_business',
  'cancelled', 'superseded', 'address_disclosed',
  'payment_made_marked', 'payment_received_marked'));
