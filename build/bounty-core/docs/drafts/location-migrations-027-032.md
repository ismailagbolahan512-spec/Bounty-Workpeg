# Location migrations: drafts for review (027 to 032)

Status: APPROVED SQL (2026-11-13), applied to a LOCAL SCRATCH database only, 37 rule checks passing
(scripts/location-schema-test.sql). Not applied to the shared database or production. Not in `migrations/`.
Each draft is additive. Nothing drops or rewrites an existing object, except the two CHECK
constraints replaced in 032, which are named below.

Order: 026 (already on branch) → 027 → 028 → 029 → 030 → 031 → 032.

Conflicts checked against the existing repository (2026-11-13):
- No existing table or column named `task_mode`, `area_label`, `approx_lat`, `approx_lng`,
  `provider_service_areas`, `service_locations`, `quotations`, `appointments` or `appointment_events`.
- `reject_append_only_change()` exists (migration 015) and is reused by `appointment_events`.
- The assignment path is `bounty_participants` (migration 008). Accepting a quotation reuses it;
  no new assignment table.
- Constraint names replaced in 032 match what Postgres generated for migrations 024 and 025:
  `integration_tokens_scopes_check` and `integration_confirmations_action_check`.

---

## 027-task-mode-and-area.sql

Changes: adds `task_mode` (default `remote`), and public area fields on `bounties`.
Existing rows are unaffected.

```sql
-- 027-task-mode-and-area.sql (DRAFT)
-- Additive. Remote tasks need no location. Public fields are approximate only (two decimals).
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
```

Rollback (not executed). Safe only when no onsite rows exist:
```sql
-- 027-rollback.sql (DRAFT, do not run)
-- Guard: SELECT count(*) FROM bounties WHERE task_mode = 'onsite';  must be 0 first.
DROP INDEX IF EXISTS idx_bounties_onsite_open;
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_onsite_area_check;
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_task_mode_check;
ALTER TABLE bounties DROP COLUMN IF EXISTS approx_lng;
ALTER TABLE bounties DROP COLUMN IF EXISTS approx_lat;
ALTER TABLE bounties DROP COLUMN IF EXISTS area_label;
ALTER TABLE bounties DROP COLUMN IF EXISTS task_mode;
```

---

## 028-provider-service-areas.sql

Changes: new table `provider_service_areas`, kept separate from `users` so provider coordinates
cannot leak through existing `SELECT *` or public profile queries.

```sql
-- 028-provider-service-areas.sql (DRAFT)
CREATE TABLE IF NOT EXISTS provider_service_areas (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  area_label        VARCHAR(120) NOT NULL CHECK (char_length(area_label) BETWEEN 1 AND 120),
  base_lat          NUMERIC(9,6) NOT NULL CHECK (base_lat BETWEEN -90 AND 90),
  base_lng          NUMERIC(9,6) NOT NULL CHECK (base_lng BETWEEN -180 AND 180),
  radius_km         SMALLINT NOT NULL CHECK (radius_km BETWEEN 1 AND 200),
  willing_to_travel BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_service_areas_coords
  ON provider_service_areas (base_lat, base_lng);
```

Rollback (not executed). Safe only when the table holds no data the business needs:
```sql
-- 028-rollback.sql (DRAFT, do not run)
DROP TABLE IF EXISTS provider_service_areas;
```

---

## 029-service-locations.sql

Changes: new table `service_locations`: the exact customer address and pin. Read only through
one server function (`getServiceAddress`). Not append-only, because a business may correct an
address. Every change is audited without its content.

```sql
-- 029-service-locations.sql (DRAFT)
CREATE TABLE IF NOT EXISTS service_locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id    UUID NOT NULL UNIQUE REFERENCES bounties(id) ON DELETE RESTRICT,
  address_text TEXT NOT NULL CHECK (char_length(address_text) BETWEEN 5 AND 500),
  lat          NUMERIC(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          NUMERIC(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  created_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Rollback (not executed). Deletes private addresses. Export first:
```sql
-- 029-rollback.sql (DRAFT, do not run)
DROP TABLE IF EXISTS service_locations;
```

---

## 030-quotations.sql

Changes: new table `quotations`. A quotation is a proposal. It moves no money. Accepting one
assigns the provider through `bounty_participants`.

```sql
-- 030-quotations.sql (DRAFT)
CREATE TABLE IF NOT EXISTS quotations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id   UUID NOT NULL REFERENCES bounties(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 9999999999.99),
  currency    CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  note        TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bounty_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_quotations_bounty ON quotations (bounty_id, status);
```

Rollback (not executed). Deletes quotes. Export first:
```sql
-- 030-rollback.sql (DRAFT, do not run)
DROP TABLE IF EXISTS quotations;
```

---

## 031-appointments.sql (revised)

Changes, against the earlier draft:
- Each party's confirmation records who confirmed and when (`*_confirmed_by`, `*_confirmed_at`).
- A confirmed appointment needs both confirmations, from different people.
- Any proposed change creates a new `proposed` row and marks the old one `superseded`, so both
  parties must confirm again. Confirmations never carry over.
- New `appointment_events`: an append-only history of proposals, confirmations, changes and
  address disclosures. Event details never contain an address or coordinates.

```sql
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
```

Application rules, enforced in code and tested (not expressible as CHECK):
- The appointment ends before the task deadline.
- The provider confirms only as the provider; the business confirms only as the business.
- A confirmed appointment's address becomes readable to the provider only after both confirmations,
  and each read records an `address_disclosed` event with no address in it.

Rollback (not executed). Deletes the appointment history. Export first:
```sql
-- 031-rollback.sql (DRAFT, do not run)
DROP TABLE IF EXISTS appointment_events;
DROP TABLE IF EXISTS appointments;
```

---

## 032-appointment-scope.sql

Changes: adds `appointments:write` to the two CHECK constraints that list scopes and
confirmation actions. Replaces `integration_tokens_scopes_check` (from 024) and
`integration_confirmations_action_check` (from 025). No row changes.

```sql
-- 032-appointment-scope.sql (DRAFT)
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scopes_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 7
  AND scopes <@ ARRAY[
    'bounties:read', 'bounties:draft', 'bounties:publish',
    'applications:write', 'submissions:write', 'workspace:read', 'appointments:write'
  ]::TEXT[]);

ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_action_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_action_check CHECK (
  action IN ('bounties:publish', 'applications:write', 'submissions:write', 'appointments:write'));
```

Rollback (not executed). Guard first: no token may hold `appointments:write`, and no
confirmation may use it:
```sql
-- 032-rollback.sql (DRAFT, do not run)
-- Guard: SELECT count(*) FROM integration_tokens WHERE 'appointments:write' = ANY(scopes);  must be 0
-- Guard: SELECT count(*) FROM integration_confirmations WHERE action = 'appointments:write';  must be 0
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scopes_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 6
  AND scopes <@ ARRAY['bounties:read', 'bounties:draft', 'bounties:publish',
    'applications:write', 'submissions:write', 'workspace:read']::TEXT[]);
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_action_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_action_check CHECK (
  action IN ('bounties:publish', 'applications:write', 'submissions:write'));
```

---

## Corrections to the plan (location-services-plan.md)

- Section 6.1 and 6.3 said distance uses rounded task coordinates. Corrected: distance and filtering
  use the exact pin in `service_locations` and the provider's exact base in `provider_service_areas`,
  both server-side. Public responses use only the two-decimal area and the three distance bands.
- Section 7.2 step 6 says both parties confirm. Corrected to match decision 4: a change returns the
  appointment to both-party confirmation, and `appointment_events` records each step.
