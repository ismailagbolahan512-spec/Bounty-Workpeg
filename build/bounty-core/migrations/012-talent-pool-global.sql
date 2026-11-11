-- Phase 4: private talent pool (lists, notes, invitations with worker consent) and global access
-- (declared country, task region limits). Every statement is idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS country CHAR(2);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS regions CHAR(2)[] NOT NULL DEFAULT '{}'::char(2)[];

-- A business's private lists of workers. Only the business can see them.
CREATE TABLE IF NOT EXISTS talent_lists (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         VARCHAR(80) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT talent_lists_name_unique UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS talent_list_members (
  list_id    UUID NOT NULL REFERENCES talent_lists(id) ON DELETE CASCADE,
  worker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (list_id, worker_id)
);

-- Private notes a business keeps about a worker. Never shown to the worker.
CREATE TABLE IF NOT EXISTS talent_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         VARCHAR(1000) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_talent_notes_pair ON talent_notes (business_id, worker_id, created_at);

-- Invitations need the worker's acceptance. Accepting records consent; it assigns no work and no payment.
CREATE TABLE IF NOT EXISTS talent_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bounty_id    UUID REFERENCES bounties(id) ON DELETE CASCADE,
  message      VARCHAR(500) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  CONSTRAINT talent_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_invitation_per_task
  ON talent_invitations (business_id, worker_id, COALESCE(bounty_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_talent_invitations_worker ON talent_invitations (worker_id, status);
CREATE INDEX IF NOT EXISTS idx_talent_invitations_business ON talent_invitations (business_id, created_at);
