# Bounty + Workpeg: integration architecture (revised)

Status: architecture for review. No implementation has started. Scope confirmed: selected Workpeg SDK capabilities are integrated into Bounty. Bounty is not migrated.

Decisions in force:

1. The integration brief replaces the earlier full migration. Node.js, Express and PostgreSQL stay.
2. PR #1 and the merge into `main` are under investigation (section 7). Nothing is reverted.
3. The Python extraction worker is deferred. It stays in this architecture but is not built.
4. PostgreSQL is Bounty's single source of truth for roles and permissions. Workpeg is never a role authority.

## 1. Components and ownership

| Component | Runs on | Owns |
|---|---|---|
| Bounty frontend | Bounty hosting (static files) | Nothing persistent. Calls only Bounty's API. |
| Bounty backend (Node.js, Express) | Bounty hosting | Authoritative logic: auth, roles, permissions, bounties, submissions, reviews, payments, disputes, AI, files, email. The only writer of business data. |
| PostgreSQL (Neon) | Neon | All business data, roles, permissions, audit trail. Single source of truth. |
| Workpeg peg (showcase) | Workpeg | A public, read-only mirror of selected public-safe fields. Holds no roles, no permissions logic, and no business rules of its own. |
| Python (deferred) | Not deployed | Nothing yet. Planned: one extraction worker (section 6). |

## 2. Data ownership

- **PostgreSQL owns everything**: users, accounts, roles, permissions, bounties, submissions, reviews, payments, disputes, files, AI records.
- **Workpeg mirror owns nothing.** Each mirror row is a copy of a public-safe subset of a PostgreSQL row, with the PostgreSQL id and an `updated_at` timestamp. It can be rebuilt from PostgreSQL at any time.
- **Public-safe means**: title, category, budget, deadline, status and public summary. Never submissions, worker identities beyond a display name the worker chose, emails, payments, disputes, or internal notes.

## 3. Workpeg capabilities used

The smallest slice that demonstrates the SDK:

1. **SDK connection.** The Bounty backend calls the Workpeg Tables REST API with `WORKPEG_PK`, held in backend environment variables only. The Python SDK is used only to build and publish the Peg, on a developer machine.
2. **Peg tables.** Two mirror tables: `showcase_tasks` and `showcase_submissions`. The second holds only the public-safe status and title of an approved submission, not its content.
3. **Table and row permissions.** Set on the mirror tables so visitors can read and no one but the backend can write. Permissions control visibility of the mirror. They do not express Bounty roles.
4. **Pre-save hook.** One hook on `showcase_tasks`. It checks structural invariants only: required fields present, status is one of the allowed values, and the PostgreSQL id is present. It does not check roles or who approved anything. Those rules stay in PostgreSQL. The hook runs inside Workpeg, with no outbound call and no secret.

Not used, and why:

- **Custom roles in peg tables.** Rejected by decision 4. Two role systems would disagree.
- **Workpeg sign-in for end users.** Not needed for a public showcase. Bounty's own authentication handles every user.
- **A hook that calls Bounty.** Needs outbound HTTPS and a secret. Neither is confirmed.
- **Manifest search.** Deferred. The showcase can list rows without it.

## 4. Roles and permissions (decision 4)

- Bounty's three roles (business, worker, admin) are stored in PostgreSQL and checked by the Bounty backend on every request.
- Workpeg's roles (`owner`, `admin`, `member`, `guest`) are never mapped to Bounty roles and never gate a Bounty action.
- Mirror permissions only control what the showcase shows. They are derived from the public-safe rule, not from a user's role.
- A visitor who can read the showcase has no Bounty role. Anything beyond public-safe fields comes only from the Bounty API, after a PostgreSQL check.

## 5. Communication

**Bounty backend to Workpeg (the only write path into Workpeg):**

