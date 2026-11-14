-- Rule checks for migration 034 (docs/drafts/034-appointment-messages.sql). Run against a
-- SCRATCH database only, inside one transaction that is rolled back.
--   psql ... -v ON_ERROR_STOP=0 -f scripts/appointment-messages-schema-test.sql
\set QUIET 1
BEGIN;
\i docs/drafts/034-appointment-messages.sql
-- Foreign keys are skipped here so rows can be built without a whole bounty graph.
SET session_replication_role = replica;

DO $$
DECLARE a UUID := gen_random_uuid(); u UUID := gen_random_uuid(); ok BOOLEAN;
BEGIN
  -- valid message and valid status line are accepted
  INSERT INTO appointment_messages (appointment_id, author_id, kind, body) VALUES (a, u, 'message', 'Hi, on my way');
  INSERT INTO appointment_messages (appointment_id, author_id, kind, status_code) VALUES (a, u, 'status', 'on_the_way');
  RAISE NOTICE 'PASS valid message and status accepted';

  -- each bad row must be refused
  ok := FALSE;
  BEGIN INSERT INTO appointment_messages (appointment_id, author_id, kind, body, status_code) VALUES (a, u, 'message', 'x', 'arrived'); EXCEPTION WHEN check_violation THEN ok := TRUE; END;
  RAISE NOTICE '% message carrying a status is refused', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;

  ok := FALSE;
  BEGIN INSERT INTO appointment_messages (appointment_id, author_id, kind, status_code) VALUES (a, u, 'status', 'teleported'); EXCEPTION WHEN check_violation THEN ok := TRUE; END;
  RAISE NOTICE '% unknown status code is refused', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;

  ok := FALSE;
  BEGIN INSERT INTO appointment_messages (appointment_id, author_id, kind, body) VALUES (a, u, 'message', repeat('x', 1001)); EXCEPTION WHEN check_violation THEN ok := TRUE; END;
  RAISE NOTICE '% message over 1000 characters is refused', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;

  ok := FALSE;
  BEGIN INSERT INTO appointment_messages (appointment_id, author_id, kind, body) VALUES (a, u, 'message', ''); EXCEPTION WHEN check_violation THEN ok := TRUE; END;
  RAISE NOTICE '% empty message is refused', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;

  ok := FALSE;
  BEGIN INSERT INTO appointment_messages (appointment_id, author_id, kind) VALUES (a, u, 'message'); EXCEPTION WHEN check_violation THEN ok := TRUE; END;
  RAISE NOTICE '% message with no body is refused', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;

  -- append-only: an existing row cannot be changed or removed (triggers must be ON here)
  SET LOCAL session_replication_role = origin;
  ok := FALSE;
  BEGIN UPDATE appointment_messages SET body = 'edited' WHERE appointment_id = a; EXCEPTION WHEN insufficient_privilege THEN ok := TRUE; END;
  RAISE NOTICE '% a message cannot be edited', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;

  ok := FALSE;
  BEGIN DELETE FROM appointment_messages WHERE appointment_id = a; EXCEPTION WHEN insufficient_privilege THEN ok := TRUE; END;
  RAISE NOTICE '% a message cannot be deleted', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

ROLLBACK;
\echo 'rolled back: nothing kept'
