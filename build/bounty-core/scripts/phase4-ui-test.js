// scripts/phase4-ui-test.js — browser checks for Phase 4: the business talent pool (create a list,
// save a worker, private note, invitation), the worker invitations page with consent, the
// opportunities page with honest regional information, and task visibility by region.
//
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase4-ui-test.js
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
const PITCH = 'We have a checkout task that matches your payment work. Would you like to take a look?';

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
    const biz = await verifiedUser(`p4ui-biz+${stamp}@test.com`, 'business', 'Phase Four UI Biz');
    const w = await verifiedUser(`p4ui-w+${stamp}@test.com`, 'worker', 'Phase Four UI Worker');
    const other = await verifiedUser(`p4ui-other+${stamp}@test.com`, 'worker', 'Phase Four UI Outsider');
    await db.query('UPDATE users SET onboarding_done = true WHERE id = ANY($1::uuid[])', [[biz.id, w.id, other.id]]);
    await db.query(`UPDATE users SET discoverable = true, country = 'NG', categories = ARRAY['dev'] WHERE id = $1`, [w.id]);
    await db.query(`UPDATE users SET country = 'US' WHERE id = $1`, [other.id]);

    const project = await api('POST', '/api/projects', {
        title: 'Phase four UI project', description: 'A project used by the phase four browser checks.',
        tasks: [{ title: 'Phase four UI task', description: 'Build the checkout flow for the shop with tests and notes.', category: 'dev', difficulty: 'easy', reward_amount: 500, deadline: inDays(9), submission_type: 'github', acceptance_criteria: [] }],
    }, biz.token);
    const taskId = project.body.task_ids[0];

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

    // ---------------------------------------------------------------- business: talent pool
    const bp = await browserPage(biz);
    await bp.goto(BASE + '/#/talent');
    await bp.waitForSelector('#list-create', { timeout: 10000 }).catch(() => null);
    ok('the business has a talent pool page', await bp.isVisible('h1:has-text("Talent pool")'));
    await bp.fill('#list-name', 'Checkout specialists');
    await bp.click('#list-create button[type=submit]');
    await bp.waitForSelector('text=Checkout specialists', { timeout: 8000 }).catch(() => null);
    ok('the business creates a list', await bp.isVisible('a:has-text("Checkout specialists")'));

    // Save the worker from their profile, add a private note, and send an invitation
    await bp.goto(BASE + '/#/worker/' + w.id);
    await bp.waitForSelector('#talent-actions', { timeout: 10000 }).catch(() => null);
    ok('the business sees its talent actions on a worker profile', await bp.isVisible('#talent-actions h2:has-text("Your talent pool")'));
    await bp.click('#save-form button[type=submit]');
    await bp.waitForSelector('text=Saved to your list', { timeout: 8000 }).catch(() => null);
    ok('the business saves a discoverable worker to a list', await bp.isVisible('text=Saved to your list'));
    await bp.fill('#note-body', 'Reliable on payment work and quick to respond in review.');
    await bp.click('#note-form button[type=submit]');
    await bp.waitForSelector('text=Reliable on payment work', { timeout: 8000 }).catch(() => null);
    ok('the business adds a private note', await bp.isVisible('text=Reliable on payment work'));
    await bp.fill('#ti-message', PITCH);
    await bp.click('#talent-invite button[type=submit]');
    await bp.waitForSelector('text=Invitation sent', { timeout: 8000 }).catch(() => null);
    ok('the business sends an invitation', await bp.isVisible('text=Invitation sent'));

    // ---------------------------------------------------------------- worker: invitation and consent
    const wp = await browserPage(w);
    await wp.goto(BASE + '/#/invitations');
    await wp.waitForSelector('[data-respond=accept]', { timeout: 10000 }).catch(() => null);
    ok('the worker sees the invitation with its message', await wp.isVisible('text=' + PITCH.slice(0, 30)));
    await wp.click('[data-respond=accept]');
    await wp.waitForSelector('text=does not assign', { timeout: 8000 }).catch(() => null);
    ok('accepting explains that no work or payment is assigned', await wp.isVisible('text=does not assign'));

    // ---------------------------------------------------------------- worker: opportunities
    await wp.goto(BASE + '/#/opportunities');
    await wp.waitForSelector('h1:has-text("Opportunities")', { timeout: 10000 }).catch(() => null);
    ok('the worker sees their region', /Nigeria/.test(await wp.textContent('section.detail-section')));
    const currencyText = await wp.textContent('section:has(h2:text-is("Currencies"))');
    ok('the currency section lists the naira as the supported currency', /Nigerian naira/.test(currencyText) && /NGN/.test(currencyText) && /not supported yet/.test(currencyText));
    ok('the payout status is shown as not confirmed', /Payout methods for this region are not confirmed yet/.test(await wp.textContent('body')));

    // ---------------------------------------------------------------- business: task visibility
    await bp.goto(BASE + '/#/dashboard');
    await bp.goto(BASE + '/#/bounties/' + taskId);
    await bp.waitForSelector('#access input[type=checkbox]', { timeout: 10000 }).catch(() => null);
    ok('the business sees the visibility control on its task', await bp.isVisible('#access h2:has-text("Who can see this task")'));
    await bp.check('#access input[value=NG]');
    await bp.click('#region-save');
    await bp.waitForSelector('text=Visibility saved', { timeout: 8000 }).catch(() => null);
    ok('the business limits the task to Nigeria', await bp.isVisible('text=Currently: NG'));

    const op = await browserPage(other);
    await op.goto(BASE + '/#/bounties/' + taskId);
    await op.waitForSelector('h1', { timeout: 10000 }).catch(() => null);
    await sleep(800);
    ok('a worker outside Nigeria cannot open the limited task', !(await op.isVisible('h1:has-text("Phase four UI task")')));

    ok('no unexpected page errors were thrown', errors.length === 0, errors.slice(0, 3).join(' | '));

    await browser.close();
    await db.end();
    console.log(`\n${failed === 0 ? 'Phase 4 UI checks passed' : failed + ' Phase 4 UI check(s) failed'}`);
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