- Mechanism: HTTPS to the Workpeg Tables REST API, with `WORKPEG_PK` in the `Authorization` header.
- When: after each successful PostgreSQL write to a public-safe field.
- The backend, not the frontend, makes this call. The frontend never receives `WORKPEG_PK`.

**Workpeg to Bounty:** none. Workpeg never calls the Bounty backend.

**Browser to Workpeg:** read-only, via the Peg's own public pages. No secret is present in any page.

**Authentication of backend calls:** `WORKPEG_PK` only, server-side. Bounty's JWT sessions are unchanged.

## 6. Failure handling and consistency

- **PostgreSQL write succeeds, Workpeg publish fails.** The mirror row is marked `stale` in PostgreSQL. The next backend request that touches the bounty retries the publish. There is no timer, because Bounty has no scheduler.
- **Workpeg is down.** Bounty keeps working. Only the showcase is out of date.
- **Pre-save hook refuses a row.** The mirror write fails and is recorded as `stale`. The PostgreSQL write is not rolled back, because the mirror is not authoritative.
- **Reconciliation.** An admin-triggered job rebuilds the mirror from PostgreSQL. It runs on demand, not on a schedule, since Workpeg has no scheduled execution.
- **Ordering.** PostgreSQL is always written first. The mirror is derived, so a crash between the two steps leaves it stale, never wrong.

## 7. PR #1 and the merge into `main` (investigation, no changes made)

What the history shows:

- Pull request #1 (`plan/global-marketplace` into `main`) was opened at 11:50:52 UTC and merged 16 seconds later, at 11:51:08 UTC, by the `ismailagbolahan512-spec` account.
- The merge commit `f6b97dc` is signed by GitHub, with its author shown as the account owner. Its two parents are `9e952e2` (the prototype) and `c922bd2` (the plan).
- The merge adds one file, `docs/migration-plan.md` (157 lines). It deletes nothing. The prototype's 8 `ui/` files remain on `main`.
- The two commits in the PR were authored by this session's Claude identity. The session never ran `gh pr create` or merge. The local reflog shows only commits, checkouts and pushes to branches.
- The PR body is empty. There are no reviews or comments.

What this does not show: whether the owner clicked "merge" in the browser or a tool used the owner's credentials. The GitHub event log records only the owner's account as the actor.

Effect on `main`: documentation only. No code changed. The backup branch `backup/hospitality-prototype-2026-11-11` (`9e952e2`) still holds the prototype.

Recommendation: confirm whether the merge was intended. If not, a revert commit on `main` keeps history intact. No revert will be made without your confirmation.

## 8. Python (deferred, kept in the architecture)

- Not built. No service, no dependency file, no deployment.
- Purpose, when approved: extract text from PDF and Word submissions, so the existing checker can read them. The checker currently sees at most 4,000 characters of plain submissions and nothing from documents.
- Communication, when approved: a `file_jobs` table in the existing PostgreSQL database. The worker polls it. No new broker or Redis.
- Schema change: one additive table. Requires separate approval.
- Node.js stays the API and remains the only path from users.

## 9. Open questions for Workpeg (in writing)

1. Can a hook make outbound HTTPS calls on the hosted runtime? Not needed for this slice, but determines future options.
2. Is the Tables REST API callable from an external Node service with `WORKPEG_PK`? Confirm the header, the rate limits and the write limits.
3. Is 0.158.0 the version the function-base and tables docs describe? The docs use 0.157.0 as the example.
4. Timeouts, memory and payload limits for hooks.
5. Confirm that mirror permissions alone (without roles) are the supported way to restrict a peg's visible rows.

## 10. Next steps (after approval)

1. Confirm the PR #1 merge with the owner.
2. Confirm the mirror fields and the public-safe list with you.
3. Write the mirror contract: field list, id mapping, `stale` states, and the publish call.
4. Implement the mirror publish in the Bounty backend, with tests, on a branch of the Bounty backend repo. Do not touch its `main`.
5. Build the two Workpeg tables and the single hook, and test each invariant.
