-- 013: optional total budget for a project. NULL means no cap has been set, so existing
-- projects keep working. When set, the sum of milestone budgets cannot exceed it.
-- Additive only. Safe to run once on existing data.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS total_budget NUMERIC(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_total_budget_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_total_budget_check CHECK (total_budget IS NULL OR total_budget >= 0);
  END IF;
END $$;
