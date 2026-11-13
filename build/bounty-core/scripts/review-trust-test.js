// scripts/review-trust-test.js — submission format rules, rejection reasons, funding flag and checklists.
//
// Usage:
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log node scripts/review-trust-test.js
// Exits with code 1 on the first failed check.

const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) {
    console.error('Set LOG_FILE to the server log, so the test can read dev emails.');
    process.exit(1);
}

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
    const data = await res.json().catch(() => null);
    return { status: res.status, body: data };
}

function tokenFromLog(to, marker) {
    const log = fs.readFileSync(LOG_FILE, 'utf8');
    const blocks = log.split('--- [dev email, not sent]').slice(1);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.includes(`to: ${to}`) && block.includes(marker)) {
            const m = block.match(/token=([0-9a-f]{64})/);
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

function bountyBody(extra = {}) {
    return {
        title: 'Review trust bounty', description: 'A bounty used by the review and trust checks.',
        category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github',
        ...extra,
    };
}

const GOOD_DESCRIPTION = 'Implemented the change as agreed and tested it locally before sending.';

(async () => {
    const biz = await signupVerified(`rt-biz-${stamp}@example.com`, 'business', 'Trust Biz');
    const worker = await signupVerified(`rt-worker-${stamp}@example.com`, 'worker', 'Trust Worker');

    // --- bounty creation: checklist and funding flag
    const tooMany = Array.from({ length: 11 }, (_, i) => `Item ${i + 1} done`);
    const overChecklist = await api('POST', '/api/bounties', bountyBody({ completion_checklist: tooMany }), biz);
    check('a checklist with more than 10 items is rejected (400)', overChecklist.status === 400, overChecklist.body);

    const shortItem = await api('POST', '/api/bounties', bountyBody({ completion_checklist: ['ok'] }), biz);
    check('a checklist item shorter than 3 characters is rejected (400)', shortItem.status === 400, shortItem.body);

    const checklist = ['Tests pass locally', 'README updated'];
    const made = await api('POST', '/api/bounties', bountyBody({ title: 'Checklist bounty', completion_checklist: checklist, funding_status: 'funded' }), biz);
    check('bounty with a checklist is created (201)', made.status === 201, made.body);
    check('client-sent funding_status is ignored (stays unfunded)', made.body.funding_status === 'unfunded', made.body);
    check('the checklist is returned on create', JSON.stringify(made.body.completion_checklist) === JSON.stringify(checklist), made.body);

    const detail = await api('GET', `/api/bounties/${made.body.id}`, null, worker);
    check('bounty detail carries the checklist for workers', detail.status === 200 && JSON.stringify(detail.body.completion_checklist) === JSON.stringify(checklist), detail.body);
    check('bounty detail carries the funding flag', detail.body.funding_status === 'unfunded', detail.body);

    const plain = await api('POST', '/api/bounties', bountyBody({ title: 'No checklist bounty' }), biz);
    check('bounty without a checklist stores an empty list', plain.status === 201 && Array.isArray(plain.body.completion_checklist) && plain.body.completion_checklist.length === 0, plain.body);

    // --- submission format
    const shortDesc = await api('POST', '/api/submissions', { bounty_id: made.body.id, title: 'Too short', description: 'Too short.', github_link: 'https://github.com/example/work' }, worker);
    check('a description under 30 characters is rejected (400)', shortDesc.status === 400, shortDesc.body);

    const noLink = await api('POST', '/api/submissions', { bounty_id: made.body.id, title: 'No link', description: GOOD_DESCRIPTION }, worker);
    check('a github bounty without a link is rejected (400)', noLink.status === 400, noLink.body);

    const badLink = await api('POST', '/api/submissions', { bounty_id: made.body.id, title: 'Bad link', description: GOOD_DESCRIPTION, github_link: 'ftp://example.com/file' }, worker);
    check('a non-http link is rejected (400)', badLink.status === 400, badLink.body);

    const textBounty = await api('POST', '/api/bounties', bountyBody({ title: 'Text bounty', submission_type: 'text' }), biz);
    const textSub = await api('POST', '/api/submissions', { bounty_id: textBounty.body.id, title: 'Written answer', description: GOOD_DESCRIPTION }, worker);
    check('a text bounty accepts a submission without a link (201)', textSub.status === 201, textSub.body);

    const sub = await api('POST', '/api/submissions', { bounty_id: made.body.id, title: 'Checklist work', description: GOOD_DESCRIPTION, github_link: 'https://github.com/example/work' }, worker);
    check('a complete submission is accepted (201, pending)', sub.status === 201 && sub.body.status === 'pending', sub.body);

    // --- rejection reasons
    const noReason = await api('POST', `/api/submissions/${sub.body.id}/reject`, {}, biz);
    check('rejecting without a reason is refused (400)', noReason.status === 400, noReason.body);

    const shortReason = await api('POST', `/api/submissions/${sub.body.id}/reject`, { reason: 'no' }, biz);
    check('a reason under 10 characters is refused (400)', shortReason.status === 400, shortReason.body);

    const reason = 'The README step is missing from the link.';
    const rejected = await api('POST', `/api/submissions/${sub.body.id}/reject`, { reason }, biz);
    check('owner rejects with a reason (200)', rejected.status === 200, rejected.body);

    const mine = await api('GET', '/api/submissions/mine', null, worker);
    const row = (mine.body || []).find((s) => s.id === sub.body.id);
    check('worker sees the rejection status', row && row.status === 'rejected', mine.body);
    check('worker sees the rejection reason', row && row.rejection_reason === reason, row);

    // --- a second, unrelated submission still reads back cleanly
    const textRow = (mine.body || []).find((s) => s.id === textSub.body.id);
    check('worker list keeps other submissions intact', textRow && textRow.status === 'pending', mine.body);

    console.log(`\nAll ${passed} checks passed.`);
    process.exit(0);
})().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
