# Bounty feature parity (backend and data), at 7eb5487 plus this branch

Scope: what the backend and schema already provide. "Backend" means a route or service exists. It does not mean the frontend fully exposes it. UI coverage was not verified for each feature, and is marked "UI not verified" where it matters.

Status key: **Present** = route and schema exist and the existing suites cover it. **Partial** = present with a stated gap. **Added** = built on this branch. **Gap** = not built.

| Area | Feature | Status | Where |
|---|---|---|---|
| Marketplace | Browse open bounties, search, filter by category and difficulty, sort | Present | `routes/bounties.js` (GET `/`, `/open-tasks`), `global.js` (`/regions`) |
| Marketplace | Dynamic categories | Present (validation not verified) | `GET /categories`; `bounties.category` is a free-text column. Where values are validated was not checked |
| Marketplace | Create, edit, cancel a bounty; deadlines | Present | `bounties.js` POST `/`, PATCH `/:id`, PATCH `/:id/close`; `submissions.js` accept and decline deadline extension |
| Marketplace | Execution modes: competitive, first-valid, independent | Present | migration 008; `services/execution.js`; `execution-modes-test.js` |
| Marketplace | Projects with multiple tasks and blocked tasks | Present | `routes/projects.js`, migration 002; `project-test.js` |
| Marketplace | Budgets and budget caps | Present | `routes/budget.js`, `services/budget.js`, migrations 010 and 013 |
| Work | Worker starts, submits, resubmits | Present | `bounties.js` POST `/:id/start`; `submissions.js` POST `/:id/submit`, `/:id/resubmit` |
| Work | Business requests revisions | Present | `submissions.js` POST `/:id/request-revision`; `workspace-test.js` |
| Work | Milestones | Present | `routes/milestones.js` |
| Work | Team participation, invitations, lists | Present | `bounties.js` `/participants`, `/invitations`, `/lists` |
| Work | Messages and workspace per bounty | Present | `routes/workspace.js`, `bounties.js` `/:id/messages`; migration 003 |
| Review | Review queue, approve, reject, request evidence | Present | `submissions.js`, `bounties.js` `/:id/approve`, `/:id/reject`, `/:id/request-evidence`, `/:id/decide` |
| Review | Automated checks on submissions | Present | `services/checker.js`; reads at most 4,000 characters of text, `checker-test.js` (mock AI suites) |
| Review | Text extraction for PDF and Word submissions | **Added** (this branch) | `worker/` Python worker; migration 020 `file_jobs`; upload route enqueues jobs. The checker does not read extracted text yet (see below) |
| Review | Reviews of workers and businesses, reputation | Present | `routes/reviews.js`, `reputation.js`, migration 007 |
| Trust | Verification, proof of ability, duplicates detection | Present | `verification.js`, `assessments.js`, `duplicates.js`, migrations 006, 009, 010 |
| Trust | Disputes and appeals | Present | `routes/disputes.js`, `admin.js` appeals, migration 010 |
| Trust | Creator protection, NDA and agreements | Present | `routes/protection.js`, `agreements`; `creator-protection-test.js`, migration 015 |
| Trust | Reports and enforcement | Present | `routes/reports.js`, `admin.js` enforcement; `smoke-test.js` |
| Money | Payment records and webhook evidence | Present | `payments-webhook.js`, migration 019; no money is moved by this build |
| Money | Escrow and payouts | **Out of scope** | Not in the approved scope; not built |
| AI | AI task architect (planning) | Present | `routes/ai.js`, `services/planner.js`, `plan.js`; `ai-architect-test.js` (mock) |
| AI | AI checks on submissions | Present | `checker.js`; `checker-test.js` (mock) |
| AI | Portfolio and matching | Present | `portfolio.js`, `matching.js`; `portfolio-test.js` (mock) |
| AI | Fallback when no model is configured | Present | "rules" mode; labelled in the response, per the `project-test` suite |
| Dashboards | Business dashboard | Present | `routes/dashboard.js`, `projects.js` |
| Dashboards | Worker dashboard and profile | Present | `routes/profile.js`, `portfolio.js`, `talent.js` |
| Dashboards | Admin queues | Present | `routes/admin.js` (queue, reports, enforcement, appeals) |
| Roles | Business, worker, admin roles enforced in the backend | Present | `middleware/auth.js`; `security-test.js` |
| Roles | Roles in PostgreSQL only; Workpeg not a role authority | Present (by design) | `docs/integration-architecture.md`, decision 4 |
| Showcase | Public showcase of opted-in bounties | **Added** (this branch), partly | migrations 020 and 021; `services/showcase/`. The Workpeg publish client is not built; rows stay stale until the Workpeg Tables API is confirmed |
| Design | Themes, dark-first "Charcoal & Gold" default, light "Off-white & Gold" | **Added** (this branch) | `public/bounty.css` tokens; `public/bounty.js` THEMES. Existing themes kept |
| Design | Full visual pass across every screen | **Gap** | Only tokens changed. Component-level restyling not done |

## Known gaps and follow-ups (not built)

1. **Checker does not read the extracted text yet.** The worker writes `file_jobs.extracted_text`. `services/checker.js` needs a change to read it, which is a separate, small approval.
2. **Workpeg publish client.** `services/showcase/publish.js` has no client. Rows stay stale until the Tables API endpoint and auth are confirmed in writing.
3. **Mirror publish is not wired to routes.** The trigger in migration 021 marks rows stale on every write path. `syncShowcase` must be run by an admin action, and that admin route is not added yet.
4. **Escrow and payouts** are outside this build.
5. **UI coverage per feature** was not verified screen by screen.

## Schema added on this branch (not applied to any production database)

- Migration 020: `bounties.public_showcase`, `bounties.public_summary`, `bounties.showcase_state`, `bounties.showcase_synced_at`, table `file_jobs`.
- Migration 021: `bounties.showcase_version`, trigger `bounties_showcase_mark_stale_trg`.
