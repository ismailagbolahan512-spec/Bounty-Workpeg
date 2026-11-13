-- ============================================================
-- Verified Pandascrow webhook events. Additive only; nothing is dropped or rewritten.
-- Run once in Neon, after 018. An event is recorded only after its HMAC signature is verified.
-- Recording an event does not move money or unlock any file. That is decided elsewhere.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  environment  TEXT NOT NULL CHECK (environment IN ('live', 'test')),
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_type ON payment_webhook_events (event_type, received_at);

-- Evidence is never edited or deleted. Uses the function created in migration 015.
CREATE OR REPLACE TRIGGER payment_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON payment_webhook_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
