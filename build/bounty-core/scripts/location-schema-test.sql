-- scripts/location-schema-test.sql — schema rules for migrations 027 to 033.
-- Run against a SCRATCH database only, after 027 to 033 are applied:
--   psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/location-schema-test.sql
-- Everything runs in one transaction and is rolled back, so no rows remain.
-- Each refusal is checked: an expected refusal that does NOT happen fails the run.
-- Design: docs/drafts/sql/ (the revised 027 to 033 set) and docs/drafts/hospitality-schema-review.md.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.expect_refused(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'FAIL (should be refused): %', label;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'FAIL (should be refused)%' THEN
    RAISE;
  END IF;
  RAISE NOTICE 'PASS refused: %', label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS accepted: %', label;
END;
$$;

-- ---------- fixtures ----------
INSERT INTO users (id, email, name, role, password_hash) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'biz-test@example.com', 'Test Business', 'business', 'x'),
  ('00000000-0000-4000-8000-00000000000b', 'prov-test@example.com', 'Test Provider', 'worker', 'x'),
  ('00000000-0000-4000-8000-00000000000c', 'prov2-test@example.com', 'Second Provider', 'worker', 'x');

INSERT INTO bounties (id, business_id, title, description, category, difficulty, reward_amount, submission_type, deadline, status)
VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000a',
        'Remote task', 'desc', 'Web Development', 'easy', 100, 'file', NOW() + INTERVAL '7 days', 'open');

-- ---------- 027: task mode and public area ----------
SELECT pg_temp.expect_refused($$INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, submission_type, deadline, task_mode)
  VALUES ('00000000-0000-4000-8000-00000000000a','t','d','Web Development','easy',1,'file',NOW()+INTERVAL '1 day','hybrid')$$, '027 task_mode outside remote/onsite');
SELECT pg_temp.expect_refused($$INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, submission_type, deadline, task_mode)
  VALUES ('00000000-0000-4000-8000-00000000000a','t','d','Web Development','easy',1,'file',NOW()+INTERVAL '1 day','onsite')$$, '027 onsite without area');
SELECT pg_temp.expect_refused($$INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, submission_type, deadline, task_mode, area_label, approx_lat, approx_lng)
  VALUES ('00000000-0000-4000-8000-00000000000a','t','d','Web Development','easy',1,'file',NOW()+INTERVAL '1 day','onsite','Victoria Island',91,3.42)$$, '027 onsite latitude out of range');
SELECT pg_temp.expect_ok($$INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, submission_type, deadline, task_mode, area_label, approx_lat, approx_lng)
  VALUES ('00000000-0000-4000-8000-00000000000a','Linen','d','Web Development','easy',1,'file',NOW()+INTERVAL '1 day','onsite','Victoria Island, Lagos',6.43,3.42)$$, '027 valid onsite task');
SELECT pg_temp.expect_ok($$INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, submission_type, deadline)
  VALUES ('00000000-0000-4000-8000-00000000000a','Remote again','d','Web Development','easy',1,'file',NOW()+INTERVAL '1 day')$$, '027 remote task needs no location');

-- ---------- 028: provider service areas ----------
SELECT pg_temp.expect_ok($$INSERT INTO provider_service_areas (user_id, area_label, base_lat, base_lng, radius_km)
  VALUES ('00000000-0000-4000-8000-00000000000b','Yaba, Lagos',6.51,3.38,10)$$, '028 valid provider area');
SELECT pg_temp.expect_refused($$INSERT INTO provider_service_areas (user_id, area_label, base_lat, base_lng, radius_km)
  VALUES ('00000000-0000-4000-8000-00000000000c','Yaba',6.51,3.38,0)$$, '028 radius below 1 km');
SELECT pg_temp.expect_refused($$INSERT INTO provider_service_areas (user_id, area_label, base_lat, base_lng, radius_km)
  VALUES ('00000000-0000-4000-8000-00000000000c','Yaba',100,3.38,10)$$, '028 base latitude out of range');

-- ---------- 029: private service addresses (region and time zone come from the location) ----------
SELECT pg_temp.expect_ok($$INSERT INTO service_locations (bounty_id, address_text, lat, lng, region_code, time_zone, created_by)
  SELECT id, '12 Adeola Odeku St', 6.4281, 3.4219, 'NG', 'Africa/Lagos', '00000000-0000-4000-8000-00000000000a'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '029 valid service address');
SELECT pg_temp.expect_refused($$INSERT INTO service_locations (bounty_id, address_text, lat, lng, region_code, time_zone, created_by)
  SELECT id, 'abc', 6.4281, 3.4219, 'NG', 'Africa/Lagos', '00000000-0000-4000-8000-00000000000a'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '029 address shorter than 5 characters');
SELECT pg_temp.expect_refused($$INSERT INTO service_locations (bounty_id, address_text, lat, lng, region_code, time_zone, created_by)
  SELECT id, '99 Other St', 6.4, 3.4, 'NG', 'Africa/Lagos', '00000000-0000-4000-8000-00000000000a'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '029 second address for the same task');
