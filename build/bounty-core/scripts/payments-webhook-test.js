// scripts/payments-webhook-test.js — Pandascrow webhook verification and recording.
// The test runner sets PANDASCROW_SECRET_KEY to a test value, so these tests sign with that same key.
const crypto = require('crypto');
const { pool } = require('../db');

const BASE = process.env.BASE || 'http://localhost:3100';
const SECRET = 'sktest-local-test-secret';
const URL_PATH = '/api/payments/pandascrow/webhook';
let passed = 0;
let failed = 0;
function check(label, cond, extra) {
    if (cond) { passed++; console.log('  ✓', label); } else { failed++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}
function sign(body, secret = SECRET) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
async function send({ body, event = 'escrow.paid', signature, timestamp, contentType = 'application/json' }) {
    const headers = { 'content-type': contentType };
    if (event) headers['x-pandascrow-event'] = event;
    if (signature !== undefined) headers['x-pandascrow-signature'] = signature;
    if (timestamp !== undefined) headers['x-pandascrow-timestamp'] = String(timestamp);
    const res = await fetch(BASE + URL_PATH, { method: 'POST', headers, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
const eventId = () => 'evt_' + crypto.randomBytes(8).toString('hex');

(async() => {
    console.log('\n=== Signed events ===');
    const id1 = eventId();
    const body1 = JSON.stringify({ id: id1, type: 'escrow.paid', data: { reference: 'ref-1' } });
    const good = await send({ body: body1, signature: sign(body1), timestamp: nowSeconds() });
    check('a correctly signed event is accepted (200)', good.status === 200 && good.body.recorded === true, good.body);
    const { rows: stored } = await pool.query('SELECT event_type, environment FROM payment_webhook_events WHERE id = $1', [id1]);
    check('the event is recorded once with its type and environment', stored.length === 1 && stored[0].event_type === 'escrow.paid' && stored[0].environment === 'test', stored);

    const again = await send({ body: body1, signature: sign(body1), timestamp: nowSeconds() });
    check('a resent event is acknowledged without a second record', again.status === 200 && again.body.recorded === false, again.body);
    const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_webhook_events WHERE id = $1', [id1]);
    check('the event appears exactly once', count[0].n === 1, count);

    console.log('\n=== Signature checks ===');
    const id2 = eventId();
    const body2 = JSON.stringify({ id: id2, type: 'escrow.completed' });
    const missing = await send({ body: body2, timestamp: nowSeconds() });
    check('a missing signature is refused (401)', missing.status === 401, missing.body);
    const wrongKey = await send({ body: body2, signature: sign(body2, 'sktest-someone-else'), timestamp: nowSeconds() });
    check('a signature from another key is refused (401)', wrongKey.status === 401, wrongKey.body);
    const badFormat = await send({ body: body2, signature: 'sha256=' + sign(body2), timestamp: nowSeconds() });
    check('a prefixed signature is refused (401), since the docs say the bare digest only', badFormat.status === 401, badFormat.body);
    const tampered = await send({ body: body2.replace('escrow.completed', 'escrow.paid'), signature: sign(body2), timestamp: nowSeconds() });
    check('a changed body with the old signature is refused (401)', tampered.status === 401, tampered.body);
    const { rows: none } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_webhook_events WHERE id = $1', [id2]);
    check('no refused event is recorded', none[0].n === 0, none);

    console.log('\n=== Timestamp window ===');
    const id3 = eventId();
    const body3 = JSON.stringify({ id: id3, type: 'escrow.completed' });
    const old = await send({ body: body3, event: 'escrow.completed', signature: sign(body3), timestamp: nowSeconds() - 600 });
    check('a signed event older than five minutes is refused (401)', old.status === 401, old.body);
    const future = await send({ body: body3, event: 'escrow.completed', signature: sign(body3), timestamp: nowSeconds() + 600 });
    check('an event dated more than five minutes ahead is refused (401)', future.status === 401, future.body);
    const noTime = await send({ body: body3, event: 'escrow.completed', signature: sign(body3) });
    check('an event with no timestamp is refused (401)', noTime.status === 401, noTime.body);

    console.log('\n=== Exact bytes ===');
    const id4 = eventId();
    const pretty = JSON.stringify({ id: id4, type: 'escrow.paid', data: { n: 1 } }, null, 2);
    const prettyOk = await send({ body: pretty, event: 'escrow.paid', signature: sign(pretty), timestamp: nowSeconds() });
    check('the signature is checked over the exact bytes received (200)', prettyOk.status === 200 && prettyOk.body.recorded === true, prettyOk.body);
    const reserialized = JSON.stringify(JSON.parse(pretty));
    const reformatted = await send({ body: reserialized, event: 'escrow.paid', signature: sign(pretty), timestamp: nowSeconds() });
    check('a re-serialized copy of the same JSON fails the check (401)', reformatted.status === 401, reformatted.body);

    console.log('\n=== Event handling ===');
    const unknown = await send({ body: JSON.stringify({ id: eventId() }), event: 'account.something', signature: sign(JSON.stringify({ id: 'x' })), timestamp: nowSeconds() });
    const unknownBody = JSON.stringify({ id: eventId() });
    const unknownOk = await send({ body: unknownBody, event: 'account.something', signature: sign(unknownBody), timestamp: nowSeconds() });
    check('an unknown event type is acknowledged but not stored', unknownOk.status === 200 && unknownOk.body.recorded === false, unknownOk.body);
    check('an unsigned unknown event is still refused (401)', unknown.status === 401, unknown.body);
    const badId = JSON.stringify({ id: 'not-an-event-id', type: 'escrow.paid' });
    const badIdRes = await send({ body: badId, event: 'escrow.paid', signature: sign(badId), timestamp: nowSeconds() });
    check('a signed event with a malformed id is refused (400)', badIdRes.status === 400, badIdRes.body);
    const notJson = 'not json at all';
    const notJsonRes = await send({ body: notJson, event: 'escrow.paid', signature: sign(notJson), timestamp: nowSeconds() });
    check('a signed body that is not JSON is refused (400)', notJsonRes.status === 400, notJsonRes.body);

    console.log('\n=== Records are append-only ===');
    let edited = false;
    try { await pool.query("UPDATE payment_webhook_events SET event_type = 'x' WHERE id = $1", [id1]); edited = true; } catch (_) { edited = false; }
    check('a recorded event cannot be edited', edited === false);

    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exit(failed ? 1 : 0);
})().catch(async(err) => {
    console.error('✗ unexpected error:', err);
    await pool.end().catch(() => {});
    process.exit(1);
});
