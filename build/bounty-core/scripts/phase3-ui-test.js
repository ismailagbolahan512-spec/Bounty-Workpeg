// scripts/phase3-ui-test.js — browser checks for the Phase 3 screens: availability on the profile,
// skill checks (worker start and submit, reviewer decision), recommended tasks, matching candidates
// on a task, the team workspace board (claim, deliver, accept), and access for people not on the task.
//
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase3-ui-test.js
// Needs Playwright (NODE_PATH). Run against a server without RESEND_API_KEY.
const { chromium } = require('playwright');
const fs = require('fs');
const { Pool } = require('pg');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
if (!LOG) {
    console.error('Set LOG_FILE to the server log.');
    process.exit(1);
}
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
const stamp = Date.now();
let failed = 0;
const errors = [];
function ok(label, cond, extra) {
    console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const WORK = 'I built the checkout flow, wrote unit tests for each payment step, and documented the failure handling.';

async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}
function tokenFromLog(to, marker) {
    const blocks = fs.readFileSync(LOG, 'utf8').split('--- [dev email, not sent]').slice(1);
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].includes('to: ' + to) && blocks[i].includes(marker)) {
            const m = blocks[i].match(/token=([0-9a-f]{64})/);
            if (m) return m[1];
        }
    }
    return null;
}
async function verifiedUser(email, role, name) {
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    await acceptFor(r.body && r.body.role, r.body && r.body.token);
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
    await sleep(200);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    const s = await api('POST', '/api/auth/signin', { email, password: 'password123' });
    await acceptFor(s.body && s.body.role, s.body && s.body.token);
    return { token: s.body.token, id: s.body.id, user: { id: s.body.id, email, name, role, email_verified: true } };
}

