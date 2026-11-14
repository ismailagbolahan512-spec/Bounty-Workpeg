-- 004: AI Task Architect support. Additive, and safe to run more than once.

-- Deadlines were stored as TIMESTAMP (no time zone) while the API sends UTC ISO strings.
-- Convert them once, treating the stored clock time as UTC. The guard stops a second run
-- from shifting values again.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'bounties' AND column_name = 'deadline') = 'timestamp without time zone' THEN
    ALTER TABLE bounties
      ALTER COLUMN deadline TYPE TIMESTAMPTZ USING deadline AT TIME ZONE 'UTC';
  END IF;
END $$;

-- One row per AI call, used for the per-account daily cap and for cost monitoring.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature       VARCHAR(50) NOT NULL,
  input_chars   INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER,
  outcome       VARCHAR(20) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON ai_usage_log (user_id, created_at);
