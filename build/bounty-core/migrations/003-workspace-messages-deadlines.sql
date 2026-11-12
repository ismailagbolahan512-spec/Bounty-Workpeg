-- 003: task workspace messages and proposed deadline changes. Additive only.

CREATE TABLE IF NOT EXISTS bounty_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id  UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bounty_messages_bounty ON bounty_messages (bounty_id, created_at);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS proposed_deadline TIMESTAMPTZ;
