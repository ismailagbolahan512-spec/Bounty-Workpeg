# Bounty Global Marketplace on Workpeg: parity matrix, architecture and roadmap

Status: draft for review. No implementation has started.
Pinned SDK: `workpeg~=0.158.0`. Reference backup: branch `backup/hospitality-prototype-2026-11-11` (commit `9e952e2`), verified on the remote.

## 1. What the official docs confirm, and what they do not

The official pages (`functions`, `tables`, `architecture`, `manifest`, `sign-in-with-workpeg`) were read on 2026-11-11. None of them states the SDK version it documents; they are labelled `docs/latest` and only show documentation-tool versions. **Their statements may not match 0.158.0.** Confirm the version with Workpeg before relying on any statement below.

Confirmed in the docs:

- Functions build with no network; dependencies must be vendored into `wheels/`.
- `WORKPEG_PK` is a backend-only secret, server-to-server only.
- Tables are the only documented data path from a Function. Rows are windowed with `limit`/`offset` in `workpeg.get_rows`.
- Table filtering is by namespace only. No documented search, where-clauses, transactions, foreign keys, or table relations.
- Workpeg sign-in is OpenID Connect. Identity carries `role` = `owner | admin | member | guest`, set by Workpeg. Apps cannot define their own roles, and the docs describe no password reset, session revocation, or email-verification flow for apps. Workpeg does not offer end-user MFA.
- A manifest `actions` entry can expose a Function to Workpeg's own AI. This is Workpeg AI, not Bounty's AI.

Not documented (must be asked, not assumed):

- Outbound network from a Function, and whether external PostgreSQL is reachable.
- How secrets other than `WORKPEG_PK` reach a Function.
- Execution time, memory, and payload limits.
- How a compiled Peg UI calls a Function (only a schema-UI `RunFunction` action is mentioned).
- Whether a person can sign in to a Peg without being a member of a business. The sign-in chooser is built around businesses, which matters for a marketplace of individual workers.
- Whether multi-row writes are atomic, and whether tables can be queried server-side.

## 2. Revised feature parity matrix

Classes: 1 working · 2 partly implemented · 3 needs migration · 4 blocked by Workpeg (open question) · 5 excluded by decision

### Demo priorities (must work end to end)

| # | Priority | Class | Basis |
|---|---|---|---|
| 1 | Business and worker authentication | 4 | Workpeg identity exists, but worker membership and whether a worker can exist without a business are unresolved (Q9). |
| 2 | Business task creation and management | 2 | Prototype creates and edits basic bounties. Needs budgets, criteria, deadlines, projects, dependencies. |
| 3 | Marketplace discovery, search, filtering | 4 | Only client-side search over loaded rows. No server-side query documented (Q6). |
| 4 | Worker participation and assignment | 3 | Not in prototype. Port `routes/bounties.js` apply/assign logic into Functions. |
| 5 | Submission and revision workflows | 2 | Prototype submits once. No revisions or resubmission. |
| 6 | Business review, approval, rejection | 2 | Prototype approves and rejects. Needs the full state machine. |
| 7 | Business, worker and admin dashboards | 3 | Port `routes/dashboard.js` and `public/features/*` workflows. |
| 8 | First-valid and competitive classification | 3 | Two separate workflows, as the brief requires. |
| 9 | Deadlines, budgets, criteria, dependencies | 3 | Deadline enforcement needs checks at action time, unless Workpeg offers scheduling (unverified). |
| 10 | AI Task Architect and one AI feature | 4 | Needs outbound HTTPS to the AI provider from a Function (Q3, Q4). |
| 11 | Privacy and submission protection | 3 | Tables permissions are per business, so cross-party confidentiality must be enforced in Functions. |

### Remaining original features