SELECT pg_temp.expect_refused($$INSERT INTO service_locations (bounty_id, address_text, lat, lng, region_code, time_zone, created_by)
  SELECT id, '5 Test Road', 6.4, 3.4, 'nga', 'Africa/Lagos', '00000000-0000-4000-8000-00000000000a'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '029 region code that is not two capital letters');

-- ---------- 030: quotations (amount is in the task currency; no currency column) ----------
SELECT pg_temp.expect_ok($$INSERT INTO quotations (bounty_id, provider_id, amount)
  SELECT id, '00000000-0000-4000-8000-00000000000b', 5000 FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '030 valid quotation');
SELECT pg_temp.expect_refused($$INSERT INTO quotations (bounty_id, provider_id, amount)
  SELECT id, '00000000-0000-4000-8000-00000000000c', 0 FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '030 zero amount');
SELECT pg_temp.expect_refused($$INSERT INTO quotations (bounty_id, provider_id, amount)
  SELECT id, '00000000-0000-4000-8000-00000000000b', 6000 FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '030 second pending quotation from the same provider');
SELECT pg_temp.expect_ok($$INSERT INTO quotations (bounty_id, provider_id, amount, status)
  SELECT id, '00000000-0000-4000-8000-00000000000b', 5200, 'accepted' FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '030 one accepted quotation on a task');
SELECT pg_temp.expect_refused($$INSERT INTO quotations (bounty_id, provider_id, amount, status)
  SELECT id, '00000000-0000-4000-8000-00000000000c', 6000, 'accepted' FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '030 second accepted quotation on one task');
SELECT pg_temp.expect_ok($$UPDATE quotations SET status = 'declined' WHERE provider_id = '00000000-0000-4000-8000-00000000000b' AND status = 'pending'$$, '030 pending quote declined');
SELECT pg_temp.expect_ok($$INSERT INTO quotations (bounty_id, provider_id, amount)
  SELECT id, '00000000-0000-4000-8000-00000000000b', 5500 FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '030 same provider quotes again after a decline');
SELECT pg_temp.expect_refused($$INSERT INTO bounties (business_id, title, description, category, reward_amount, deadline, currency)
  VALUES ('00000000-0000-4000-8000-00000000000a', 'Currency probe', 'x', 'other', 1, NOW() + INTERVAL '1 day', 'ngn')$$, '027 lowercase currency code on a task');
SELECT pg_temp.expect_refused($$INSERT INTO bounties (business_id, title, description, category, reward_amount, deadline, currency)
  VALUES ('00000000-0000-4000-8000-00000000000a', 'Currency probe', 'x', 'other', 1, NOW() + INTERVAL '1 day', 'NAIRA')$$, '027 currency longer than three letters');

