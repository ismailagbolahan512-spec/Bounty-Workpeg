# Workpeg showcase mirror: contract (proposed)

Status: proposal for review. Nothing here is approved for implementation.
Approved so far (decisions of 2026-11-12, see `docs/integration-architecture.md`, section 11):

- The Python extraction worker and the `file_jobs` table are deferred.
- No `stale` column is added without a separate schema approval.
- Workpeg-side tables and the pre-save hook wait until the open Workpeg questions are answered.
- The public summary may come only from explicitly public text (rule in section 3).
- PostgreSQL is the only authority for roles, permissions, approvals and core marketplace data.

This document defines what the mirror would contain, when it changes, and how it fails. It does not change the schema, add an endpoint, or call Workpeg.

---

## 1. Purpose and boundary

The showcase is a read-only public list of bounties that businesses have chosen to make public. It exists to demonstrate the integration. It is derived from PostgreSQL and can be rebuilt from it at any time.

The showcase holds no roles, no permissions logic and no approval state. Visibility is decided in Bounty before a row is written to the mirror. The mirror's own permissions only restrict what visitors can read.

---

## 2. Eligibility

A bounty is mirrored only when all of these hold:

| Rule | Source | Status |
|---|---|---|
| The business has explicitly marked the bounty public | a proposed `bounties.public_showcase` boolean, default false | **needs schema approval** |
| The bounty has a public summary | a proposed `bounties.public_summary` text column, written by the business, max 280 characters | **needs schema approval** (see section 3) |
| The status is one of the six known statuses | `BOUNTY_STATUSES` in `routes/bounties.js` | exists |

When a bounty stops being eligible (the flag is turned off, or it is deleted), its mirror row is removed. The mirror owns no data, so removal does not touch business records.

Until the flag is approved, the showcase publishes nothing. This is the safe default.

---

## 3. Public summary rule (decision 4)

- The summary never comes automatically from `bounties.description`. That field is written for workers and may contain details the business did not intend to publish.
- The preferred source is `public_summary`, written by the business for this purpose.
- If the owner later prefers not to add a column, the only alternative is a prefix of `description`, and only when the business has explicitly ticked "make this public" on that bounty. This alternative still needs the same flag.
- In either case the text is plain: control characters removed, whitespace collapsed, capped at 280 characters. The showcase page must render it with `Text()`, never as markup.
- Confidential material is never a source: NDA text, rules of engagement, authorization statements, permitted targets, requirements, submissions, and worker notes.

---

## 4. Mirror fields

Only these fields leave PostgreSQL (`services/showcase/contract.js` already encodes this list in code on the build branch, which is not approved for merge):

| Mirror field | Source column | Rule |
|---|---|---|
| `pg_id` | `bounties.id` | PostgreSQL uuid. The mirror key. |
| `title` | `title` | 1 to 255 characters |
| `category` | `category` | 1 to 100 characters. Dynamic categories are stored as text, so any approved category value passes. |
| `reward_amount` | `reward_amount` | number, 0 to 9999999999.99 |
| `deadline` | `deadline` | ISO 8601 timestamp (UTC). Changes when a deadline extension is accepted. |
| `status` | `status` | one of the six statuses |
| `summary` | `public_summary` | section 3 |
| `updated_at` | `updated_at` | ISO timestamp, used for ordering and staleness |

**Excluded, always:** `business_id`, `winner_id`, `difficulty`, `submission_type`, `requirements`, `description`, `nda_text`, `rules_of_engagement`, `authorization_statement`, `permitted_targets`, `completion_checklist`, `acceptance_criteria`, `regions`, `funding_status`, any submission, payment, dispute, eligibility or participant data, and any user identity or email.

The business name is excluded for now. Adding it would be a separate decision.

---

## 5. Write points that must trigger a mirror update

Every route below changes a field the mirror holds. Each one must call the publisher after its PostgreSQL write commits. These are the places found by reading the backend at `7eb5487`:

