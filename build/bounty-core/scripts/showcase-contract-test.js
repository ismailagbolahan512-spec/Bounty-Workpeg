// scripts/showcase-contract-test.js — unit tests for the Workpeg showcase contract (no DB, no network).
// Run: npm run test:showcase
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SHOWCASE_FIELDS, SUMMARY_MAX, makeSummary, toShowcaseTask, validateShowcaseTask } = require('../services/showcase/contract');
const { STATE, createShowcasePublisher } = require('../services/showcase/publish');

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
function row(overrides = {}) {
    return {
        id: ID,
        business_id: '11111111-1111-4111-8111-111111111111',
        title: 'Translate the onboarding guide',
        description: 'Translate  the guide into French.\n\nKeep headings.',
        public_summary: 'Translate our onboarding guide into French.',
        category: 'Writing',
        difficulty: 'easy',
        reward_amount: '250.00',
        deadline: new Date('2026-12-01T00:00:00Z'),
        submission_type: 'file',
        requirements: 'private internal note',
        status: 'open',
        winner_id: '22222222-2222-4222-8222-222222222222',
        nda_text: 'confidential',
        rules_of_engagement: 'do not share',
        updated_at: new Date('2026-11-10T09:30:00Z'),
        ...overrides,
    };
}

test('the showcase copies only allowlisted fields', () => {
    const task = toShowcaseTask(row());
    assert.deepEqual(Object.keys(task).sort(), [...SHOWCASE_FIELDS].sort());
    for (const secret of ['business_id', 'winner_id', 'requirements', 'nda_text', 'rules_of_engagement', 'difficulty', 'submission_type']) {
        assert.equal(Object.prototype.hasOwnProperty.call(task, secret), false, `${secret} must not be copied`);
    }
});

test('summary comes only from public_summary, never description', () => {
    assert.equal(toShowcaseTask(row()).summary, 'Translate our onboarding guide into French.');
    assert.equal(toShowcaseTask(row({ public_summary: null, description: 'secret detail' })).summary, '');
});

test('reward is a number and deadline/updated_at are ISO strings', () => {
    const task = toShowcaseTask(row());
    assert.equal(task.reward_amount, 250);
    assert.equal(task.deadline, '2026-12-01T00:00:00.000Z');
    assert.equal(task.updated_at, '2026-11-10T09:30:00.000Z');
});

test('summary strips control characters, collapses whitespace and is capped', () => {
    assert.equal(makeSummary('a\u0000b\tc   d\n\ne'), 'a b c d e');
    const long = 'x'.repeat(1000);
    const cut = makeSummary(long);
    assert.ok(cut.length <= SUMMARY_MAX);
    assert.ok(cut.endsWith('…'));
    assert.equal(makeSummary(null), '');
});

test('a valid mapped task has no problems', () => {
    assert.deepEqual(validateShowcaseTask(toShowcaseTask(row())), []);
});

test('each structural invariant is enforced', () => {
    const base = toShowcaseTask(row());
    const cases = [
        [{ pg_id: 'not-a-uuid' }, 'pg_id'],
        [{ title: '   ' }, 'title'],
        [{ title: 'x'.repeat(256) }, 'title'],
        [{ category: '' }, 'category'],
        [{ reward_amount: -1 }, 'reward_amount'],
        [{ reward_amount: Number.NaN }, 'reward_amount'],
        [{ reward_amount: 1e12 }, 'reward_amount'],
        [{ deadline: 'not a date' }, 'deadline'],
        [{ status: 'deleted' }, 'status'],
        [{ summary: 'x'.repeat(SUMMARY_MAX + 1) }, 'summary'],
        [{ updated_at: null }, 'updated_at'],
        [{ winner_id: '22222222-2222-4222-8222-222222222222' }, 'unexpected field: winner_id'],
    ];
    for (const [patch, expected] of cases) {
        const problems = validateShowcaseTask({ ...base, ...patch });
        assert.ok(problems.some((p) => p.includes(expected)), `expected a problem mentioning ${expected}, got ${JSON.stringify(problems)}`);
    }
});

test('toShowcaseTask refuses a non-object row', () => {
    assert.throws(() => toShowcaseTask(null), TypeError);
});

test('publisher: no client configured leaves the row stale and calls nothing', async () => {
    const publisher = createShowcasePublisher();
    const result = await publisher.publishBounty(row());
    assert.equal(result.state, STATE.STALE);
    assert.equal(result.reason, 'not_configured');
});

test('publisher: a valid row is upserted once and reported published', async () => {
    const calls = [];
    const client = { upsertTask: async (task) => { calls.push(task); } };
    const publisher = createShowcasePublisher({ client, now: () => new Date('2026-11-11T00:00:00Z') });
    const result = await publisher.publishBounty(row());
    assert.equal(result.state, STATE.PUBLISHED);
    assert.equal(result.published_at, '2026-11-11T00:00:00.000Z');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pg_id, ID);
});

test('publisher: an invalid row never reaches the client', async () => {
    let called = false;
    const publisher = createShowcasePublisher({ client: { upsertTask: async () => { called = true; } } });
    const result = await publisher.publishBounty(row({ status: 'winner_chosen' }));
    assert.equal(result.state, STATE.STALE);
    assert.equal(result.reason, 'invalid_task');
    assert.equal(called, false);
});

test('publisher: a client failure is reported stale, with a short message', async () => {
    const client = { upsertTask: async () => { throw new Error('x'.repeat(500)); } };
    const publisher = createShowcasePublisher({ client });
    const result = await publisher.publishBounty(row());
    assert.equal(result.state, STATE.STALE);
    assert.equal(result.reason, 'publish_failed');
    assert.ok(result.problems[0].length <= 200);
});

test('publisher: a client without upsertTask is rejected at construction', () => {
    assert.throws(() => createShowcasePublisher({ client: {} }), TypeError);
});
