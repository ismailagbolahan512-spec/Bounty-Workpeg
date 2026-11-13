# Hospitality services: schema review pack (step 1)

Status: REVIEW ONLY. Nothing here is applied to the shared database, to Neon, or to production.
The migrations are not in `migrations/`. Approval is needed before any of them is applied.

What was checked:
- 027 to 032: the approved drafts in `location-migrations-027-032.md`. They are applied to the
  LOCAL SCRATCH database and their 37 rule checks pass (`scripts/location-schema-test.sql`).
- 033: `approval-snapshot-033.md`, drafted earlier. Applied to scratch with its checks.
- 034: new in this pack (`034-appointment-messages.sql`). Its 8 rule checks pass on scratch
  (`scripts/appointment-messages-schema-test.sql`). The test runs in one transaction that is
  rolled back, so nothing is kept.
- Every referenced object exists in the current schema: `users` and `bounties` (UUID keys),
  `bounty_participants` (migration 008), `reject_append_only_change()` (migration 015),
  `notifications` (for the "you get the memo" step, no change needed).

## Order

| Step | File | What it changes | Kind |
|---|---|---|---|
| 027 | `location-migrations-027-032.md` | `bounties`: `task_mode`, `area_label`, `approx_lat`, `approx_lng` (two decimals). Remote tasks need no location. | ALTER, additive |
| 028 | same | `provider_service_areas`: provider base point and radius. Kept out of `users` so it cannot leak through `SELECT *`. | CREATE |
| 029 | same | `service_locations`: exact address and pin, one per task. Read only through one server function. | CREATE |
| 030 | same | `quotations`: a provider's price for a task. Accepting one assigns through `bounty_participants`. | CREATE |
| 031 | same (revised) | `appointments` and `appointment_events` (append-only history). One live appointment per task. | CREATE |
| 032 | same | Adds `appointments:write` to the token scope and confirmation CHECKs. | Replaces 2 CHECKs |
| 033 | `approval-snapshot-033.md` | Stores the exact approved text of a confirmation, with a DB-level hash check. | ALTER |
| 034 | `034-appointment-messages.sql` | `appointment_messages`: chat and status lines ("on my way") per appointment. Append-only. | CREATE |

Rollbacks for 027 to 032 are in each draft. Each is safe only when the table or rows it drops are
empty or exported first. Rollback for 034 is `DROP TABLE appointment_messages;`, safe only before
any chat exists.

## How the parts connect

```
bounties (task_mode, area_label, approx_lat/lng)      public, approximate
   │
   ├── service_locations (exact address, pin)          private, server-only
   ├── quotations (provider, amount, status)           UNIQUE(bounty, provider) — see decision 2
   └── appointments (provider, starts, ends, status)
          ├── appointment_events (append-only history, no address in details)
          └── appointment_messages (append-only chat and status)  [034]

provider_service_areas (provider base, radius)         private, server-only
bounty_participants (existing) ← set when a quotation is accepted
notifications (existing) ← one row per step: quote received, confirmed, on the way
```

## Rules the database does not enforce (must be in code and tested)

- A confirmed appointment needs both confirmations from different people (CHECK covers the shape;
  the code checks who may confirm).
- The appointment must end before the task deadline (see decision 4).
- The exact address is read only by the provider after both confirmations, and each read writes
  an `address_disclosed` event that contains no address.
- A change creates a new `proposed` appointment and marks the old one `superseded` in one
  transaction. The partial unique index rejects a second live row, so the order matters.
- Chat authors must be the appointment's provider or business.
- Integration tokens: `SCOPE_ROLES` and `SENSITIVE_SCOPES` in `services/integration-tokens.js`
  must add `appointments:write` in the same release as migration 032 (see decision 3).

## Decisions needed before applying

1. **Currency.** `quotations.currency` defaults to USD, but `bounties` has no currency column;
   `reward_amount` is a bare number. Recommended: remove `currency` from `quotations` and price in
   the task's currency, which is the same single currency the app uses today. Alternative: add a
   `bounties.currency` column with a default, and keep the quote column.
2. **Re-quoting.** `UNIQUE (bounty_id, provider_id)` means a provider who was declined or expired
   can never quote again on that task. Recommended: replace it with a partial unique index
   `WHERE status = 'pending'`, so a new quote is allowed after a decline or expiry.
3. **Deploy order.** Apply 032 and deploy the code that knows `appointments:write` together. If the
   database accepts the scope before the code does, no token can be issued with it. Confirm you
   are happy with a single release for both.
4. **Deadline type.** `bounties.deadline` is `TIMESTAMP` (no time zone), while appointment times
   are `TIMESTAMPTZ`. Recommended: store and compare in UTC, and convert the deadline once, in the
   same place, before the "ends before deadline" check.
5. **Address retention.** `service_locations` keeps the exact address with no end date. Recommended:
   purge it a fixed number of days after the appointment is completed or cancelled, and say so to
   users. Give me the number of days you want.
6. **Addresses typed in chat.** Free-text chat lets someone type the exact address before the
   confirmation step, which bypasses the address rule. Options: (a) accept the risk and show a
   warning; (b) block chat until both parties confirm; (c) reject messages that look like street
   addresses (a heuristic, so it will miss some). Recommended: (a) plus (b) for the address itself.
7. **Migration 033 retention.** `signed_text` is kept with no end date (open from earlier review).

## Applying later (not done, needs approval)

1. Full backup of the shared database, and a note of its row counts.
2. Apply 027 to 034 in order, one transaction per file, each followed by its rule checks, on Neon
   staging first if one exists.
3. Deploy the code that uses the new columns and scope in the same release as 032 (decision 3).
4. Run the Bounty suites (smoke, security, phase1 to 4, location, peg-cors) against the migrated copy.
5. Only then apply to the shared database, with a named approval.
