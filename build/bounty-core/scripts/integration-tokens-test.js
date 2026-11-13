// scripts/integration-tokens-test.js — database tests for Workpeg integration tokens and confirmations.
// Design: docs/workpeg-identity-design.md, section 5. Needs DATABASE_URL pointing at a LOCAL
// throwaway database (127.0.0.1, localhost or ::1). The audit trigger blocks deleting audit rows,
// so the test users stay in that database; drop the database after running.
// Run: DATABASE_URL=... DATABASE_SSL=false npm run test:integration-tokens
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const DB_URL = process.env.DATABASE_URL;
const LOCAL = DB_URL && ['127.0.0.1', 'localhost', '::1'].includes(new URL(DB_URL.replace(/^postgres(ql)?:/, 'http:')).hostname);
const skip = !LOCAL ? 'set DATABASE_URL to a LOCAL throwaway database (127.0.0.1)' : false;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-secret-at-least-32-characters-long';

let pool, signToken, errorHandler, notFound, authenticate, tokens;
let server, base;
const tag = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;

before(async () => {
    if (skip) return;
    ({ pool } = require('../db'));
    ({ signToken, authenticate } = require('../middleware/auth'));
    ({ errorHandler, notFound } = require('../middleware/errorHandler'));
    tokens = require('../services/integration-tokens');

    const app = express();
    app.use(express.json());
    app.use('/api/integration-tokens', require('../routes/integration-tokens'));
    app.use('/api/peg', require('../routes/peg'));
    // A route that uses the ordinary session check. An integration token must be refused here.
    app.get('/probe', authenticate, (req, res) => res.json({ ok: true }));
    app.use(notFound);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
});

async function call(method, path, { as = null, token = null, body = undefined } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (as) headers.authorization = `Bearer ${signToken(as)}`;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
}

