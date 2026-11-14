# Location-aware physical services: implementation plan

Status: plan for review. Nothing here is implemented. No migration in this document is in `migrations/`, and none has been applied to any database. The SQL below is a draft for review; it is moved into `migrations/` only after approval of the final version.

Approved in principle (2026-11-13): `task_mode`, location for physical requests, provider service area, `appointments`, `quotations`, `service_locations`, manual map pin with typed address, exact addresses private until a confirmed appointment, distance and availability matching kept modular.

Still required before any migration is applied: the reviewed SQL (section 4), the Leaflet vendoring decision (section 5.2), and the scope addition for appointments (section 7.2).

## 1. Scope and boundaries

- Bounty remains the marketplace and system of record. Physical services extend the existing task model; digital tasks are unchanged.
- Remote tasks do not require any location data. Every existing route and test for digital tasks must pass unchanged.
- No payment or escrow code. The customer approval state is shown; no funds are simulated or released. The "payment" step reads "not connected" in the demo.
- No external geocoding service. The customer types an address and places a pin on a map. Coordinates come from the pin.
- No PostGIS or other geographic extension for the hackathon. Distance is straight-line (haversine) computed in application code, with a bounding-box prefilter in SQL.
- Roles, permissions and approvals stay in PostgreSQL. Workpeg never approves, accepts, or changes roles.

## 2. Architecture

```
Browser (public/)                Bounty API (Express)                  PostgreSQL (Neon)
 map pin + address  ───────────▶  routes/physical.js (new)  ──────────▶  bounties (task_mode, area)
 Leaflet (self-hosted)            services/location.js (new)            service_locations (private)
                                  services/location-matching.js (new)   provider_service_areas
                                  routes/integration-tokens.js          quotations, appointments
                                  routes/peg.js (+ physical actions)
                                                  ▲
Workpeg Peg (SDK)  ── integration token (bnt_wp_, scoped) ──┘
  Workpeg AI asks for an action → user approves in Bounty → Bounty runs it
```

Who can see what:

| Data | Business (owner) | Provider (applicant) | Provider (accepted, appointment confirmed) | Public / Workpeg read | Admin |
|---|---|---|---|---|---|
| Area label and rounded coordinates | yes | yes | yes | yes | yes |
| Provider distance band (e.g. "under 5 km") | yes | no | no | no | no |
| Exact customer address and pin | yes | no | yes, only after confirmation | no | no (audit only) |
| Provider base coordinates | own only | own only | no (distance band only) | no | no |
| Quotations | all received | own only | own only | no | no |

## 3. Location privacy model

Three levels of location exist, and only the first is ever public:

1. **Area (public).** `bounties.area_label` (e.g. "Victoria Island, Lagos") and `approx_lat`/`approx_lng` rounded to two decimal places, roughly one kilometre. Shown in listings and to workers before they apply.
2. **Service address (private).** `service_locations`: the typed address and the exact pin. Read by a single server function, `getServiceAddress(viewer, bountyId)`, that returns the address only when the viewer is the business owner, or the selected provider with a confirmed appointment that has not been cancelled. The function is the only code path that reads this table. Responses to any other caller omit the address entirely, never a masked version.
3. **Provider base (private).** `provider_service_areas`: the provider's base coordinates and radius. Used server-side for matching. Never returned to customers. Customers see only a distance band computed on the server.

Rules:
- Coordinates are validated on write (range checks), and rounded for the public fields on the server, never trusted from the client.
- Addresses and exact coordinates never appear in logs, audit details, error messages or Workpeg responses. Audit entries record that an address was read, not what it was.
- The Peg's `/bounties` endpoint returns only level 1 fields (see the Peg section).
- Changing the address after a confirmed appointment cancels the confirmation and notifies both parties.

## 4. Proposed database schema and migrations

Order: 027, 028, 029, 030, 031, 032. Migration 026 (confirmation immutability) is already on the branch. Each migration is additive, idempotent and tested on a scratch database before it is moved into `migrations/`.

### 4.1 Migration 027: task mode and public area on bounties

