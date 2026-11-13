# Workpeg identity: scoped, revocable Bounty tokens (design, not built)

Status: design for review. Nothing here is implemented or applied. Required schema changes need separate approval.

Decisions in force (from the owner, 2026-11-13):
- Workpeg is allowed. The Bounty AI features stay deferred.
- Identity model: a revocable, scoped Bounty token linked to the authenticated user's account.
- Revocation goes through Bounty's existing session check. Every protected request validates that the token is still active and authorized.
- Least privilege, secure storage, expiry, rotation and immediate revocation.
- Workpeg must never escalate its own permissions.
- Sensitive actions need explicit user authorization.
- Keep Bounty's existing authentication. No separate identity system unless required.
- Migration numbering: our showcase and file-jobs migrations move from 020 and 021 to 022 and 023, because the rules reserve 020 for payment work. Not applied.

## 1. What exists today (verified in code)

- `middleware/auth.js` `authenticate` accepts a Bearer token or the `bounty_session` cookie. It verifies a JWT signed with `JWT_SECRET` (HS256, issuer `bounty-api`, audience `bounty-web`, 7 days).
- It loads the user row on every request and reads the role from the database, not the token.
- Revocation is per user: `users.password_changed_at` and `users.tokens_valid_after` (migration 014) reject every token issued before that time. Logout sets `tokens_valid_after`, so it signs out all of the user's sessions.
- Consequence: today there is no way to revoke one link without revoking the user's whole session. A Workpeg token needs its own revocation point.

## 2. Gap

A Workpeg token must be:
- revocable on its own, without signing the user out everywhere;
- limited to named scopes, not the user's full authority;
- stored only as a hash;
- unable to act as a browser session.

The current JWT design cannot give those properties without changes, so the design adds them.

## 3. Proposed model

### 3.1 Token format and storage (needs schema approval)

- Opaque random token, 256 bits, shown to the user once. Prefix `bnt_wp_` so it is never mistaken for a session JWT.
- Stored as SHA-256 hash only. The plaintext is never written to the database, logs or replies.
- New table `integration_tokens` (additive):
  - `id uuid pk`, `user_id uuid fk users`, `token_hash text unique`, `label text`
  - `scopes text[]` (fixed at issue, see 3.3)
  - `issued_at timestamptz`, `expires_at timestamptz`
  - `last_used_at timestamptz`, `revoked_at timestamptz`, `revoked_reason text`
  - `rotated_from uuid null`
- Append-only audit of issue, use and revoke goes through the existing `audit_events` pattern.

### 3.2 Validation on every request

- New middleware `authenticateIntegration`, used only on `/api/peg/*` routes.
- It hashes the presented token, looks up the row, and rejects if: missing, `revoked_at` set, `expires_at` passed, or the owning user is not active (`account_status`, `is_admin` unchanged).
- It then loads the user row exactly as `authenticate` does, so role and account status are re-read from PostgreSQL every time.
- The standard `authenticate` rejects any `bnt_wp_` token outright. An integration token can never be used on an ordinary route, so it cannot reach routes it was not scoped for.
- Revocation is immediate: the lookup happens on each request, with no cache.

### 3.3 Scopes (least privilege, fixed at issue)

A scope may only be granted if the linked user's current role permits the matching action. Scopes are checked by `requireScope` on each `/api/peg` route.

| Scope | Allows | Role |
|---|---|---|
| `bounties:read` | browse open bounties, read public task fields | worker or business |
| `bounties:draft` | create a draft task (not published) | business |
| `bounties:publish` | publish a draft | business, **per-action confirmation** |
| `applications:write` | start or apply to a task | worker, **per-action confirmation** |
| `submissions:write` | submit or resubmit work | worker, **per-action confirmation** |
| `workspace:read` | read a task's workspace | only after NDA accepted; existing `assertConfidentialAccess` still applies |

Never granted to a Workpeg token, whatever the user asks for:
- approving or rejecting submissions, or requesting revisions;
- accepting agreements (the 428 gate text must be shown to the user, who accepts it);
- payments, escrow, payouts, or any Pandascrow path;
- role, account, enforcement, appeal or report changes;
- admin routes;
- downloading original files (business cannot download originals; previews only).

### 3.4 Sensitive actions need the user (needs schema approval)

- `bounties:publish`, `applications:write` and `submissions:write` do not run on the token alone.
- The Peg call creates a pending confirmation row in `integration_confirmations` (`id`, `token_id`, `action`, `payload_hash`, `expires_at`, `approved_at`, `consumed_at`).
- The user approves in the Bounty web UI, while signed in with a normal session. Only then is the action executed. Approval is single-use and expires within 15 minutes.
- Workpeg's AI can request an action, but can never approve one.

### 3.5 Expiry, rotation and revocation

- Default expiry: 30 days. Maximum: 90 days. Set at issue.
- Rotation: the user issues a new token from the Bounty settings page. The old token is revoked in the same transaction (`rotated_from` links them). Refresh never happens silently.
- Revocation: user can revoke any of their tokens from settings, and logout revokes all of their integration tokens too. Each revocation takes effect on the next request.
- An admin can revoke a token for a suspended or terminated account. Enforcement state is checked on every request, as it is for sessions.

### 3.6 Escalation controls

- Scopes are a fixed list checked server-side against the role. The token body cannot widen them.
- Role is read from the database on each request. A worker token cannot publish, because the role check fails, whatever the scope list says.
- Rate limit per token on `/api/peg` routes. Limits are set in config, values to be confirmed.
- Every Peg call is audited with token id, user id, route and outcome. Never the token, never request bodies containing private content.

### 3.7 Logging and secrets

- Token plaintext never appears in logs, error messages, audit rows or replies.
- Errors use `errorHandler`, so only `expose: true` messages reach the client.
- `JWT_SECRET` is still used only for session JWTs. Integration tokens are not JWTs and do not depend on it.

## 4. Required changes (none applied)

| # | Change | Type | Approval needed |
|---|---|---|---|
| 1 | Renumber showcase and file-jobs migrations 020 and 021 to 022 and 023 | file rename | yes (confirm) |
| 2 | Add `integration_tokens` table | additive schema | yes |
| 3 | Add `integration_confirmations` table | additive schema | yes |
| 4 | `authenticateIntegration` middleware; `authenticate` rejects `bnt_wp_` tokens | code, `middleware/auth.js` | after design approval |
| 5 | `requireScope` and `routes/peg.js` mounted at `/api/peg` | code | after design approval |
| 6 | Settings UI to issue, list, rotate and revoke tokens; confirmation screen | frontend | after design approval |
| 7 | Audit events for issue, use, revoke, confirm | code | after design approval |

## 5. Tests required before any claim that it works

- Revoked token rejected on the next request.
- Expired token rejected.
- Token for a suspended or terminated account rejected.
- Integration token rejected on an ordinary route.
- Each scope denied on a route it does not cover.
- Worker token cannot publish (role check, not only scope).
- Publish, apply and submit do not run without a user-approved confirmation; confirmation is single-use and expires.
- Logout revokes integration tokens.
- Rotation revokes the old token in the same transaction.
- Plaintext token is absent from the database, logs and responses.
- Agreement 428 is returned to the caller and not auto-accepted.

## 6. Open items

- Workpeg's written answer on how an outside service verifies the Workpeg-side user and calls us. This design does not depend on Workpeg verifying anything: the user links their account in Bounty and Bounty issues the token.
- Rate limit values and token lifetimes are proposals.
- Whether to add a Workpeg-side key later. Not part of this design.