| Location | Change | Mirror effect |
|---|---|---|
| `routes/bounties.js:483` | INSERT new bounty | publish if eligible |
| `routes/bounties.js:80` | lazy deadline expiry sets `status = 'expired'` | publish. Runs on read, so the publish must also run from that path. |
| `routes/bounties.js:571` | cancel by business sets `status = 'closed'` | publish, or remove if no longer eligible |
| `routes/submissions.js:294` | winner selection sets `status = 'completed'` | publish |
| `routes/submissions.js:566` | accepted deadline extension changes `deadline` | publish |
| `routes/projects.js:36` | INSERT bounty as part of a project | publish if eligible |
| `routes/global.js:39` | changes `regions` only | no mirror change (regions not mirrored) |

Plus any future route that writes `title`, `category`, `reward_amount`, `public_showcase` or `public_summary`. The rule: **any write to a mirrored field goes through one helper, `publishBounty(id)`, called after commit.** This avoids missing a path.

---

## 6. Ordering and failure handling

Order: PostgreSQL commit first, then the mirror call. The mirror is derived, so the worst case is a stale mirror, never a wrong authority.

| Situation | Result |
|---|---|
| PostgreSQL write fails | Nothing is published. The request fails as it does today. |
| PostgreSQL commits, mirror call succeeds | Mirror row written. |
| PostgreSQL commits, mirror call fails or times out | Mirror is stale. The business request still succeeds. The failure is logged without credentials. |
| PostgreSQL commits, process crashes before the mirror call | Mirror is stale. Same as above. Reconciliation fixes it. |
| Pre-save hook refuses a row (once it exists) | Treated as a failed publish. PostgreSQL is not rolled back. |
| Workpeg unreachable | Bounty keeps working. Only the showcase is out of date. |
| Mirror row present but bounty no longer eligible | Showcase shows an old row until the next publish or reconciliation. Acceptable for a demo showcase, and listed as a known limit. |

**Stale tracking without a schema change (proposed first version):** no column is added. A stale mirror is detected by reconciliation, which rebuilds the mirror from PostgreSQL. This needs no approval. A persisted `showcase_state` column is an option only if reconciliation proves too slow, and it needs its own approval.

---

## 7. Reconciliation

- Triggered by an admin action in Bounty. There is no scheduler, because Workpeg has no scheduled execution and Bounty has no scheduler.
- Reads eligible bounties from PostgreSQL in windows, publishes each, and removes mirror rows that are no longer eligible.
- Idempotent: running it twice gives the same mirror.
- Limits to confirm with Workpeg: per-request write limits and reconciliation rate. Until confirmed, batch sizes are unset and must not be guessed.

---

## 8. Workpeg-side invariants (pre-save, structural only)

If the hook is built after the open questions are answered, it enforces only what `validateShowcaseTask` checks: field allowlist, uuid format, length limits, numeric range, ISO timestamps, and status membership. It makes no call out, holds no secret, and knows nothing about roles or approvals.

---

## 9. Authentication

- Bounty's backend writes to the Workpeg Tables API with `WORKPEG_PK`, held in backend environment variables only.
- The frontend never receives the key and never calls the Tables API.
- The exact endpoint, method and header format are **not** documented here. They must come from Workpeg in writing (open question 2 in the architecture doc). Nothing in this contract guesses them.
- Workpeg never calls Bounty.

---

## 10. Dependencies and risks

- Workpeg SDK: docs describe 0.157.0 while the project pins 0.158.0 (open question 3).
- Hook timeouts, memory and payload limits: unknown (open question 4).
- Whether mirror permissions alone are the supported way to restrict visible rows (open question 5).
- Existing backend risk, unrelated to Workpeg but relevant to any outbound call from it: `db.js` uses `rejectUnauthorized: false` for the database connection. It should be fixed before production use. Not changed in this proposal.

---

## 11. What is needed before any implementation

1. Approval of the `public_showcase` flag and the `public_summary` column (a schema change, with the stated migration).
2. Written Workpeg answers to open questions 1 to 5, and the endpoint and auth details for the Tables API.
3. Approval of the write-point list in section 5 and of the publisher helper design.
4. Approval of the reconciliation design in section 7.

Until then, the build branch's contract and publisher code stays unmerged, and nothing in this document is wired into any route.
