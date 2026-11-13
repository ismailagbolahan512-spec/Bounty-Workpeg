// scripts/phase2-test.js — Phase 2: dispute resolution, duplicate submission review,
// and budget recommendations. API checks, access control and concurrency.
//
// Usage:
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase2-test.js
// Exits with code 1 on the first failed check.

const fs = require('fs');
const { Pool } = require('pg');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) {
    console.error('Set LOG_FILE to the server log, so the test can read dev emails.');
    process.exit(1);
}
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });

let passed = 0;
function check(label, condition, detail) {
    if (!condition) {
        console.error(`✗ ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
        process.exit(1);
    }
    passed += 1;
    console.log(`✓ ${label}`);
}

async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}

function tokenFromLog(to, marker) {
    const blocks = fs.readFileSync(LOG_FILE, 'utf8').split('--- [dev email, not sent]').slice(1);
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].includes(`to: ${to}`) && blocks[i].includes(marker)) {
            const m = blocks[i].match(/token=([0-9a-f]{64})/);
            if (m) return m[1];
        }
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const stamp = Date.now();

// Accept the agreement that matches the role, so the tests use the same gate as real users.
const ACCEPT_FOR = { business: 'creator_protection_business', worker: 'worker_submission_ip' };
async function acceptFor(role, token) {
    const kind = ACCEPT_FOR[role];
    if (!kind || !token) return;
    const r = await api('POST', '/api/protection/agreements/accept', { kind }, token);
    if (r.status !== 200) throw new Error(`agreement accept failed for ${role}: ${JSON.stringify(r.body)}`);
}
async function signupVerified(email, role, name) {
    const out = await signupVerifiedBase(email, role, name);
    await acceptFor(role, out && (typeof out === 'string' ? out : out.token));
    return out;
}
async function signupVerifiedBase(email, role, name) {
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    if (r.status !== 201) throw new Error(`signup failed for ${email}: ${JSON.stringify(r.body)}`);
    await sleep(200);
    return r.body.token;
}

const uid = async(token) => (await api('GET', '/api/profile/me', null, token)).body.id;
const DISPUTE_TEXT = 'The submission was rejected without a reason, although it met the written acceptance criteria.';
const PLAN_TEXT = 'The first evidence is the message thread and the list of criteria, which both show the work was complete.';
const SAME_WORK = 'Implemented the requested checkout flow, wrote unit tests for each step, and documented the changes for review.';

(async() => {
    const biz = await signupVerified(`p2-biz+${stamp}@test.com`, 'business', 'Phase Two Biz');
    const other = await signupVerified(`p2-other+${stamp}@test.com`, 'business', 'Other Biz');
    const w1 = await signupVerified(`p2-w1+${stamp}@test.com`, 'worker', 'Worker One');
    const w2 = await signupVerified(`p2-w2+${stamp}@test.com`, 'worker', 'Worker Two');
    const outsider = await signupVerified(`p2-out+${stamp}@test.com`, 'worker', 'Outsider');
    const admin = await signupVerified(`p2-admin+${stamp}@test.com`, 'business', 'Platform Admin');
    const adminId = await uid(admin);
    await db.query('UPDATE users SET is_admin = true WHERE id = $1', [adminId]);
    const adminToken = (await api('POST', '/api/auth/signin', { email: `p2-admin+${stamp}@test.com`, password: 'password123' })).body.token;

    const project = await api('POST', '/api/projects', {
        title: 'Phase two project', description: 'A project for the phase two dispute checks.',
        tasks: [{ title: 'Checkout flow', description: 'Build the checkout flow for the shop.', category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz);
    check('a project with one task is created', project.status === 201, project.body);
    const taskId = project.body.task_ids[0];

    const s1 = await api('POST', '/api/submissions', { bounty_id: taskId, title: 'Checkout', description: SAME_WORK, github_link: 'https://github.com/example/checkout' }, w1);
    check('worker one submits', s1.status === 201, s1.body);
    const s2 = await api('POST', '/api/submissions', { bounty_id: taskId, title: 'Checkout', description: SAME_WORK, github_link: 'https://github.com/example/checkout' }, w2);
    check('worker two submits the same work', s2.status === 201, s2.body);

    // Budget recommendations
    const est = await api('POST', '/api/budget/estimate', { category: 'dev', difficulty: 'medium', description: 'Build a checkout flow with payment steps and tests.', criteria_count: 3, revision_rounds: 1, workers: 1, execution_mode: 'competitive', reward: 500 }, biz);
    check('the budget estimate is returned to a business', est.status === 200, est.body);
    check('the estimate has a complexity class, hours and a recommended range', est.body && est.body.complexity && est.body.estimated_hours.low <= est.body.estimated_hours.high && est.body.recommended_range, est.body);
    check('the estimate explains its factors', Array.isArray(est.body.factors) && est.body.factors.length > 0);
    check('the estimate says its rates are assumptions, not verified data', est.body.assumptions.some((x) => /not verified market rates/.test(x)));
    check('a reward far below the estimate gets a warning', (await api('POST', '/api/budget/estimate', { category: 'dev', difficulty: 'hard', description: 'Build a full marketplace with payments, admin tools, and tests across many modules.', criteria_count: 8, revision_rounds: 2, workers: 3, reward: 10 }, biz)).body.warnings.length > 0);
    check('a worker cannot request a budget estimate (403)', (await api('POST', '/api/budget/estimate', { category: 'dev' }, w1)).status === 403);
    check('an out-of-range reward is rejected (400)', (await api('POST', '/api/budget/estimate', { reward: -5 }, biz)).status === 400);

    // Disputes: validation and access
    const cats = await api('GET', '/api/disputes/categories', null, w1);
    check('the dispute categories are published for the form', cats.status === 200 && cats.body.length === 10 && cats.body[0].key && cats.body[0].label);
    check('a dispute needs a category from the list (400)', (await api('POST', '/api/disputes', { category: 'made_up', title: 'Unfair', description: DISPUTE_TEXT, bounty_id: taskId }, w1)).status === 400);
    check('a dispute must name a task or a milestone (400)', (await api('POST', '/api/disputes', { category: 'other', title: 'Unfair', description: DISPUTE_TEXT }, w1)).status === 400);
    check('an unrelated worker cannot raise a dispute on the task (403)', (await api('POST', '/api/disputes', { category: 'other', title: 'Unfair', description: DISPUTE_TEXT, bounty_id: taskId }, outsider)).status === 403);
    check('a business must name the submission it disputes (400)', (await api('POST', '/api/disputes', { category: 'unfair_rejection', title: 'Unfair', description: DISPUTE_TEXT, bounty_id: taskId }, biz)).status === 400);

    const opened = await api('POST', '/api/disputes', { category: 'unfair_rejection', title: 'Rejected without reason', description: DISPUTE_TEXT, bounty_id: taskId, submission_id: s1.body.id }, biz);
    check('the business raises a dispute about worker one\'s submission', opened.status === 201 && opened.body.status, opened.body);
    const disputeId = opened.body.id;
    check('a second open dispute on the same item is refused (409)', (await api('POST', '/api/disputes', { category: 'unfair_rejection', title: 'Again', description: DISPUTE_TEXT, bounty_id: taskId, submission_id: s1.body.id }, biz)).status === 409);

    const hold = await db.query("SELECT COUNT(*)::int AS n FROM dispute_events WHERE dispute_id = $1 AND event = 'opened'", [disputeId]);
    check('the dispute is recorded in its own audit trail', hold.rows[0].n === 1, hold.rows[0]);

    const mine = await api('GET', '/api/disputes/mine', null, w1);
    check('the respondent sees the dispute in their list', mine.status === 200 && JSON.stringify(mine.body).includes(disputeId), mine.body);
    const seen = await api('GET', `/api/disputes/${disputeId}`, null, w1);
    check('the respondent can read the dispute', seen.status === 200, seen.body);
    check('an outsider cannot read the dispute (403)', (await api('GET', `/api/disputes/${disputeId}`, null, outsider)).status === 403);
    check('another business cannot read the dispute (403)', (await api('GET', `/api/disputes/${disputeId}`, null, other)).status === 403);

    check('a response must have some substance (400)', (await api('POST', `/api/disputes/${disputeId}/messages`, { body: 'no' }, w1)).status === 400);
    const reply = await api('POST', `/api/disputes/${disputeId}/messages`, { body: PLAN_TEXT }, w1);
    check('the respondent replies to the dispute', reply.status < 300, reply.body);
    check('evidence must be https text or a link (400)', (await api('POST', `/api/disputes/${disputeId}/evidence`, { kind: 'link', body: 'http://insecure.example/ev' }, biz)).status === 400);
    const ev = await api('POST', `/api/disputes/${disputeId}/evidence`, { kind: 'text', body: 'Screenshot of the acceptance checklist, marked complete.' }, biz);
    check('the business adds text evidence', ev.status < 300, ev.body);
    const evLink = await api('POST', `/api/disputes/${disputeId}/evidence`, { kind: 'link', body: 'https://docs.example.com/checklist' }, biz);
    check('the business adds a link as evidence', evLink.status < 300, evLink.body);

    check('a non-admin cannot decide a dispute (403)', (await api('POST', `/api/disputes/${disputeId}/decide`, { outcome: 'upheld_raiser', decision: 'A decision explanation of sufficient length.' }, biz)).status === 403);
    check('the admin queue is closed to non-admins (403)', (await api('GET', '/api/disputes/admin/queue', null, biz)).status === 403);
    const queue = await api('GET', '/api/disputes/admin/queue', null, adminToken);
    check('the admin queue lists the dispute', queue.status === 200 && JSON.stringify(queue.body).includes(disputeId), queue.body);
    check('a decision must explain itself (400)', (await api('POST', `/api/disputes/${disputeId}/decide`, { outcome: 'upheld_raiser', decision: 'short' }, adminToken)).status === 400);

    // Simultaneous decisions: exactly one decision is recorded.
    const decisions = await Promise.all([1, 2].map(() => api('POST', `/api/disputes/${disputeId}/decide`, { outcome: 'upheld_raiser', decision: 'The evidence shows the criteria were met, so the rejection is overturned.', payment: 'release' }, adminToken)));
    const codes = decisions.map((r) => r.status).sort();
    check('two simultaneous decisions give exactly one success', JSON.stringify(codes) === JSON.stringify([200, 409]), codes);
    const recorded = await db.query("SELECT COUNT(*)::int AS n FROM dispute_events WHERE dispute_id = $1 AND event = 'decided'", [disputeId]);
    check('exactly one decision is recorded in the audit trail', recorded.rows[0].n === 1, recorded.rows[0]);
    check('a decided dispute accepts no new response (409 or closed)', (await api('POST', `/api/disputes/${disputeId}/messages`, { body: 'Late reply after the decision was made.' }, w1)).status >= 400);

    // Dispute history in reputation: the decision above was upheld against worker one.
    const w1Id = await uid(w1);
    const repAfter = await api('GET', `/api/reputation/${w1Id}`);
    const hist = repAfter.body.dispute_history || {};
    check('reputation records the upheld dispute against the worker', repAfter.status === 200 && hist.upheld_against >= 1 && hist.decided >= 1, repAfter.body);
    check('reputation shows the worker\'s open disputes separately', typeof hist.open === 'number', hist);
    const repBiz = await api('GET', `/api/reputation/${await uid(biz)}`);
    check('a business has no reputation record (404)', repBiz.status === 404);
    check('reputation keeps the dispute note in plain language', (repAfter.body.notes || []).some((n) => /respondent/.test(n)));

    // Duplicate submissions
    const dupList = await api('GET', `/api/duplicates/bounty/${taskId}`, null, biz);
    check('the owner sees the duplicate review for the task', dupList.status === 200, dupList.body);
    check('the duplicate review is closed to other businesses (403)', (await api('GET', `/api/duplicates/bounty/${taskId}`, null, other)).status === 403);
    const scan = await api('POST', `/api/duplicates/bounty/${taskId}/scan`, null, biz);
    check('the owner can rescan the task for overlaps', scan.status < 300, scan.body);
    const flags = await db.query('SELECT id, score FROM submission_overlaps WHERE bounty_id = $1', [taskId]);
    check('identical submissions are flagged for review', flags.rows.length >= 1 && Number(flags.rows[0].score) >= 0.5, flags.rows);
    const flagId = flags.rows[0].id;
    check('the flag is worded as a prompt for review, not a finding', !/misconduct|cheat|plagiari/i.test(JSON.stringify(scan.body)));
    check('an invalid duplicate decision is rejected (400)', (await api('PATCH', `/api/duplicates/${flagId}`, { decision: 'guilty' }, biz)).status === 400);
    check('a worker cannot record a duplicate decision (403)', (await api('PATCH', `/api/duplicates/${flagId}`, { decision: 'dismissed' }, w1)).status === 403);
    const decided = await api('PATCH', `/api/duplicates/${flagId}`, { decision: 'independent', note: 'Two separate workers built the same checkout flow independently.' }, biz);
    check('the owner records a decision on the flag', decided.status === 200, decided.body);
    const still = await db.query('SELECT COUNT(*)::int AS n FROM submission_overlaps WHERE id = $1', [flagId]);
    check('the flag is kept after a decision, never deleted', still.rows[0].n === 1);

    await db.end();
    console.log(`\nAll ${passed} phase 2 checks passed.`);
    process.exit(0);
})().catch(async(err) => {
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
});
