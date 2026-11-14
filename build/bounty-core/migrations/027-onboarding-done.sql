-- 027: the worker setup screen saves onboarding_done. Additive and idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN NOT NULL DEFAULT false;
