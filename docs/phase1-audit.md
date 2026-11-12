# Phase 1: Repository audit and integration architecture

Status: report only. No code changed. Backend cloned read-only from `ismailagbolahan512-spec/BOUNTY-backend-` at `7eb5487` (2026-11-09), verified identical to the uploaded zip. Nothing was written to that repo.

## 1. What Bounty is today (verified in code)

- **Backend:** Node.js with Express. 28 route modules, 31 `/api` mounts, about 138 endpoints. Security headers and a strict Content-Security-Policy in `index.js`. The payments webhook is mounted before the JSON parser.
- **Database:** Neon PostgreSQL through `pg`. About 36 tables across 19 migrations.
- **Auth:** our own. JWT (HS256) in a Bearer header or an HttpOnly, SameSite=Strict cookie. Roles (business, worker, admin) are stored in our database and re-read on every request. Revocation uses `password_changed_at` and `tokens_valid_after`. Also bcrypt, email tokens (`services/tokens.js`), and sign-in rate limits.
- **Frontend:** static HTML, CSS and vanilla JavaScript served from `public/`. Feature logic in `public/features/phase1–4.js` and `protection.js`. No framework.
- **Services (23 files):** `ai`, `planner`, `plan`, `checker`, `criteria`, `duplicates`, `matching`, `regions`, `classification`, `execution`, `milestones`, `budget`, `disputes`, `protection`, `reputation`, `portfolio`, `assessments`, `verification`, `progress`, `files` (S3), `previews` (pdf-lib), `email` (Resend), `tokens`.
- **AI:** already in Node. `services/ai.js` selects an engine: `rules` (our own code, no model), `openai` (any OpenAI-compatible server, via `AI_BASE_URL`), or `anthropic`. A daily limit (default 20). `checker.js` never changes a submission's status; the business decides.
- **Background work:** none. There is no scheduler, cron or queue. Deadline expiry is lazy: `expireOverdueBounties()` in `routes/bounties.js` runs before reads.
- **Payments:** Pandascrow webhook and escrow. Out of scope.

## 2. What must not be duplicated

Anything already in the Node backend stays there: auth, roles, submissions, approvals, budgets, classification, matching, duplicate detection, AI planning and checks, file storage, previews, email, disputes, protection, reviews and reputation. The brief asks us not to rebuild these.

## 3. Workpeg, verified against the SDK and docs

Verified:

- The Workpeg SDK is Python (`pip install workpeg`). A Node backend cannot import it. The Node backend can only reach Workpeg over HTTP.
- `WORKPEG_PK` is a backend secret, "server-to-server only, never in UI code". The Tables docs show a function's backend calling the Tables API with it. So our Node backend could hold `WORKPEG_PK` server-side and call the Tables API. This is the documented route, but I have not run it.
- Save hooks: only `pre_save_hook` can refuse a write. A `post_save_hook` failure is logged after the row is saved.
- The compiler refuses `RunFunctionAction`. A Peg UI cannot call a Function directly.
- Local Function runs use `--network=none`.

Not verified in the docs (the function-base page says "A function can still make requests while it runs" but names no hosts, protocol or limits, and conflicts with the `--network=none` local run):

- Outbound HTTPS from a hook, and to which hosts.
- How a hook receives secrets. The team says there is no native secret store, so a hook cannot safely hold a key for calling Bounty.
- Timeouts and resource limits.
- Whether the hosted pre-save path has the same network rules as the local run.
- The example version is 0.157.0, while our pin is 0.158.0.

Team claims relayed in the brief (not yet in writing): server-side `get_rows` pagination with a 100-row example; no server-side custom-column filtering or sorting; search configured via the manifest; outbound HTTPS from Functions; no native secret store; no scheduled background execution; custom roles via peg tables; table and row permissions and pre-save functions available. I treat these as provisional until confirmed in writing.

## 4. Proposed integration: the smallest useful Workpeg slice

Each choice below is there because the brief asks for it. Anything the docs don't confirm is marked.

| Brief item | Proposal | Why, and risk |
|---|---|---|
| SDK init and connection | Node backend calls the Workpeg Tables REST API with `WORKPEG_PK` from server env. The Python SDK is used only for a Peg project (the demo UI and hook). | Documented route. Risk: REST auth from Node is inferred from the docs, not shown. Confirm. |
| Peg tables | Two tables only: `showcase_tasks` and `showcase_submissions`. Mirror of published, public-safe fields for the Workpeg-hosted showcase. | Smallest surface. Bounty's Neon tables stay authoritative. |
| Custom roles | Not recommended as a second authority. Bounty's roles stay in our database. A peg-table role may only mirror the Workpeg view. | Two role systems can disagree. Ask the team whether one role source can be the single authority. |
| Table and row permissions | Set on the mirror tables so Workpeg users see only public-safe rows. Enforced in Workpeg, not our backend. | Documented. Permission model confirmed only as "three digits, owner / staff / guests". |
| Pre-save function | One hook on `showcase_submissions` that refuses an invalid status change, for example "approved" without a recorded reviewer. Runs entirely inside Workpeg, no outbound call and no secret. Bounty's backend re-checks the same rule. | Demonstrates business-rule enforcement without needing the unverified network. The duplicate rule is labelled as a mirror, and a test asserts both agree. |