async function makeUser(role) {
    seq += 1;
    const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role, name) VALUES ($1, 'x', $2, $3)
         RETURNING id, email, role, name`,
        [`${tag}-${seq}@example.test`, role, `${role} ${seq}`]
    );
    return rows[0];
}

async function makeBounty(business, overrides = {}) {
    const { rows } = await pool.query(
        `INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, deadline,
                               submission_type, status, confidential, regions)
         VALUES ($1, $2, 'private detail', $3, 'easy', 50, NOW() + INTERVAL '5 days', 'file', 'open', $4, $5)
         RETURNING id`,
        [business.id, overrides.title || 'Task', overrides.category || 'Writing',
            overrides.confidential === true, overrides.regions || []]
    );
    return rows[0].id;
}

async function issue(user, scopes, extra = {}) {
    const r = await call('POST', '/api/integration-tokens', {
        as: user, body: { label: 'test link', scopes, ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
}

const SKIP = { skip: skip };

test('issue: token is shown once and only its hash is stored', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    assert.match(issued.token, /^bnt_wp_[A-Za-z0-9_-]{43}$/);
    const hash = crypto.createHash('sha256').update(issued.token).digest('hex');
    const byHash = await pool.query('SELECT id FROM integration_tokens WHERE token_hash = $1', [hash]);
    assert.equal(byHash.rows.length, 1);
    const plain = await pool.query('SELECT id FROM integration_tokens WHERE token_hash = $1', [issued.token]);
    assert.equal(plain.rows.length, 0, 'plaintext must not be stored');
    const listed = await call('GET', '/api/integration-tokens', { as: worker });
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(listed.body).includes(issued.token), false, 'listing must not reveal the token');
});

test('a Workpeg token works on /api/peg and carries its scopes', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    const me = await call('GET', '/api/peg/me', { token: issued.token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.scopes, ['bounties:read']);
    assert.equal(me.body.user.role, 'worker');
});

test('a Workpeg token is refused on an ordinary session route', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    const r = await call('GET', '/probe', { token: issued.token });
    assert.equal(r.status, 401);
    assert.match(r.body.message, /only accepted on integration routes/);
});

test('issue refuses scopes the role cannot hold, and unknown scopes', SKIP, async () => {
    const worker = await makeUser('worker');
    const pub = await call('POST', '/api/integration-tokens', { as: worker, body: { label: 'x', scopes: ['bounties:publish'] } });
    assert.equal(pub.status, 403);
    const unknown = await call('POST', '/api/integration-tokens', { as: worker, body: { label: 'x', scopes: ['admin:all'] } });
    assert.equal(unknown.status, 400);
    const none = await call('POST', '/api/integration-tokens', { as: worker, body: { label: 'x', scopes: [] } });
    assert.equal(none.status, 400);
    const longLife = await call('POST', '/api/integration-tokens', { as: worker, body: { label: 'x', scopes: ['bounties:read'], days: 120 } });
    assert.equal(longLife.status, 400);
});

test('admins cannot hold integration tokens', SKIP, async () => {
    const admin = await makeUser('admin');
    await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [admin.id]);
    const r = await call('POST', '/api/integration-tokens', { as: admin, body: { label: 'x', scopes: ['bounties:read'] } });
    assert.equal(r.status, 403);
});

test('a token with a scope the owner no longer holds is refused at request time', SKIP, async () => {
    const biz = await makeUser('business');
    const issued = await issue(biz, ['bounties:read', 'bounties:publish']);
    // Role changes after issue. The old token must not gain the worker's rights, or keep the business's.
    await pool.query(`UPDATE users SET role = 'worker' WHERE id = $1`, [biz.id]);
    const r = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'bounties:publish', payload: { draft: 1 } },
    });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /Your role cannot use bounties:publish/);
    await pool.query(`UPDATE users SET role = 'business' WHERE id = $1`, [biz.id]);
});

test('a scope not on the token is refused even if the role allows it', SKIP, async () => {
    const biz = await makeUser('business');
    const issued = await issue(biz, ['bounties:read']);
    const r = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'bounties:publish', payload: { draft: 1 } },
    });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /does not allow bounties:publish/);
});

test('revoked token is refused on the very next request', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    assert.equal((await call('GET', '/api/peg/me', { token: issued.token })).status, 200);
    const rv = await call('POST', `/api/integration-tokens/${issued.id}/revoke`, { as: worker });
    assert.equal(rv.status, 200);
    const after = await call('GET', '/api/peg/me', { token: issued.token });
    assert.equal(after.status, 401);
});

test('a revoked token cannot be revoked twice, and another user cannot revoke it', SKIP, async () => {
    const owner = await makeUser('worker');
    const other = await makeUser('worker');
    const issued = await issue(owner, ['bounties:read']);
    const byOther = await call('POST', `/api/integration-tokens/${issued.id}/revoke`, { as: other });
    assert.equal(byOther.status, 404);
    assert.equal((await call('GET', '/api/peg/me', { token: issued.token })).status, 200);
    assert.equal((await call('POST', `/api/integration-tokens/${issued.id}/revoke`, { as: owner })).status, 200);
    assert.equal((await call('POST', `/api/integration-tokens/${issued.id}/revoke`, { as: owner })).status, 404);
});

test('expired token is refused', SKIP, async () => {
    const worker = await makeUser('worker');
    const plain = 'bnt_wp_' + crypto.randomBytes(32).toString('base64url');
    await pool.query(
        `INSERT INTO integration_tokens (user_id, token_hash, label, scopes, issued_at, expires_at)
         VALUES ($1, $2, 'old', ARRAY['bounties:read'], NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')`,
        [worker.id, crypto.createHash('sha256').update(plain).digest('hex')]
    );
    const r = await call('GET', '/api/peg/me', { token: plain });
    assert.equal(r.status, 401);
});

test('rotation revokes the old token and keeps the scopes', SKIP, async () => {
    const worker = await makeUser('worker');
    const first = await issue(worker, ['bounties:read', 'workspace:read']);
    const rot = await call('POST', `/api/integration-tokens/${first.id}/rotate`, { as: worker, body: { days: 10 } });
    assert.equal(rot.status, 201);
    assert.deepEqual(rot.body.scopes.sort(), ['bounties:read', 'workspace:read']);
    assert.equal((await call('GET', '/api/peg/me', { token: first.token })).status, 401);
    assert.equal((await call('GET', '/api/peg/me', { token: rot.body.token })).status, 200);
    const old = await pool.query('SELECT revoked_reason FROM integration_tokens WHERE id = $1', [first.id]);
    assert.equal(old.rows[0].revoked_reason, 'rotated');
});

