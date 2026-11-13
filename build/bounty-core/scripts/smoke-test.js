// scripts/smoke-test.js — end-to-end check of the main flows against a running server.
//
// Usage (server must be running with DATABASE_URL set and NO RESEND_API_KEY,
// so emails are printed to the server log):
//   BASE=http://localhost:3100 LOG_FILE=/path/to/server.log node scripts/smoke-test.js
//
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

// Finds the last dev email sent to `to` whose text contains `marker`, and returns its token.
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

(async() => {
    const stamp = Date.now();
    const bizEmail = `biz+${stamp}@test.com`;
    const workerEmail = `worker+${stamp}@test.com`;
    const otherEmail = `other+${stamp}@test.com`;
    const PASS = 'password123';
    const NEW_PASS = 'newpassword456';

    // --- signup and verification gating
    const biz = await api('POST', '/api/auth/signup', { email: bizEmail, password: PASS, name: 'Test Biz', role: 'business' });
    check('business signup returns 201 and unverified', biz.status === 201 && biz.body.email_verified === false, biz.body);
    const worker = await api('POST', '/api/auth/signup', { email: workerEmail, password: PASS, name: 'Test Worker', role: 'worker' });
    check('worker signup returns 201', worker.status === 201, worker.body);
    const other = await api('POST', '/api/auth/signup', { email: otherEmail, password: PASS, name: 'Other Person', role: 'worker' });
    check('third account signup returns 201', other.status === 201, other.body);
    await sleep(300);

    const bounty0 = await api('POST', '/api/bounties', {
        title: 'Unverified test bounty', description: 'This should be blocked until email is verified.',
        category: 'dev', difficulty: 'easy', reward_amount: 100,
        deadline: new Date(Date.now() + 86400000).toISOString(), submission_type: 'github',
    }, biz.body.token);
    check('unverified business cannot post a bounty (403)', bounty0.status === 403, bounty0.body);

    const bizVerifyToken = tokenFromLog(bizEmail, 'verify?token=');
    check('verification email was logged for business', !!bizVerifyToken);
    const v1 = await api('POST', '/api/auth/verify', { token: bizVerifyToken });
    check('business verifies email (200)', v1.status === 200, v1.body);
    const v2 = await api('POST', '/api/auth/verify', { token: bizVerifyToken });
    await acceptFor(biz.body && biz.body.role, biz.body && biz.body.token);
    check('verification link cannot be reused (400)', v2.status === 400, v2.body);

    const workerVerifyToken = tokenFromLog(workerEmail, 'verify?token=');
    const wv = await api('POST', '/api/auth/verify', { token: workerVerifyToken });
    await acceptFor(worker.body && worker.body.role, worker.body && worker.body.token);
    check('worker verifies email (200)', wv.status === 200, wv.body);

    // --- bounty, submission, approval
    const bounty = await api('POST', '/api/bounties', {
        title: 'Smoke test bounty', description: 'A bounty created by the smoke test script.',
        category: 'dev', difficulty: 'easy', reward_amount: 100,
        deadline: new Date(Date.now() + 86400000).toISOString(), submission_type: 'github',
    }, biz.body.token);
    check('verified business posts a bounty (201)', bounty.status === 201, bounty.body);
    const bountyId = bounty.body.id;

    const sub0 = await api('POST', '/api/submissions', {
        bounty_id: bountyId, title: 'First attempt', description: 'Work for the smoke test.',
    }, other.body.token);
    check('unverified worker cannot submit (403)', sub0.status === 403, sub0.body);

    const sub = await api('POST', '/api/submissions', {
        bounty_id: bountyId, title: 'My fix', description: 'Here is the completed work, with the page built and tested.', github_link: 'https://github.com/example/fix',
    }, worker.body.token);
    check('verified worker submits (201)', sub.status === 201, sub.body);

    const approve = await api('POST', `/api/submissions/${sub.body.id}/approve`, null, biz.body.token);
    check('business approves the submission (200)', approve.status === 200, approve.body);

    // --- reviews
    const bizReview = await api('POST', '/api/reviews', { bounty_id: bountyId, rating: 5, comment: 'Great work' }, biz.body.token);
    check('business reviews the winner (201)', bizReview.status === 201, bizReview.body);
    const dupReview = await api('POST', '/api/reviews', { bounty_id: bountyId, rating: 1 }, biz.body.token);
    check('duplicate review is rejected (409)', dupReview.status === 409, dupReview.body);
    const workerReview = await api('POST', '/api/reviews', { bounty_id: bountyId, rating: 4, comment: 'Fair' }, worker.body.token);
    check('winner reviews the business (201)', workerReview.status === 201, workerReview.body);
    const badRating = await api('POST', '/api/reviews', { bounty_id: bountyId, rating: 9 }, worker.body.token);
    check('rating outside 1-5 is rejected (400)', badRating.status === 400, badRating.body);
    const stranger = await api('POST', '/api/reviews', { bounty_id: bountyId, rating: 3 }, other.body.token);
    check('uninvolved user cannot review (403)', stranger.status === 403, stranger.body);

    const summary = await api('GET', `/api/reviews/user/${worker.body.id}`);
    check('worker review summary shows 1 review, average 5.0 from business', summary.status === 200 && summary.body.count === 1 && Number(summary.body.average) === 5, summary.body);

    // --- reports
    const report = await api('POST', '/api/reports', { bounty_id: bountyId, reason: 'other', details: 'Test report' }, worker.body.token);
    check('participant can report a bounty (201)', report.status === 201, report.body);
    const dupReport = await api('POST', '/api/reports', { bounty_id: bountyId, reason: 'other' }, worker.body.token);
    check('duplicate report is rejected (409)', dupReport.status === 409, dupReport.body);
    const strangerReport = await api('POST', '/api/reports', { bounty_id: bountyId, reason: 'spam' }, other.body.token);
    check('uninvolved user cannot report (403)', strangerReport.status === 403, strangerReport.body);
    const badReason = await api('POST', '/api/reports', { bounty_id: bountyId, reason: 'nonsense' }, worker.body.token);
    check('unknown report reason is rejected (400)', badReason.status === 400, badReason.body);

    // --- password reset
    const forgotKnown = await api('POST', '/api/auth/forgot', { email: workerEmail });
    const forgotUnknown = await api('POST', '/api/auth/forgot', { email: `nobody+${stamp}@test.com` });
    check('forgot password gives the same answer for known and unknown emails',
        forgotKnown.status === 200 && forgotUnknown.status === 200 && forgotKnown.body.message === forgotUnknown.body.message,
        { known: forgotKnown.body, unknown: forgotUnknown.body });

    await sleep(300);
    const resetToken = tokenFromLog(workerEmail, 'reset?token=');
    check('reset email was logged for the worker', !!resetToken);

    await sleep(1100); // make sure the password change is in a later second than the old token
    const reset = await api('POST', '/api/auth/reset', { token: resetToken, password: NEW_PASS });
    check('password reset with valid link (200)', reset.status === 200, reset.body);
    const resetAgain = await api('POST', '/api/auth/reset', { token: resetToken, password: 'anotherpass789' });
    check('reset link cannot be reused (400)', resetAgain.status === 400, resetAgain.body);

    const oldSession = await api('GET', '/api/profile/me', null, worker.body.token);
    check('old login token is revoked after password change (401)', oldSession.status === 401, oldSession.body);

    const oldPassword = await api('POST', '/api/auth/signin', { email: workerEmail, password: PASS });

    await acceptFor(oldPassword.body && oldPassword.body.role, oldPassword.body && oldPassword.body.token);
    check('old password no longer works (401)', oldPassword.status === 401, oldPassword.body);
    const newSignin = await api('POST', '/api/auth/signin', { email: workerEmail, password: NEW_PASS });
    await acceptFor(newSignin.body && newSignin.body.role, newSignin.body && newSignin.body.token);
    check('new password works (200)', newSignin.status === 200, newSignin.body);

    // --- profile shows verification state
    const me = await api('GET', '/api/profile/me', null, newSignin.body.token);
    check('profile reports email_verified true for verified worker', me.status === 200 && me.body.email_verified === true, me.body);

    // --- admin: reports queue, resolve, notify reporter
    const adminEmail = `admin+${stamp}@test.com`;
    const adminSignup = await api('POST', '/api/auth/signup', { email: adminEmail, password: PASS, name: 'Test Admin', role: 'worker' });
    await sleep(300);
    const adminVerify = await api('POST', '/api/auth/verify', { token: tokenFromLog(adminEmail, 'verify?token=') });
    await acceptFor(adminSignup.body && adminSignup.body.role, adminSignup.body && adminSignup.body.token);
    check('admin account verifies', adminVerify.status === 200, adminVerify.body);
    const { pool } = require('../db');
    await pool.query('UPDATE users SET is_admin = TRUE WHERE email = $1', [adminEmail]);
    const adminLogin = await api('POST', '/api/auth/signin', { email: adminEmail, password: PASS });
    await acceptFor(adminLogin.body && adminLogin.body.role, adminLogin.body && adminLogin.body.token);
    check('sign-in response includes is_admin true', adminLogin.body.is_admin === true, adminLogin.body);
    const adminMe = await api('GET', '/api/profile/me', null, adminLogin.body.token);
    check('profile shows is_admin true', adminMe.body.is_admin === true, adminMe.body);

    const notAdmin = await api('GET', '/api/admin/reports', null, newSignin.body.token);
    check('non-admin cannot open the reports queue (403)', notAdmin.status === 403, notAdmin.body);
    const queue = await api('GET', '/api/admin/reports?status=open', null, adminLogin.body.token);
    check('admin sees the open report in the queue', queue.status === 200 && queue.body.some((r) => r.id === report.body.id), queue.body);
    const badFilter = await api('GET', '/api/admin/reports?status=bogus', null, adminLogin.body.token);
    check('unknown queue filter is rejected (400)', badFilter.status === 400, badFilter.body);

    const resolve = await api('PATCH', `/api/admin/reports/${report.body.id}`, { status: 'resolved', admin_note: 'Checked the bounty. Closed.' }, adminLogin.body.token);
    check('admin resolves the report with a note (200)', resolve.status === 200 && resolve.body.status === 'resolved', resolve.body);
    const resolveAgain = await api('PATCH', `/api/admin/reports/${report.body.id}`, { status: 'dismissed' }, adminLogin.body.token);
    check('a closed report cannot be decided again (409)', resolveAgain.status === 409, resolveAgain.body);
    const badDecision = await api('PATCH', `/api/admin/reports/${dupReport.body.id || report.body.id}`, { status: 'open' }, adminLogin.body.token);
    check('decision must be resolved or dismissed (400)', badDecision.status === 400, badDecision.body);

    const closed = await api('GET', '/api/admin/reports?status=resolved', null, adminLogin.body.token);
    check('resolved report appears under resolved', closed.body.some((r) => r.id === report.body.id && r.admin_note === 'Checked the bounty. Closed.'), closed.body);

    const workerNotes = await api('GET', '/api/notifications', null, newSignin.body.token);
    check('reporter gets an in-app notification', workerNotes.body.some((n) => /was resolved/.test(n.message)), workerNotes.body);
    await sleep(200);
    const emailed = fs.readFileSync(LOG_FILE, 'utf8');
    check('reporter gets a notification email', emailed.includes(`to: ${workerEmail}`) && emailed.includes('was resolved'));

    await pool.end();

    console.log(`\nAll ${passed} checks passed.`);
})().catch((err) => {
    console.error('✗ Test crashed:', err);
    process.exit(1);
});

// Accepts the agreement matching the account's role after signup or signin, as real users must.
async function acceptFor(role, token) {
    const kind = { business: 'creator_protection_business', worker: 'worker_submission_ip' }[role];
    if (!kind || !token) return;
    const r = await api('POST', '/api/protection/agreements/accept', { kind }, token);
    // Unverified accounts are refused here by design; ignore so those tests can check the refusal.
    void r;
}