Not proposed: a hook that calls Bounty's backend. It needs outbound HTTPS and a secret, and both are unverified or unavailable.

## 5. Infrastructure boundary

**Data ownership**

- Bounty owns (Neon PostgreSQL): users, accounts, roles, bounties, submissions, reviews, payments, disputes, files, AI records, and all business logic.
- Workpeg owns (peg tables only): a public showcase copy of selected tasks and submissions, written by Bounty's backend. Nothing is authoritative in Workpeg.

**Flow**

- Bounty's backend writes to Neon first, then publishes the public-safe fields to Workpeg through the Tables API. Workpeg never writes back into Bounty.
- Users and the browser talk only to Bounty. The Workpeg showcase is read-only for visitors.

**Authentication and secrets**

- `WORKPEG_PK` lives only in Bounty backend environment variables. Never in `public/`, never in a Peg page, never in the repo.
- The Python SDK's own token handling (`workpeg` login) is used only for building and publishing the Peg, on a developer machine, not in production.
- Bounty's JWT sessions are unchanged.

**Failure handling**

- Workpeg down: publishing fails; the mirror is marked stale and retried by the next request that touches it. Bounty keeps working, because Workpeg is not on the critical path. There is no scheduler, so retry must be triggered by activity, not timers.
- Pre-save hook refuses a write: the Workpeg write fails and is reported. Bounty's Neon write is unaffected.

**Consistency**

- Neon is the source of truth. Mirror rows carry the Neon id and an `updated_at`. A reconciliation step can be run on demand, not on a timer.

## 6. Python: is there a genuine purpose?

The brief asks for Python only where it adds real value. Checked against the code:

- **AI:** no. The model and rules code is already in Node. Moving it to Python would duplicate working code.
- **Background jobs and scheduling:** none exist, and the Workpeg team says there is no scheduled execution. Expiry is lazy and already works. Adding a Python worker for this would add a service with no job.
- **Duplicate detection:** Jaccard over five-word shingles, cheap in JavaScript. No need for Python yet.
- **Document and file processing:** the one real gap. `previews.js` creates PDFs with pdf-lib and cannot extract text. The checker only sees submissions up to 4,000 characters, so a PDF or Word submission cannot be checked at all. Python has mature extraction libraries (pypdf, python-docx).

**Recommendation:** no Python service in this phase. If the product needs document-text checks, add one Python worker for text extraction only. Communication: a jobs table in the existing Neon database that the worker polls, rather than a new broker or Redis. This adds one table and no new infrastructure, and it is additive, not destructive. Python gets its own dependency file, structured logs, and a health check. Node keeps the API.

## 7. Decisions and questions

**Decisions needed from you**

1. **Scope conflict.** Earlier you directed a full migration of Bounty to Workpeg, with a reset of `main`. This brief says the opposite: not a migration, keep Node, Express and PostgreSQL. These cannot both be followed. I recommend this brief, since it is the later instruction and matches "do not replace PostgreSQL". The reset is on hold until you confirm.
2. **Python.** Approve or defer the document-extraction worker. I recommend deferring until the document-checking need is confirmed.
3. **Custom roles.** Confirm Bounty's database stays the only role authority, with Workpeg roles limited to the showcase.

**Questions for Workpeg (in writing)**

1. Can a hook or Function make outbound HTTPS calls on the hosted runtime? To which hosts, and with what timeout?
2. How does a hook receive secrets or identity? If a hook must call Bounty, what credential does it use without a native secret store?
3. Is the Tables REST API callable from an external Node service with `WORKPEG_PK`? Confirm the auth header and the rate limits.
4. Is the pinned version 0.158.0 the one the function-base and tables docs describe? The docs use 0.157.0 as their example.
5. Timeouts, memory and payload limits for hooks.
6. Can one role source be the authority, so there is no duplicate role system?

## 8. Next steps (after your decisions)

- Phase 2: confirm the integration slice above with you and the Workpeg team.
- Phase 3: write the boundary spec and contract for the mirror (fields, ids, failure states).
- Phase 4 and later: implement only after Workpeg confirms the blocked items.
