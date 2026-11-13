// scripts/workspace-test.js — task workspace messages and deadline proposals (API level).
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log node scripts/workspace-test.js
// The server must run WITHOUT RESEND_API_KEY so verification emails are written to the log.
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) { console.error('Set LOG_FILE to the server log.'); process.exit(1); }
let passed = 0;
function check(label, condition, detail) {
    if (!condition) { console.error(`✗ ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`); process.exit(1); }
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
        if (blocks[i].includes('to: ' + to) && blocks[i].includes(marker)) {
            const m = blocks[i].match(/token=([0-9a-f]{64})/);
            if (m) return m[1];
        }
    }
    return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

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
    await sleep(200);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    return { token: r.body.token, id: r.body.id };
}

(async() => {
    const stamp = Date.now();
    const biz = await signupVerified(`wsbiz+${stamp}@test.com`, 'business', 'Northline Goods');
    const w1 = await signupVerified(`wsw1+${stamp}@test.com`, 'worker', 'Alex Morgan');
    const w2 = await signupVerified(`wsw2+${stamp}@test.com`, 'worker', 'Other Worker');

    const b = await api('POST', '/api/bounties', { title: 'Workspace test task', description: 'Task used by the workspace test.', category: 'dev', difficulty: 'easy', reward_amount: 200, deadline: inDays(5), submission_type: 'github' }, biz.token);
    check('business posts a task (201)', b.status === 201, b.body);
    const bountyId = b.body.id;

    const noAuth = await api('GET', `/api/bounties/${bountyId}/messages`);
    check('workspace requires sign-in (401)', noAuth.status === 401, noAuth.body);

    const s1 = await api('POST', '/api/submissions', { bounty_id: bountyId, title: 'First attempt', description: 'Submitted by worker one. Tested and ready for review by the business.', github_link: 'https://github.com/example/ws' }, w1.token);
    check('worker one submits (201)', s1.status === 201, s1.body);

    const outsider = await api('GET', `/api/bounties/${bountyId}/messages`, null, w2.token);
    check('a worker without a submission cannot read the workspace (403)', outsider.status === 403, outsider.body);
    const outsiderPost = await api('POST', `/api/bounties/${bountyId}/messages`, { body: 'Can I join?' }, w2.token);
    check('a worker without a submission cannot post (403)', outsiderPost.status === 403, outsiderPost.body);

    const empty = await api('POST', `/api/bounties/${bountyId}/messages`, { body: '   ' }, biz.token);
    check('empty message is rejected (400)', empty.status === 400, empty.body);
    const tooLong = await api('POST', `/api/bounties/${bountyId}/messages`, { body: 'x'.repeat(2001) }, biz.token);
    check('message over 2000 characters is rejected (400)', tooLong.status === 400, tooLong.body);

    const m1 = await api('POST', `/api/bounties/${bountyId}/messages`, { body: 'Welcome. Use the test address in the brief.' }, biz.token);
    check('business posts a message (201)', m1.status === 201 && m1.body.from_business === true, m1.body);
    const m2 = await api('POST', `/api/bounties/${bountyId}/messages`, { body: 'Thanks, I will cover mobile and desktop.' }, w1.token);
    check('worker posts a message (201)', m2.status === 201 && m2.body.from_business === false, m2.body);

    const thread = await api('GET', `/api/bounties/${bountyId}/messages`, null, w1.token);
    check('worker sees the whole thread in order', thread.status === 200 && thread.body.length === 2 && thread.body[0].from_business === true && thread.body[1].from_business === false, thread.body);

    // Deadline proposals
    const pastProposal = await api('POST', `/api/submissions/${s1.body.id}/request-revision`, { notes: 'Please add the test steps.', proposed_deadline: inDays(-1) }, biz.token);
    check('a proposed deadline in the past is rejected (400)', pastProposal.status === 400, pastProposal.body);

    const proposed = inDays(9);
    const rev = await api('POST', `/api/submissions/${s1.body.id}/request-revision`, { notes: 'Please add the test steps.', proposed_deadline: proposed }, biz.token);
    check('business asks for changes with a proposed deadline (200)', rev.status === 200 && rev.body.proposed_deadline, rev.body);

    const wrongWorker = await api('POST', `/api/submissions/${s1.body.id}/accept-deadline`, null, w2.token);
    check('another worker cannot accept the proposal (403)', wrongWorker.status === 403, wrongWorker.body);

    const acc = await api('POST', `/api/submissions/${s1.body.id}/accept-deadline`, null, w1.token);
    check('worker accepts the proposal (200)', acc.status === 200 && acc.body.proposed_deadline === null, acc.body);
    const detail = await api('GET', `/api/bounties/${bountyId}`);
    check('task deadline moves to the accepted date', new Date(detail.body.deadline).getTime() === new Date(proposed).getTime(), detail.body.deadline);
    const accAgain = await api('POST', `/api/submissions/${s1.body.id}/accept-deadline`, null, w1.token);
    check('accepting again is rejected (409)', accAgain.status === 409, accAgain.body);

    // Decline path: the worker resubmits first, then the business asks again
    const resub = await api('POST', `/api/submissions/${s1.body.id}/resubmit`, { title: 'First attempt v2', description: 'Resubmitted with the requested steps.', github_link: 'https://github.com/example/work'  }, w1.token);
    check('worker resubmits after the change request (200)', resub.status === 200 && resub.body.status === 'pending', resub.body);
    const rev2 = await api('POST', `/api/submissions/${s1.body.id}/request-revision`, { notes: 'Need a shorter summary.', proposed_deadline: inDays(12) }, biz.token);
    check('second change request with a proposal (200)', rev2.status === 200, rev2.body);
    const dec = await api('POST', `/api/submissions/${s1.body.id}/decline-deadline`, null, w1.token);
    check('worker declines the proposal and the deadline stays (200)', dec.status === 200 && dec.body.proposed_deadline === null, dec.body);
    const detail2 = await api('GET', `/api/bounties/${bountyId}`);
    check('declined proposal leaves the deadline unchanged', new Date(detail2.body.deadline).getTime() === new Date(proposed).getTime(), detail2.body.deadline);
    const decAgain = await api('POST', `/api/submissions/${s1.body.id}/decline-deadline`, null, w1.token);
    check('declining again is rejected (409)', decAgain.status === 409, decAgain.body);

    console.log(`\nAll ${passed} workspace checks passed.`);
    process.exit(0);
})().catch((e) => { console.error('Unexpected error:', e); process.exit(1); });