test('a password change after issue refuses the token', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    await pool.query(`UPDATE users SET password_changed_at = NOW() + INTERVAL '1 second' WHERE id = $1`, [worker.id]);
    const r = await call('GET', '/api/peg/me', { token: issued.token });
    assert.equal(r.status, 401);
    assert.match(r.body.message, /password was changed/);
});

test('a suspended account cannot use its token', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    await pool.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [worker.id]);
    const r = await call('GET', '/api/peg/me', { token: issued.token });
    assert.equal(r.status, 403);
    await pool.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [worker.id]);
});

test('logout revokes every Workpeg token the user holds', SKIP, async () => {
    const worker = await makeUser('worker');
    const a = await issue(worker, ['bounties:read']);
    const b = await issue(worker, ['bounties:read']);
    await tokens.revokeAllForUser(worker.id, 'logout');
    assert.equal((await call('GET', '/api/peg/me', { token: a.token })).status, 401);
    assert.equal((await call('GET', '/api/peg/me', { token: b.token })).status, 401);
});

test('bounties list returns only open, public, non-regional tasks', SKIP, async () => {
    const biz = await makeUser('business');
    const worker = await makeUser('worker');
    const open = await makeBounty(biz, { title: 'open public', category: `cat-${tag}` });
    const secret = await makeBounty(biz, { title: 'confidential', category: `cat-${tag}`, confidential: true });
    const regional = await makeBounty(biz, { title: 'regional', category: `cat-${tag}`, regions: ['NG'] });
    const issued = await issue(worker, ['bounties:read']);
    const r = await call('GET', `/api/peg/bounties?category=cat-${tag}&limit=20`, { token: issued.token });
    assert.equal(r.status, 200);
    const ids = r.body.bounties.map((b) => b.id);
    assert.ok(ids.includes(open));
    assert.equal(ids.includes(secret), false);
    assert.equal(ids.includes(regional), false);
    assert.equal(typeof r.body.bounties[0].reward_amount, 'number');
    assert.equal('description' in r.body.bounties[0], false, 'private detail must not be returned');
});

test('bounties list needs the bounties:read scope', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['submissions:write']);
    const r = await call('GET', '/api/peg/bounties', { token: issued.token });
    assert.equal(r.status, 403);
});

test('confirmation: pending until approved, approved only by the owner, single use, exact payload', SKIP, async () => {
    const biz = await makeUser('business');
    const other = await makeUser('business');
    const issued = await issue(biz, ['bounties:publish']);
    const payload = { draft_id: 'd1', title: 'Website', milestones: [{ name: 'M1' }] };

    const req = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'bounties:publish', payload },
    });
    assert.equal(req.status, 201);
    assert.equal(req.body.status, 'awaiting_user_approval');
    const confId = req.body.id;

    // Not approved yet: consumption refused.
    assert.equal(await tokens.consumeConfirmation(pool, { confirmationId: confId, tokenId: issued.id, action: 'bounties:publish', payload }), false);
    // Another user cannot approve it.
    assert.equal((await call('POST', `/api/integration-tokens/confirmations/${confId}/approve`, { as: other })).status, 404);
    // The owner approves.
    const ok = await call('POST', `/api/integration-tokens/confirmations/${confId}/approve`, { as: biz });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.approved, true);
    // A second approval is refused.
    assert.equal((await call('POST', `/api/integration-tokens/confirmations/${confId}/approve`, { as: biz })).status, 404);

    // Changed payload is refused, and the approval is not used up by it.
    const changed = { ...payload, title: 'Something else' };
    assert.equal(await tokens.consumeConfirmation(pool, { confirmationId: confId, tokenId: issued.id, action: 'bounties:publish', payload: changed }), false);
    // Exact payload works once.
    assert.equal(await tokens.consumeConfirmation(pool, { confirmationId: confId, tokenId: issued.id, action: 'bounties:publish', payload }), true);
    assert.equal(await tokens.consumeConfirmation(pool, { confirmationId: confId, tokenId: issued.id, action: 'bounties:publish', payload }), false);
});