| Area (original) | Class | Notes |
|---|---|---|
| Categories, subcategories, manager-created categories | 3 | Store as a `categories` table. Seed with the illustrative list. Remove the hardcoded hospitality list. |
| Budgets and estimate (`routes/budget.js`) | 3 | Port to Functions. Currency stays configurable, default USD. |
| Milestones and projects (`routes/milestones.js`, `projects.js`) | 3 | Relational. Model with ids referencing rows in other tables, enforced in Functions. |
| Task dependencies | 3 | Same as milestones. |
| Workspace, messages, timeline (`routes/workspace.js`, `bounties.js` messages) | 3 | Tables plus `on_table_change` for updates. |
| Worker applications, talent lists, invitations (`routes/talent.js`) | 3 | 16 endpoints. Migrate in a later phase. |
| Assessments and verification (`routes/assessments.js`, `verification.js`) | 3 | Logic ports to Functions. Verification-by-email depends on Q3, Q4. |
| Revisions, resubmission, deadline acceptance (`routes/submissions.js`) | 3 | Core workflow, phase 4. |
| Expired and lapsed tasks | 3 | Enforce on read and write. |
| Submission checks and proof-of-ability (`routes/ai.js`, `services/checker.js`) | 4 | AI-dependent (Q3, Q4). |
| Disputes, mediation, evidence (`routes/disputes.js`) | 3 | Heavy use of relations and permissions. |
| Protection: agreements, NDAs, confidential tasks, reports, enforcement, appeals (`routes/protection.js`, 18 endpoints) | 3 | Largest module. Port last. |
| Reviews, reputation, portfolio (`routes/reviews.js`, `reputation.js`, `portfolio.js`) | 3 | Aggregation in Functions. |
| Duplicate detection (`routes/duplicates.js`) | 3 | Logic may need an external text-similarity method. Check against egress limits. |
| Matching, global regions (`routes/matching.js`, `global.js`) | 3 | Requires server-side query (Q6). |
| Files and submission uploads (`routes/files.js`, S3) | 4 | Workpeg file storage is undocumented in what was read. Requires confirmation (Q5). |
| Email notifications (Resend) | 4 | Outbound from Functions (Q3). |
| Notifications (in-app) | 3 | Tables plus realtime. |
| Admin: reports queue, user controls (`routes/admin.js`) | 3 | Admin is a Bounty role, enforced in Functions. |
| Email verification, password reset, sign-in rate limits, session revocation (`routes/auth.js`, `signin-limit.js`) | 4 | Workpeg does not provide these to apps (verified from its docs). Decision needed: rely on Workpeg accounts, or keep a separate Bounty identity (Q9). |
| Payments, escrow, Pandascrow webhook | 5 | Excluded by decision. |
| Original visual design | 3 | Rebuild in Peg UI components. Original CSS and JavaScript cannot be ported. |
| Charcoal/coal/gold palette | 2 | Via `Theme`. Theme serves light and dark alike, so a dark-only palette needs a decision (see 4). |

Totals: 138 endpoints across 28 route modules are in the original. Each must be classed before implementation starts.

## 3. Architecture plan

**Identity.** Workpeg sign-in (OpenID Connect via `SignInWithWorkpeg` or `WorkpegAuth`) establishes the person. Bounty's application role (`business`, `worker`, `admin`) is stored in a Bounty `accounts` table, keyed by the Workpeg `subject`, never by email. The `role` field from Workpeg is not used for Bounty authorization.

**Authorization.** Every cross-party read and write goes through a Function, which checks the Bounty role and ownership. The UI never reads sensitive tables directly. This is required because Tables permissions are per business: a worker cannot read another business's task list through a table permission.

**Data.** One Tables family per entity: `categories`, `bounties`, `projects`, `milestones`, `dependencies`, `applications`, `assignments`, `submissions`, `submission_revisions`, `reviews`, `disputes`, `messages`, `notifications`, `audit_log`. Relations are stored as ids and checked in Functions, since there are no foreign keys. Multi-row changes are designed to be safe to retry, pending Q7.

**Functions.** Python handlers grouped by domain: `marketplace` (search, filter, discovery), `execution` (apply, assign, submit, revise, approve, reject, deadlines), `classification` (first-valid and competitive rules), `trust` (protection, disputes, reviews), `admin`, and `ai` (architect, checks), the last gated on Q3 and Q4. Dependencies are pre-vendored in `wheels/`.

**UI.** Peg UI (Python) with one page per area, following the scaffold's patterns. Shared components in `components.py`. Palette and tokens centralised in one module that maps to `Theme`.

**Secrets.** `WORKPEG_PK` only in Functions and the developer's shell. No secrets in UI code. Other secrets (AI key, email key) are unresolved until Q4.

**Pinning.** `workpeg~=0.158.0`, with the changelog read before any upgrade.

## 4. Palette decision needed

Mapping the proposed palette to `Theme`:

- `page` and `bg`: charcoal `#111315`
- `sidebar` and `surface`: coal `#1B1F22` and `#292F33`
- `primary`: warm gold `#D6A24A`, with `primary_fg` set for contrast
- `fg`: off-white `#F4F1EA`; `muted`: `#89949C`

The Scaffold follows the device's light or dark setting by default. A charcoal palette would then appear in light mode too. Options: a dark-first theme in both schemes (preferred), or a dark-only app, which needs Workpeg to confirm `set_color_scheme` can be forced. Decide before phase 1.

## 5. Questions for Workpeg's technical team