-- ---------- 031: appointments and history ----------
SELECT pg_temp.expect_ok($$INSERT INTO appointments (id, bounty_id, provider_id, starts_at, ends_at, proposed_by)
  SELECT '00000000-0000-4000-8000-0000000000e1', id, '00000000-0000-4000-8000-00000000000b',
         NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 2 hours', '00000000-0000-4000-8000-00000000000b'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '031 valid proposed appointment');
SELECT pg_temp.expect_refused($$INSERT INTO appointments (bounty_id, provider_id, starts_at, ends_at, proposed_by)
  SELECT id, '00000000-0000-4000-8000-00000000000c', NOW()+INTERVAL '2 days', NOW()+INTERVAL '2 days 1 hour', '00000000-0000-4000-8000-00000000000c'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '031 second live appointment for the same task');
SELECT pg_temp.expect_refused($$INSERT INTO appointments (bounty_id, provider_id, starts_at, ends_at, proposed_by, status)
  SELECT id, '00000000-0000-4000-8000-00000000000c', NOW()+INTERVAL '2 days', NOW()+INTERVAL '1 days', '00000000-0000-4000-8000-00000000000c', 'superseded'
  FROM bounties WHERE task_mode = 'onsite' LIMIT 1$$, '031 window that ends before it starts');
SELECT pg_temp.expect_refused($$UPDATE appointments SET status = 'confirmed' WHERE id = '00000000-0000-4000-8000-0000000000e1'$$, '031 confirmed without either confirmation');
SELECT pg_temp.expect_refused($$UPDATE appointments SET status = 'confirmed',
  provider_confirmed_at = NOW(), provider_confirmed_by = '00000000-0000-4000-8000-00000000000b',
  business_confirmed_at = NOW(), business_confirmed_by = '00000000-0000-4000-8000-00000000000b'
  WHERE id = '00000000-0000-4000-8000-0000000000e1'$$, '031 same person confirms both sides');
SELECT pg_temp.expect_ok($$UPDATE appointments SET status = 'confirmed',
  provider_confirmed_at = NOW(), provider_confirmed_by = '00000000-0000-4000-8000-00000000000b',
  business_confirmed_at = NOW(), business_confirmed_by = '00000000-0000-4000-8000-00000000000a'
  WHERE id = '00000000-0000-4000-8000-0000000000e1'$$, '031 confirmed by two different people');
SELECT pg_temp.expect_ok($$INSERT INTO appointment_events (appointment_id, actor_id, event, details)
  VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000b', 'confirmed_by_provider', '{}'::jsonb)$$, '031 history event');
SELECT pg_temp.expect_refused($$UPDATE appointment_events SET event = 'cancelled'$$, '031 history event cannot be edited');
SELECT pg_temp.expect_refused($$DELETE FROM appointment_events$$, '031 history event cannot be deleted');
SELECT pg_temp.expect_refused($$INSERT INTO appointment_events (appointment_id, actor_id, event, details)
  VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000b', 'confirmed_by_provider', jsonb_build_object('x', repeat('a', 3000)))$$, '031 history details over 2048 bytes');

-- ---------- 032: appointment scope ----------
SELECT pg_temp.expect_ok($$INSERT INTO integration_tokens (user_id, token_hash, label, scopes, expires_at)
  VALUES ('00000000-0000-4000-8000-00000000000b', repeat('a', 64), 'appt', ARRAY['appointments:write'], NOW()+INTERVAL '30 days')$$, '032 token with appointments:write');
SELECT pg_temp.expect_refused($$INSERT INTO integration_tokens (user_id, token_hash, label, scopes, expires_at)
  VALUES ('00000000-0000-4000-8000-00000000000b', repeat('b', 64), 'bad', ARRAY['admin:all'], NOW()+INTERVAL '30 days')$$, '032 unknown scope');
SELECT pg_temp.expect_refused($$INSERT INTO integration_tokens (user_id, token_hash, label, scopes, expires_at)
  VALUES ('00000000-0000-4000-8000-00000000000b', repeat('c', 64), 'none', ARRAY[]::TEXT[], NOW()+INTERVAL '30 days')$$, '032 token with no scopes');

-- ---------- 024 to 026 and 033: confirmations and the approval snapshot ----------
INSERT INTO integration_tokens (id, user_id, token_hash, label, scopes, expires_at)
VALUES ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-00000000000b', repeat('d', 64), 'main', ARRAY['applications:write'], NOW()+INTERVAL '30 days');

-- The canonical text the app would produce for {action, payload}, and its hash computed in SQL.
-- The application hashes the same text with Node's sha256 of UTF-8 bytes.
SELECT pg_temp.expect_ok($$INSERT INTO integration_confirmations (id, token_id, action, payload_hash, expires_at, signed_text)
  VALUES ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000f1', 'applications:write',
    encode(sha256(convert_to('{"action":"applications:write","payload":{"bounty_id":"x","amount":5000}}','UTF8')),'hex'),
    NOW()+INTERVAL '10 minutes', '{"action":"applications:write","payload":{"bounty_id":"x","amount":5000}}')$$, '033 snapshot that matches its hash');
SELECT pg_temp.expect_refused($$INSERT INTO integration_confirmations (token_id, action, payload_hash, expires_at, signed_text)
  VALUES ('00000000-0000-4000-8000-0000000000f1', 'applications:write', repeat('e', 64), NOW()+INTERVAL '10 minutes',
    '{"action":"applications:write","payload":{"bounty_id":"x","amount":9}}')$$, '033 snapshot that does not match its hash');
SELECT pg_temp.expect_refused($$UPDATE integration_confirmations SET signed_text = '{"action":"applications:write","payload":{"bounty_id":"x","amount":1}}'
  WHERE id = '00000000-0000-4000-8000-0000000000f2'$$, '033 snapshot cannot be changed after request');
SELECT pg_temp.expect_refused($$UPDATE integration_confirmations SET payload_hash = repeat('0', 64) WHERE id = '00000000-0000-4000-8000-0000000000f2'$$, '026 hash cannot be changed after request');
SELECT pg_temp.expect_refused($$INSERT INTO integration_confirmations (token_id, action, payload_hash, expires_at, signed_text)
  VALUES ('00000000-0000-4000-8000-0000000000f1', 'applications:write',
    encode(sha256(convert_to(repeat('x', 4100),'UTF8')),'hex'), NOW()+INTERVAL '10 minutes', repeat('x', 4100))$$, '033 snapshot over 4096 bytes');
SELECT pg_temp.expect_ok($$INSERT INTO integration_confirmations (token_id, action, payload_hash, expires_at)
  VALUES ('00000000-0000-4000-8000-0000000000f1', 'applications:write', repeat('f', 64), NOW()+INTERVAL '10 minutes')$$, '033 legacy row with no snapshot is allowed');
SELECT pg_temp.expect_ok($$UPDATE integration_confirmations SET approved_at = NOW() WHERE id = '00000000-0000-4000-8000-0000000000f2'$$, '026 first approval recorded');
SELECT pg_temp.expect_refused($$UPDATE integration_confirmations SET approved_at = NOW() + INTERVAL '1 minute' WHERE id = '00000000-0000-4000-8000-0000000000f2'$$, '026 approval cannot be moved');
SELECT pg_temp.expect_refused($$DELETE FROM integration_confirmations WHERE id = '00000000-0000-4000-8000-0000000000f2'$$, '026 confirmation cannot be deleted');

DO $$ BEGIN RAISE NOTICE 'ALL SCHEMA TESTS PASSED'; END $$;

ROLLBACK;
