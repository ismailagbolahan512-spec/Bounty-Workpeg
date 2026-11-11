// scripts/showcase-sync-test.js — database tests for the showcase trigger (migration 021) and sync.
// Needs DATABASE_URL (a LOCAL test database only). Skipped when it is not set.
// Run: DATABASE_URL=... DATABASE_SSL=false npm run test:showcase-db
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { syncShowcase } = require('../services/showcase/sync');
const { STATE } = require('../services/showcase/publish');

const DB_URL = process.env.DATABASE_URL;
// Only a local throwaway database. The tests write rows that cannot be deleted later.
const LOCAL = DB_URL && ['127.0.0.1', 'localhost', '::1'].includes(new URL(DB_URL.replace(/^postgres(ql)?:/, 'http:')).hostname);
const skip = !LOCAL ? 'set DATABASE_URL to a LOCAL test database (127.0.0.1)' : false;
const pool = DB_URL ? new Pool({ connectionString: DB_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } }) : null;
const tag = `showcase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let businessId = null;

after(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM bounties WHERE business_id = $1`, [businessId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [businessId]).catch(() => {});
    await pool.end();
});

async function ensureBusiness() {
    if (businessId) return businessId;
    const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role, name) VALUES ($1, 'x', 'business', 'Showcase Test') RETURNING id`,
        [`${tag}@example.test`]
    );
    businessId = rows[0].id;
    return businessId;
}

async function newBounty(overrides = {}) {
    const biz = await ensureBusiness();
    const { rows } = await pool.query(
        `INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, deadline, submission_type, status, public_summary)
         VALUES ($1, $2, 'private detail', 'Writing', 'easy', 100, NOW() + INTERVAL '7 days', 'file', 'open', 'Public line.')
         RETURNING id`,
        [biz, overrides.title || 'Original title']
    );
    return rows[0].id;
}

const state = async (id) => (await pool.query(`SELECT showcase_state, showcase_version FROM bounties WHERE id = $1`, [id])).rows[0];

function okPublisher(log = []) {
    return {
        publishBounty: async (row) => { log.push(['publish', row.id]); return { state: STATE.PUBLISHED, problems: [] }; },
        withdrawBounty: async (id) => { log.push(['withdraw', id]); return { state: STATE.OFF, problems: [] }; },
    };
}

test('a new bounty is off, and opting in marks it stale', { skip }, async () => {
    const id = await newBounty();
    assert.equal((await state(id)).showcase_state, 'off');
    await pool.query(`UPDATE bounties SET public_showcase = TRUE WHERE id = $1`, [id]);
    assert.deepEqual(await state(id), { showcase_state: 'stale', showcase_version: 1 });
});

test('a successful sync marks the row published without bumping the version', { skip }, async () => {
    const id = await newBounty();
    await pool.query(`UPDATE bounties SET public_showcase = TRUE WHERE id = $1`, [id]);
    const report = await syncShowcase(pool, okPublisher(), { limit: 200 });
    assert.ok(report.published >= 1);
    assert.deepEqual(await state(id), { showcase_state: 'published', showcase_version: 1 });
});

test('a mirrored edit re-marks the row stale; a non-mirrored edit does not', { skip }, async () => {
    const id = await newBounty();
    await pool.query(`UPDATE bounties SET public_showcase = TRUE WHERE id = $1`, [id]);
    await syncShowcase(pool, okPublisher(), { limit: 200 });

    await pool.query(`UPDATE bounties SET description = 'changed private text' WHERE id = $1`, [id]);
    assert.equal((await state(id)).showcase_state, 'published', 'description is not mirrored');

    await pool.query(`UPDATE bounties SET title = 'New title' WHERE id = $1`, [id]);
    assert.deepEqual(await state(id), { showcase_state: 'stale', showcase_version: 2 });
});

test('an edit made during a publish leaves the row stale for the next run', { skip }, async () => {
    const id = await newBounty();
    await pool.query(`UPDATE bounties SET public_showcase = TRUE WHERE id = $1`, [id]);
    const racing = {
        publishBounty: async (row) => {
            await pool.query(`UPDATE bounties SET reward_amount = 999 WHERE id = $1`, [row.id]);
            return { state: STATE.PUBLISHED, problems: [] };
        },
        withdrawBounty: async () => ({ state: STATE.OFF, problems: [] }),
    };
    const report = await syncShowcase(pool, racing, { limit: 200 });
    assert.ok(report.superseded >= 1);
    assert.equal((await state(id)).showcase_state, 'stale');
});

test('turning the showcase off withdraws the row and sets it off', { skip }, async () => {
    const id = await newBounty();
    await pool.query(`UPDATE bounties SET public_showcase = TRUE WHERE id = $1`, [id]);
    await syncShowcase(pool, okPublisher(), { limit: 200 });
    await pool.query(`UPDATE bounties SET public_showcase = FALSE WHERE id = $1`, [id]);
    assert.equal((await state(id)).showcase_state, 'stale');
    const log = [];
    await syncShowcase(pool, okPublisher(log), { limit: 200 });
    assert.ok(log.some(([kind, rowId]) => kind === 'withdraw' && rowId === id));
    assert.equal((await state(id)).showcase_state, 'off');
});

test('with no Workpeg client, rows stay stale and nothing is marked published', { skip }, async () => {
    const id = await newBounty();
    await pool.query(`UPDATE bounties SET public_showcase = TRUE WHERE id = $1`, [id]);
    const { createShowcasePublisher } = require('../services/showcase/publish');
    const report = await syncShowcase(pool, createShowcasePublisher(), { limit: 200 });
    assert.ok(report.failed >= 1);
    assert.equal((await state(id)).showcase_state, 'stale');
});