1. Which SDK version do the official pages describe? Confirm they match 0.158.0.
2. How does a compiled Peg UI call a Function, including authentication?
3. Can a Function make outbound HTTPS calls? To which hosts? Does this apply to the hosted runtime, not only local Docker?
4. How are secrets other than `WORKPEG_PK` supplied to a Function?
5. Execution time, memory, and payload limits for Functions.
6. Can tables be queried server-side (filter, search, sort, index)? What are the row and page limits?
7. Are multi-row writes atomic? Is there any transaction support?
8. Can external PostgreSQL be reached from a Function? If yes, is it supported for production?
9. Can a person sign in to a Peg without belonging to a business? If workers must belong to a business, how should an individual worker marketplace be modelled?
10. Can an app store and enforce its own roles beyond the four Workpeg roles?
11. Are scheduled or time-based triggers available for deadline enforcement?
12. Does Workpeg provide file storage for user uploads to a Function, and what are its limits?

## 6. Roadmap (each phase waits for approval)

- **Phase 0. Confirm unknowns.** Send questions 1 to 12. Blocked items stay blocked until answered. No code.
- **Phase 1. Foundation.** Reset `main` to the multi-industry base (after this plan is approved). Set up the palette module and shared components. Verify the build.
- **Phase 2. Identity and roles.** Blocked on Q2, Q9, Q10. Spike first: a worker signs in, a business signs in, and roles are enforced in a Function.
- **Phase 3. Core marketplace.** Categories, bounties, budgets, deadlines, acceptance criteria. Discovery with search and filters, blocked on Q6 for server-side search.
- **Phase 4. Execution.** Applications, assignment, submissions, revisions, resubmission, approvals, rejections, and both execution modes.
- **Phase 5. Dashboards and workspace.** Business, worker, and admin dashboards. Messages, timeline, projects, dependencies.
- **Phase 6. AI.** AI Task Architect and one quality feature, blocked on Q3 and Q4.
- **Phase 7. Trust and admin.** Protection, NDAs, disputes, reviews, reputation, talent lists, admin tools.
- **Phase 8. Visual pass and demo.** Full palette application, responsive checks, and the scripted business-to-worker-to-business demo.

**Demo risk.** The end-to-end demo depends on Q9 (worker identity), Q6 (search), and Q3 and Q4 (AI). If any of these stays unanswered, the demo would need to use a documented workaround. That needs your decision before phase 2.

## 7. Phase 0 findings (verified from the installed SDK, 0.158.0)

Source read from the `workpeg==0.158.0` package installed in a scratch environment. Only documentation research was done. Nothing was added to the project.

**Verified in source**

- **Functions run only from table write hooks or manifest actions.** The SDK defines two hook phases, `pre_save_hook` and `post_save_hook`, which run on table writes. Manifest `actions` map to a table and phase. The UI has no direct call path: the compiler refuses `RunFunctionAction` in compiled apps ("there is no registry to look that name up in").
- **Consequence for the architecture.** A Function cannot serve a UI read such as search or filtering. A UI action can only reach a Function by writing a row, and only a `pre_save_hook` can refuse that write. Post-save failures are logged after the row is saved, so they cannot stop it.
- **Sandbox limits are not Function limits.** The `workpeg.sandbox` module defines exec timeouts (default 20 s, range 1–120 s), memory (64–4096 MB), output (64 KB), and args (8 KB). Its docstring says it is for Workpeg AI agent sandboxes, with no network by default. These limits are not confirmed to apply to Functions.
- **Secrets pattern.** The sandbox module describes secrets injected at an egress proxy, so a container never holds them. This is a design statement for sandboxes, not Function behaviour. Whether Functions use the same pattern is unconfirmed.

**Still unverified (send to Workpeg)**

- Hook timeouts and resource limits, and whether a hook can make outbound calls (the AI provider, email, file storage).
- Whether the compiled UI's `http.*` client can reach external hosts without a key in the page. The UI guide says it can reach non-Workpeg hosts, but a keyed call would need a Function, and Functions only run from hooks.
- Maximum `limit` for `get_rows`, and whether Tables support server-side filtering beyond namespace.

**Revised architecture implication**

- Reads that need query logic (discovery, search, matching, dashboards) cannot use a Function. They need either Tables queries (not confirmed), a client-side approach on bounded windows (not acceptable at marketplace scale), or an external index (blocked on egress).
- Writes can be validated by a `pre_save_hook`, which suits the state machine: submission, review, and approval rules can refuse invalid transitions.
- AI checks can be a pre-save validation only if hooks allow outbound calls. Otherwise AI stays a fallback with a clear label until verified.

**Open-question status:** still pending Workpeg's answers. This addendum changes Q2 (the UI-to-Function path, now answered as "not available; writes only") and narrows Q6 and Q3.