```sql
-- 027-task-mode-and-area.sql (DRAFT)
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

Existing rows get `task_mode = 'remote'` and no area, so they satisfy the constraint unchanged.

### 4.2 Migration 028: provider service areas

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

A separate table, not columns on `users`, so that a provider's coordinates cannot leak through any existing `SELECT *` or public profile query.

### 4.3 Migration 029: private service addresses

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

Only one address per onsite task. Reads go through `getServiceAddress` (section 3). Not append-only, because a business may correct an address; each change is audited without its content.

### 4.4 Migration 030: quotations

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

A quotation is a proposal. Accepting one changes its status and assigns the bounty through the existing assignment path. It moves no money.

### 4.5 Migration 031: appointments

```sql
-- 031-appointments.sql (DRAFT)
CREATE TABLE IF NOT EXISTS appointments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id             UUID NOT NULL REFERENCES bounties(id) ON DELETE RESTRICT,
  provider_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'confirmed', 'cancelled', 'superseded')),
  proposed_by           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_confirmed_at TIMESTAMPTZ,
  business_confirmed_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'confirmed'
         OR (provider_confirmed_at IS NOT NULL AND business_confirmed_at IS NOT NULL))
);

-- At most one live appointment per task.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_appointment_per_bounty
  ON appointments (bounty_id) WHERE status IN ('proposed', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_appointments_provider_time
  ON appointments (provider_id, starts_at);
```

The rule that the appointment ends before the task deadline cannot be a CHECK constraint across tables. It is enforced in the route and tested.

### 4.6 Migration 032: appointment scope on integration tokens

Adds `appointments:write` to the two lists that migrations 024 and 025 constrain. Both are CHECK constraints, so they are dropped and recreated with the new value. No rows change.

```sql
-- 032-appointment-scope.sql (DRAFT)
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scopes_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 7
  AND scopes <@ ARRAY['bounties:read','bounties:draft','bounties:publish',
    'applications:write','submissions:write','workspace:read','appointments:write']::TEXT[]);

ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_action_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_action_check CHECK (action IN (
  'bounties:publish', 'applications:write', 'submissions:write', 'appointments:write'));
