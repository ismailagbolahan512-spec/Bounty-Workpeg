-- 016: permanent termination as an enforcement action.
-- Additive: widens two CHECK constraints so the new values are allowed. Idempotent.
-- Termination cannot be reversed or appealed through the API (legal review required).

ALTER TABLE enforcement_actions DROP CONSTRAINT IF EXISTS enforcement_actions_action_check;
ALTER TABLE enforcement_actions ADD CONSTRAINT enforcement_actions_action_check
  CHECK (action IN ('warning', 'restrict_publishing', 'suspend', 'terminate', 'reverse'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check
  CHECK (account_status IN ('active', 'restricted', 'suspended', 'terminated'));
