-- 034-appointment-messages.sql (DRAFT, for review, not applied)
-- Chat for one appointment, between its provider and its business, plus short status lines
-- such as "on my way". Append-only: a message is never edited or deleted, the same rule as the
-- appointment history. Author must be a party to the appointment: enforced in code (not a CHECK).
CREATE TABLE IF NOT EXISTS appointment_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  author_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind           VARCHAR(10) NOT NULL CHECK (kind IN ('message', 'status')),
  body           TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000),
  status_code    VARCHAR(20) CHECK (status_code IN ('on_the_way', 'arrived', 'started', 'finished')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'message' AND body IS NOT NULL AND status_code IS NULL)
    OR (kind = 'status' AND status_code IS NOT NULL AND body IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_appointment_messages_thread
  ON appointment_messages (appointment_id, created_at);

CREATE OR REPLACE TRIGGER appointment_messages_append_only
  BEFORE UPDATE OR DELETE ON appointment_messages
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