```

Dropping and re-adding these constraints is a schema change in the CHECK sense only. It must be reviewed with the other migrations.

## 5. Map and address entry

### 5.1 Flow
1. The business types an address. The address is stored as text and is not geocoded.
2. A map opens centred on the typed area or on Lagos by default. The business drags a pin to the exact entrance.
3. The pin's coordinates are sent with the address. The server validates ranges and derives the public area and rounded coordinates.
4. The business sees a warning if the pin is more than 50 km from the typed area label. This is a sanity check, not verification.

### 5.2 Library choice

The app has no map library. The proposal is **Leaflet**, self-hosted.
- Leaflet's script and stylesheet are copied into `public/vendor/leaflet/`, because the Content Security Policy only allows scripts from `'self'`.
- Map tiles come from OpenStreetMap over HTTPS. The CSP already allows images from any `https:` origin, so the tiles need no policy change. Tile requests reveal the map view to the tile provider, which is noted as a known limit.
- No npm dependency is added. Vendoring two files is the only change.

This needs your approval. The alternative is a coordinate entry form with no map, which is simpler but weaker for a demo.

## 6. Provider discovery and matching

### 6.1 Discovery (customer-facing and Peg)

For a provider, `GET /api/physical/nearby` returns onsite open tasks where:
- the provider has a service area;
- the task is within the provider's radius, or the provider is willing to travel and the task is within the wider limit;
- the task's category matches a category the provider declares or has demonstrated;
- the task is still open and before its deadline.

The response contains area label, distance band, category, reward and deadline. It never contains addresses, exact coordinates, or the provider's own position.

### 6.2 Scoring

A new pure module, `services/location-matching.js`, with no database access, so it can be tested and replaced later. Score components, weights summing to 1:

| Factor | Weight | Rule |
|---|---|---|
| Category and skill fit | 0.35 | Reuse the existing demonstrated and declared scores from `services/matching.js` |
| Distance | 0.25 | `1 - distance / radius`, clamped to 0..1. Willing-to-travel providers beyond their radius get at most 0.3 |
| Availability | 0.25 | Overlap between the task window and the provider's weekly hours or proposed slots. Missing data scores neutral (0.5), never negative |
| Completion history | 0.15 | Share of past assigned tasks completed and reviewed well. New providers score neutral |

Rules:
- Distance does not dominate. A qualified, available provider slightly farther away outranks a distant one.
- Missing data is neutral, never penalising, as in the existing matching module.
- No protected characteristics. The existing list in `matching.js` applies unchanged.
- The module returns scores and reasons, and the reasons are shown to the customer.

The header of `services/matching.js` currently says "Location is not used at all". That statement must change, and the change is tested, because the physical path uses this module and the digital path does not.

### 6.3 Distance

Haversine on rounded provider and task coordinates, plus a bounding-box prefilter in SQL to keep queries small. Straight-line distance is stated to users as "about N km", not as travel time.

## 7. Appointment and quotation workflows

### 7.1 States

Quotation: `pending` → `accepted` | `declined` | `withdrawn` | `expired`.

Appointment: `proposed` → `confirmed` | `cancelled` | `superseded`.
- A confirmed appointment needs both `provider_confirmed_at` and `business_confirmed_at`.
- Proposing a new time marks the previous live appointment `superseded` in the same transaction, and it needs fresh confirmation from both parties.

### 7.2 Steps

1. **Publish request.** The business creates an onsite bounty with category, description, deadline, budget, address and pin. Through Workpeg this is a sensitive action (`bounties:publish`).
2. **Discover.** Providers see nearby requests within their radius (section 6.1).
3. **Quote.** A provider submits a quotation (amount, note). Through Workpeg this is a sensitive action under `applications:write`.
4. **Accept quotation.** The business accepts one quotation in Bounty. The bounty is assigned through the existing assignment path, other quotations are declined, and the business is not charged anything.
5. **Propose appointment.** The provider proposes a window that falls inside the task deadline. Through Workpeg this is a sensitive action (`appointments:write`).
6. **Confirm.** The business confirms. The provider confirms. When both have confirmed, the appointment is `confirmed` and the precise address becomes readable to the provider. Each confirmation is a separate action; neither can confirm for the other.
7. **Change.** Either party proposes a new window. The old appointment is superseded. Both must reconfirm.
8. **Attend and complete.** The provider submits completion evidence (photos, a short report) through the existing submission and file routes. The task is never marked complete just because the appointment time has passed.
9. **Review.** The business approves, requests revision, or raises a dispute, through existing routes. Approval is recorded. No payment is released; the demo shows "payment: not connected".
10. **Reviews.** Existing review routes apply after approval.

Linen scenario in these terms: the hotel's task has a deadline of 2 PM, a collection window in the morning and a delivery window before the deadline. The provider's proposed appointment must end before 2 PM. Completion evidence is a delivery photo and a count of replacement items; the hotel confirms receipt in Bounty.

## 8. Workpeg operations and authorisation

| Operation | Kind | Scope | Approval in Bounty |
|---|---|---|---|
| List nearby onsite requests (area only) | read | `bounties:read` | not needed |
| Get own request, public fields | read | `bounties:read` | not needed |
| Publish onsite request | write | `bounties:publish` | yes, exact payload |
| Submit quotation | write | `applications:write` | yes, exact payload |
| Propose or confirm appointment | write | `appointments:write` | yes, exact payload |
| Submit completion evidence | write | `submissions:write` | yes, exact payload |
| Accept quotation, approve completion, raise dispute | not offered to Workpeg | none | done by the user in Bounty directly |
| Read service address | not offered to Workpeg | none | not offered |

Rules for the Peg:
- The token's scope and the owner's current role are checked on every request (existing `requireScope`).
- A business token cannot quote; a worker token cannot publish or accept.
- A confirmation covers one action and one payload. Changing the address, the window or the amount needs a new approval.
- The Peg's read responses use the same public fields as the web listing and are tested for absence of addresses and coordinates.

## 9. Security considerations

- **Address leakage.** The address table is read only by `getServiceAddress`. Tests check that public listing, nearby, Peg, public profile and admin list responses contain no address, pin or provider coordinates.
- **IDOR.** Every route that takes a bounty or appointment id checks the caller is the owner, the selected provider, or (for the public area) anyone signed in. Tests cover cross-business and cross-provider access.
- **Injection.** Coordinates are numeric and range-checked; address text is stored and rendered as text, never as markup.
- **Enumeration.** Distance bands are coarse (e.g. "under 5 km", "5 to 15 km") so a provider's exact position cannot be triangulated from repeated queries. Results are rate limited per user.
- **Replay.** Confirmation tokens are single use (migration 025 and 026). Appointment confirmations are tied to the current `starts_at` and `ends_at`.
- **Logging.** No address or coordinate in logs, audit details or error text.
- **Third parties.** Only OpenStreetMap tile requests leave the site. No geocoder, no analytics on the map.

## 10. Testing strategy

Each item below is added before its code, and every existing suite must still pass.

1. **Schema (scratch database).** Each migration applies cleanly on top of the previous one, and the constraints are checked with valid and invalid rows (the same method as migrations 024 to 026).
2. **Pure matching.** Unit tests for the scoring module: distance beyond radius, willingness to travel, neutral missing data, no negative scores for missing fields, ordering where a qualified nearby provider beats a distant one, and a slightly farther but available provider can outrank.
3. **Privacy.** Route tests for every public and Peg response: no address, pin or provider coordinates; the provider sees the address only after both confirmations; a cancelled appointment removes access; the admin list shows no address.
4. **Rounding and validation.** Out-of-range coordinates rejected; public coordinates rounded server-side even when the client sends more precision.
5. **Appointment rules.** Window must end before the deadline; both confirmations required; a change supersedes the old window; one live appointment per task.
6. **Quotations.** One quotation per provider per task; accepting one declines the others; a worker cannot quote on a remote-only task that does not accept quotations (if any).
7. **Peg.** Each sensitive operation needs a confirmation; payload changes after approval are refused; a business token cannot quote and a worker token cannot publish.
8. **Remote tasks.** The full existing suite passes unchanged, and a remote task never needs a location.
9. **Browser.** Map pin placement, typed-address warning, and the public listing showing an area only. Run headless with the existing Playwright setup, on desktop and phone width.
10. **End to end.** The linen scenario on a local database, run through the routes, including one refused change of address after confirmation.

## 11. Hackathon demonstration sequence

Primary (location-aware, physical):
1. Hotel manager asks Workpeg for emergency linen replenishment before 2 PM. Workpeg asks for the missing details (quantities, collection and delivery windows).
2. Workpeg publishes an onsite request through the Peg. The hotel approves the exact request in Bounty.
3. Public listing shows the area only, "Victoria Island, Lagos", and the category.
4. A nearby laundry provider sees the request, sends a quotation through Workpeg, and the hotel approves that quotation's details.
5. The hotel accepts the quotation in Bounty. Other quotations are declined.
6. The provider proposes a collection and delivery window ending before 2 PM. The hotel confirms; the provider confirms. The precise address becomes visible to the provider only now.
7. The provider completes collection and delivery and submits a photo and count. The hotel approves in Bounty.
8. The screen shows "payment: not connected" and the intended workflow. No money moves, and the demo says so.

Secondary (digital, same marketplace): the hotel posts a website-development task, a worker applies, and submission and approval run through the existing flow, without any location step.

## 12. Known limitations and deferred features

- **No payment.** Funds are never held, released or simulated. Revisit separately.
- **Manual location.** Coordinates come from a pin the user places. Nothing checks the pin against the typed address beyond a distance warning.
- **Straight-line distance.** Not road or traffic time. Lagos traffic will make distance an approximation.
- **Coarse public location.** Two decimal places, roughly a kilometre. Finer public location is deferred.
- **Map tiles.** OpenStreetMap receives map requests from viewers' browsers.
- **Ratings.** Used only where reviews already exist. New providers score neutral.
- **Notifications.** Use the existing notifications route. No push or SMS.
- **Scheduling.** No recurring appointments and no calendar sync.
- **Geographic queries.** No PostGIS. Revisit if the number of onsite tasks grows.
- **Workpeg scheduling.** Workpeg does not run scheduled actions yet, so provider searches are on demand.

## 13. Decisions needed before implementation

1. Approve Leaflet vendored under `public/vendor/leaflet/`, with OpenStreetMap tiles (section 5.2).
2. Approve migration 032 and the `appointments:write` scope (section 4.6, section 8).
3. Approve the review of migrations 027 to 031 as drafted in section 4.
4. Confirm both parties must confirm an appointment (section 7.2, step 6).
5. Confirm the public area precision of two decimal places (section 3).
6. Confirm the distance bands for public and provider views: "under 5 km", "5 to 15 km", "over 15 km".

## 14. Implementation sequence (after approval)

1. Migrations 027 to 032 applied to a scratch database, with constraint tests. Not applied to any shared database without a separate decision.
2. Pure matching module and its tests.
3. Address and area services, with the privacy tests.
4. Routes: physical request create and publish, nearby, quotations, appointments, change, completion link.
5. Peg operations and confirmations for the four sensitive actions.
6. Map UI with self-hosted Leaflet, with browser tests.
7. Linen scenario end to end on a local database.
8. Full existing suite, then commit and push on the feature branch. No merge, no deploy.
