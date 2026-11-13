# Approval snapshot: migration 033 (DRAFT, not applied)

Status: DRAFT for review. Not in `migrations/`. Not applied to any database.
Purpose: store the exact text that the user approves, so the approval screen can show it,
and the database can check that the stored text matches the hash that was approved.

Depends on: 024, 025, 026 (already on the branch).

## What it stores

`signed_text` holds the canonical JSON that `confirmationHash` already hashes:
`stableStringify({ action, payload })`. The existing `payload_hash` is SHA-256 of that same text.
So the snapshot and the hash cannot drift apart: the database checks it on every write.

## Migration SQL

```sql
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
```

Trigger: unchanged. Migration 026 already attached `integration_confirmations_guard_trg` to this
function name, so replacing the function body is enough.

## Rollback (not executed)

Dropping the column loses the stored text, so export first. Only safe when no approval is
needed for the text any more.

```sql
-- 033-rollback.sql (DRAFT, do not run)
-- Restores the 026 guard body (without signed_text) and drops the new column.
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_signed_text_hash_check;
ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_signed_text_size_check;
ALTER TABLE integration_confirmations DROP COLUMN IF EXISTS signed_text;
-- Then re-run the body of migration 026 to restore its guard function.
```

## Storage and security implications

What is stored, per confirmation:
- The action (already stored) and the canonical text of the action's allowlisted fields.
- The hash (already stored), checked against the text by the database.
- Nothing else new.

What must NOT be stored, enforced in code before the text is built (a per-action allowlist):
- Service addresses, pins, provider base coordinates, or any coordinates beyond the public two
  decimal places.
- Tokens, token hashes, passwords, session cookies, keys, or any secret.
- Email addresses and other account identifiers beyond the user IDs needed to route the approval.
- File contents. Submissions carry file IDs only.
- Anything not on the allowlist. Unknown fields are refused, not stored.

Access:
- Only the token owner can read their pending approvals (`listPendingConfirmations` filters on
  `user_id`). No admin list reads this table.
- The text is shown as plain text in the UI, never as HTML.

Retention:
- Rows are never deleted (migration 026). The stored text therefore lives as long as the record.
  Expired, unapproved rows still contain the text they were requested with. A retention rule
  (for example, clearing `signed_text` after 90 days and keeping the hash) needs your decision.

Limits:
- 4096 bytes maximum, enforced by a CHECK and in code.
- Rows written before this migration have `signed_text` NULL. The approval endpoint must refuse to
  approve those, and the screen says the details are unavailable. This is safer than approving
  something that cannot be shown.
- The database checks the hash, but it does not know the allowlist. The allowlist is code, and it
  is tested in the integration tests when built.

## Code that depends on this (not pushed until the migration is applied)

- `requestConfirmation` writes `signed_text` alongside the hash.
- `approveConfirmation` refuses rows where `signed_text` is NULL.
- `consumeConfirmation` compares the stored text with the text rebuilt from the request.
- The approvals list returns `signed_text` (so the screen can show the details).
- The settings page shows the details, rendered as plain text.

Until 033 is applied, the current code must not reference `signed_text`. Pushing it earlier would
break the approvals list on the live site.