(async() => {
    const browser = await chromium.launch();
    const biz = await verifiedUser(`p3ui-biz+${stamp}@test.com`, 'business', 'Phase Three UI Biz');
    const w = await verifiedUser(`p3ui-w+${stamp}@test.com`, 'worker', 'Phase Three UI Worker');
    const out = await verifiedUser(`p3ui-out+${stamp}@test.com`, 'worker', 'Phase Three UI Outsider');
    const adm = await verifiedUser(`p3ui-adm+${stamp}@test.com`, 'business', 'Phase Three UI Admin');
    await db.query('UPDATE users SET is_admin = true WHERE id = $1', [adm.id]);
    await db.query('UPDATE users SET onboarding_done = true WHERE id = ANY($1::uuid[])', [[biz.id, w.id, out.id, adm.id]]);
    adm.user.is_admin = true;

    const project = await api('POST', '/api/projects', {
        title: 'Phase three UI project', description: 'A project used by the phase three browser checks.',
        tasks: [{ title: 'Checkout team task', description: 'Build the checkout flow for the shop with tests and notes.', category: 'dev', difficulty: 'easy', reward_amount: 500, deadline: inDays(9), submission_type: 'github', acceptance_criteria: [] }],
    }, biz.token);
    const taskId = project.body.task_ids[0];
    await db.query(`INSERT INTO bounty_participants (bounty_id, worker_id, status) VALUES ($1, $2, 'active')`, [taskId, w.id]);

    const created = await api('POST', '/api/assessments', {
        category: 'dev', difficulty: 'easy', title: 'Checkout skill check',
        description: 'A short practical check of checkout code and its tests for review.',
        instructions: 'Build the checkout function and write tests for each payment step as described.',
        submission_requirements: 'A link to the repository and a short written note.',
        rubric: [{ text: 'Explains the approach in clear steps', points: 40 }, { text: 'Includes tests that pass on the submitted code', points: 50 }],
    }, adm.token);
    ok('setup: an assessment exists for the browser checks', created.status === 201, created.body);

    const browserPage = async(session) => {
        const ctx = await browser.newContext();
        await ctx.addCookies([{ name: 'bounty_session', value: session.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: session.user });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('dialog', (d) => d.accept());
        return page;
    };

    // ---------------------------------------------------------------- worker: availability
    const wp = await browserPage(w);
    await wp.goto(BASE + '/#/profile');
    await wp.waitForSelector('#av-zone', { timeout: 10000 }).catch(() => null);
    ok('the worker profile shows the availability card', await wp.isVisible('#availability-card'));
    await wp.selectOption('#av-zone', 'Europe/London');
    await wp.fill('#av-langs', 'English, Yoruba');
    await wp.fill('#av-hours', '25');
    await wp.check('#av-discoverable');
    await wp.click('#av-save');
    await wp.waitForSelector('text=Availability saved', { timeout: 8000 }).catch(() => null);
    const me = await api('GET', '/api/profile/me', null, w.token);
    ok('availability is saved and the opt-in is recorded', me.body.timezone === 'Europe/London' && me.body.discoverable === true && me.body.weekly_hours === 25, me.body);

    await wp.fill('#av-hours', '90');
    await wp.click('#av-save');
    await wp.waitForSelector('#availability-error:not([hidden])', { timeout: 8000 }).catch(() => null);
    ok('an out-of-range number of hours shows an error', await wp.isVisible('#availability-error'));
    await wp.fill('#av-hours', '25');

    // ---------------------------------------------------------------- worker: skill check
    await wp.goto(BASE + '/#/assessments');
    await wp.waitForSelector('[data-start]', { timeout: 10000 }).catch(() => null);
    ok('the worker sees the skill check to start', await wp.isVisible('[data-start]'));
    await wp.click('[data-start]');
    await wp.waitForSelector('.assessment-submit textarea', { timeout: 8000 }).catch(() => null);
    ok('starting a check opens the submission form', await wp.isVisible('.assessment-submit textarea'));
    await wp.fill('.assessment-submit textarea', WORK);
    await wp.fill('.assessment-submit input[type=url]', 'https://github.com/example/checkout');
    await wp.click('.assessment-submit button[type=submit]');
    await wp.waitForSelector('text=Awaiting review', { timeout: 8000 }).catch(() => null);
    ok('the submitted check shows as awaiting review', await wp.isVisible('text=Awaiting review'));

    // ---------------------------------------------------------------- reviewer: decision
    const ap = await browserPage(adm);
    await ap.goto(BASE + '/#/admin/assessments');
    await ap.waitForSelector('.review-card', { timeout: 10000 }).catch(() => null);
    ok('the reviewer sees the submission in the queue', await ap.isVisible('.review-card'));
    ok('the pre-check is labelled advisory', /Advisory pre-check/.test(await ap.textContent('.review-card')));
    const card = ap.locator('.review-card').first();
    await card.locator('input[type=radio][value=verified]').check();
    await card.locator('input[type=number]').fill('85');
    await card.locator('textarea').fill('Clear approach and tests that pass on the submitted code.');
    await card.locator('button[type=submit]').click();
    await ap.waitForSelector('text=Decision recorded', { timeout: 8000 }).catch(() => null);
    ok('the decision is recorded and the card leaves the queue', (await ap.locator('.review-card').count()) === 0);

    await wp.goto(BASE + '/#/assessments');
    await wp.waitForSelector('text=Verified', { timeout: 8000 }).catch(() => null);
    ok('the worker sees the check as verified', await wp.isVisible('text=Verified'));

    // ---------------------------------------------------------------- recommended tasks
    await wp.goto(BASE + '/#/recommended');
    await wp.waitForSelector('text=Recommended tasks', { timeout: 10000 }).catch(() => null);
    ok('the worker has a recommended tasks page', await wp.isVisible('h1:has-text("Recommended tasks")'));

    // ---------------------------------------------------------------- business: matching and the board
    const bp = await browserPage(biz);
    await bp.goto(BASE + '/#/bounties/' + taskId);
    await bp.waitForSelector('#matching h2', { timeout: 10000 }).catch(() => null);
    ok('the business sees matching candidates on the task', await bp.isVisible('#matching h2:has-text("Matching candidates")'));
    await bp.waitForSelector('#deliverables h2', { timeout: 10000 }).catch(() => null);
    ok('the business sees the deliverables board', await bp.isVisible('#deliverables h2:has-text("Deliverables")'));
    await bp.fill('#dv-title', 'Build the payment steps');
    await bp.fill('#dv-description', 'Each payment step with its tests.');
    await bp.click('#deliverable-form button[type=submit]');
    await bp.waitForSelector('text=Build the payment steps', { timeout: 8000 }).catch(() => null);
    ok('the business adds a deliverable', await bp.isVisible('text=Build the payment steps'));

    // ---------------------------------------------------------------- worker: claim, deliver
    await wp.goto(BASE + '/#/bounties/' + taskId);
    await wp.waitForSelector('[data-action=start]', { timeout: 10000 }).catch(() => null);
    ok('a participant sees the claim action on the board', await wp.isVisible('[data-action=start]'));
    await wp.click('[data-action=start]');
    await wp.waitForSelector('#deliverables .check-pill:has-text("In progress")', { timeout: 8000 }).catch(() => null);
    ok('the claimed deliverable shows as in progress', await wp.isVisible('#deliverables .check-pill:has-text("In progress")'));
    await wp.click('[data-action=deliver]');
    await wp.fill('.action-form input[name=link]', 'https://github.com/example/payments');
    await wp.click('.action-form button[type=submit]');
    await wp.waitForSelector('text=Delivered for review', { timeout: 8000 }).catch(() => null);
    ok('the worker delivers the work for review', await wp.isVisible('text=Delivered for review'));

    // ---------------------------------------------------------------- business: accept, timeline
    await bp.goto(BASE + '/#/dashboard');
    await bp.goto(BASE + '/#/bounties/' + taskId);
    await bp.waitForSelector('[data-action=accept]', { timeout: 10000 }).catch(() => null);
    await bp.click('[data-action=accept]');
    await bp.waitForSelector('#deliverables .check-pill:has-text("Accepted")', { timeout: 8000 }).catch(() => null);
    ok('the business accepts the delivered work', await bp.isVisible('#deliverables .check-pill:has-text("Accepted")'));
    await bp.click('#deliverables details summary');
    await bp.waitForSelector('#deliverables .timeline li', { timeout: 8000 }).catch(() => null);
    ok('the timeline shows the changes', (await bp.locator('#deliverables .timeline li').count()) >= 2);

    // ---------------------------------------------------------------- outsider: no board
    const op = await browserPage(out);
    await op.goto(BASE + '/#/bounties/' + taskId);
    await op.waitForSelector('h1', { timeout: 10000 }).catch(() => null);
    await sleep(800);
    ok('a worker not on the task does not see the board', (await op.locator('#deliverables').count()) === 0);
    ok('a worker not on the task does not see matching candidates', (await op.locator('#matching').count()) === 0);

    ok('no unexpected page errors were thrown', errors.length === 0, errors.slice(0, 3).join(' | '));

    await browser.close();
    await db.end();
    console.log(`\n${failed === 0 ? 'Phase 3 UI checks passed' : failed + ' Phase 3 UI check(s) failed'}`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(async(err) => {
    console.error('Crashed:', err.message);
    await db.end().catch(() => {});
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