test('confirmation: payload key order does not change the approval', SKIP, async () => {
    const a = tokens.confirmationHash('bounties:publish', { x: 1, y: { b: 2, a: 1 } });
    const b = tokens.confirmationHash('bounties:publish', { y: { a: 1, b: 2 }, x: 1 });
    assert.equal(a, b);
});

test('confirmation: the approval is bound to the action as well as the payload', SKIP, async () => {
    const biz = await makeUser('business');
    const issued = await issue(biz, ['bounties:publish']);
    const payload = { draft_id: 'bind-1' };
    const req = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'bounties:publish', payload },
    });
    assert.equal(req.status, 201);
    await call('POST', `/api/integration-tokens/confirmations/${req.body.id}/approve`, { as: biz });
    // Same payload, different action: refused.
    assert.equal(await tokens.consumeConfirmation(pool, {
        confirmationId: req.body.id, tokenId: issued.id, action: 'submissions:write', payload,
    }), false);
    // The exact action and payload: accepted once.
    assert.equal(await tokens.consumeConfirmation(pool, {
        confirmationId: req.body.id, tokenId: issued.id, action: 'bounties:publish', payload,
    }), true);
});

test('database: an approved confirmation cannot have its action, payload or expiry changed', SKIP, async () => {
    const biz = await makeUser('business');
    const issued = await issue(biz, ['bounties:publish']);
    const req = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'bounties:publish', payload: { draft_id: 'lock-1' } },
    });
    const id = req.body.id;
    await call('POST', `/api/integration-tokens/confirmations/${id}/approve`, { as: biz });

    await assert.rejects(
        pool.query(`UPDATE integration_confirmations SET action = 'submissions:write' WHERE id = $1`, [id]),
        /cannot be changed/
    );
    await assert.rejects(
        pool.query(`UPDATE integration_confirmations SET payload_hash = $2 WHERE id = $1`, [id, 'b'.repeat(64)]),
        /cannot be changed/
    );
    await assert.rejects(
        pool.query(`UPDATE integration_confirmations SET expires_at = expires_at + INTERVAL '1 day' WHERE id = $1`, [id]),
        /cannot be changed/
    );
    await assert.rejects(
        pool.query(`UPDATE integration_confirmations SET approved_at = NOW() + INTERVAL '1 minute' WHERE id = $1`, [id]),
        /approval cannot be changed/
    );
    await assert.rejects(
        pool.query(`DELETE FROM integration_confirmations WHERE id = $1`, [id]),
        /cannot be deleted/
    );
    // The row is unchanged after every refused attempt.
    const row = await pool.query('SELECT action, approved_at FROM integration_confirmations WHERE id = $1', [id]);
    assert.equal(row.rows[0].action, 'bounties:publish');
    assert.notEqual(row.rows[0].approved_at, null);
});

test('confirmation: expired approval is refused', SKIP, async () => {
    const biz = await makeUser('business');
    const issued = await issue(biz, ['bounties:publish']);
    const { rows } = await pool.query(
        `INSERT INTO integration_confirmations (token_id, action, payload_hash, requested_at, expires_at)
         VALUES ($1, 'bounties:publish', $2, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '10 minutes') RETURNING id`,
        [issued.id, 'a'.repeat(64)]
    );
    assert.equal((await call('POST', `/api/integration-tokens/confirmations/${rows[0].id}/approve`, { as: biz })).status, 404);
});

test('confirmation: a token without the scope cannot request approval for that action', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['bounties:read']);
    const r = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'submissions:write', payload: { file: 'x' } },
    });
    assert.equal(r.status, 403);
});

test('confirmation: non-sensitive actions and non-object payloads are refused', SKIP, async () => {
    const worker = await makeUser('worker');
    const issued = await issue(worker, ['submissions:write']);
    const notSensitive = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'workspace:read', payload: {} },
    });
    assert.equal(notSensitive.status, 400);
    const badPayload = await call('POST', '/api/peg/confirmations', {
        token: issued.token, body: { action: 'submissions:write', payload: ['x'] },
    });
    assert.equal(badPayload.status, 400);
});
