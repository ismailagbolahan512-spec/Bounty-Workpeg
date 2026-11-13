-- 032-appointment-scope.sql (DRAFT, revised 2026-11-13)
-- Widens the allowed integration-token scopes to include hospitality scopes:
--   services:read     — business-only, used by the Workpeg peg to read a business's own requests
--   appointments:write — reserved for a future write path (not used yet)
-- The scopes list is validated in code before this CHECK runs, so a bad role still fails fast.
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scopes_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 8
  AND scopes <@ ARRAY[
    'bounties:read', 'bounties:draft', 'bounties:publish',
    'applications:write', 'submissions:write', 'workspace:read',
    'services:read', 'appointments:write'
  ]::TEXT[]);

ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_action_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_action_check CHECK (
  action IN ('bounties:publish', 'applications:write', 'submissions:write', 'appointments:write'));
