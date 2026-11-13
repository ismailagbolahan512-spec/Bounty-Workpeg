-- 032-appointment-scope.sql (DRAFT)
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scopes_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 7
  AND scopes <@ ARRAY[
    'bounties:read', 'bounties:draft', 'bounties:publish',
    'applications:write', 'submissions:write', 'workspace:read', 'appointments:write'
  ]::TEXT[]);

ALTER TABLE integration_confirmations DROP CONSTRAINT IF EXISTS integration_confirmations_action_check;
ALTER TABLE integration_confirmations ADD CONSTRAINT integration_confirmations_action_check CHECK (
  action IN ('bounties:publish', 'applications:write', 'submissions:write', 'appointments:write'));
