// scripts/phase2-ui-test.js — browser checks for the Phase 2 screens: dispute centre (raise,
// reply, decision), administrator queue and its access check, the overlap review on a task,
// and budget guidance on the create form.
//
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase2-ui-test.js
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
    const s = await api('POST', '/api/auth/signin', { email, password: 'password123' });
    await acceptFor(s.body && s.body.role, s.body && s.body.token);
    return { token: s.body.token, id: s.body.id, user: { id: s.body.id, email, name, role, email_verified: true } };
}

(async() => {
    const browser = await chromium.launch();
    const biz = await verifiedUser(`p2ui-biz+${stamp}@test.com`, 'business', 'Phase Two UI Biz');
    const w = await verifiedUser(`p2ui-w+${stamp}@test.com`, 'worker', 'Phase Two UI Worker');
    const adm = await verifiedUser(`p2ui-adm+${stamp}@test.com`, 'business', 'Phase Two UI Admin');
    await db.query('UPDATE users SET is_admin = true WHERE id = $1', [adm.id]);
    await db.query('UPDATE users SET onboarding_done = true WHERE id = ANY($1::uuid[])', [[biz.id, w.id, adm.id]]);
    adm.user.is_admin = true;

    const project = await api('POST', '/api/projects', {
        title: 'Phase two UI project', description: 'A project used by the phase two browser checks.',
        tasks: [{ title: 'Checkout research task', description: 'Research the checkout requirements and report.', category: 'dev', difficulty: 'easy', reward_amount: 500, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz.token);
    const taskId = project.body.task_ids[0];
    const sub = await api('POST', '/api/submissions', { bounty_id: taskId, title: 'Checkout', description: 'Researched the checkout requirements, wrote the report and listed the open questions for review.', github_link: 'https://github.com/example/checkout' }, w.token);
    const subId = sub.body.id;

    const bp = await browserPage(biz);
    // Owner task page: the overlap review panel is present
    await bp.goto(BASE + '/#/bounties/' + taskId);
    await bp.waitForSelector('[data-dup-scan]', { timeout: 10000 }).catch(() => null);
    ok('the owner sees the overlap review on the task page', await bp.isVisible('[data-dup-scan]'));
    ok('the overlap review offers a dispute about the task', await bp.isVisible('a[href^="#/disputes/new?bounty="]'));
    await bp.click('[data-dup-scan]');
    await bp.waitForSelector('text=Overlap check complete.', { timeout: 8000 }).catch(() => null);
    await bp.waitForSelector('[data-dup-scan]', { timeout: 8000 }).catch(() => null);
    ok('re-checking the task keeps the review panel on the page', await bp.isVisible('[data-dup-scan]'));

    // Business create form: budget guidance produces a range
    await bp.goto(BASE + '/#/bounties/new');
    await bp.waitForSelector('[data-budget-slot] #budget-estimate', { timeout: 10000 }).catch(() => null);
    ok('the create form shows budget guidance', await bp.isVisible('#budget-estimate'));
    await bp.fill('#bounty-description', 'Build a checkout flow with payment steps, validation, and tests for the shop.');
    await bp.click('#budget-estimate');
    await bp.waitForSelector('#budget-out dl', { timeout: 8000 }).catch(() => null);
    ok('the budget guidance shows a recommended range', /Recommended range/.test(await bp.textContent('#budget-out')));
    ok('the guidance says it is not a verified market rate', /not a verified market rate/.test(await bp.textContent('[data-budget-slot]')));
    await bp.close();

    // Worker raises a dispute from the task
    const wp = await browserPage(w);
    await wp.goto(BASE + '/#/disputes/new?bounty=' + taskId);
    await wp.waitForSelector('#dp-category option[value="unfair_rejection"]', { timeout: 10000 }).catch(() => null);
    ok('the dispute form lists the categories from the server', (await wp.$$('#dp-category option')).length >= 10);
    await wp.selectOption('#dp-category', 'changed_requirements');
    await wp.fill('#dp-title', 'Requirements changed after the work');
    await wp.fill('#dp-description', 'The requirements were changed after I started, without a new agreement or extra payment.');
    await wp.click('#dp-submit');
    await wp.waitForURL(/#\/disputes\/[0-9a-f-]{36}/, { timeout: 10000 }).catch(() => null);
    const m = wp.url().match(/#\/disputes\/([0-9a-f-]{36})/);
    ok('raising a dispute opens its record', Boolean(m), wp.url());
    const disputeId = m ? m[1] : null;
    if (disputeId) {
        await wp.waitForSelector('#dp-reply-text', { timeout: 8000 }).catch(() => null);
        ok('the respondent sees the reply form', await wp.isVisible('#dp-reply-text'));
        await wp.fill('#dp-reply-text', 'The requirements were updated during the work, as I described in the dispute.');
        await wp.click('#dp-reply button[type="submit"]');
        await wp.waitForSelector('text=The requirements were updated', { timeout: 8000 }).catch(() => null);
        ok('a reply appears in the message thread', /The requirements were updated/.test(await wp.textContent('.thread')));
        const bad = await api('POST', `/api/disputes/${disputeId}/evidence`, { kind: 'link', body: 'http://insecure.example/x' }, w.token);
        ok('an insecure evidence link is refused by the server', bad.status === 400);
    }
    await wp.goto(BASE + '/#/admin/disputes');
    await wp.waitForSelector('text=Not available for this account', { timeout: 8000 }).catch(() => null);
    ok('a non-administrator cannot open the dispute queue', await wp.isVisible('text=Not available for this account'));
    await wp.close();

    // Administrator: queue, record and decision
    const ap = await browserPage(adm);
    await ap.goto(BASE + '/#/admin/disputes');
    await ap.waitForSelector('table.data-table', { timeout: 10000 }).catch(() => null);
    ok('the administrator sees the dispute in the queue', await ap.isVisible('table.data-table a[href^="#/disputes/"]'));
    if (disputeId) {
        await ap.goto(BASE + '/#/disputes/' + disputeId);
        await ap.waitForSelector('#dp-decide', { timeout: 10000 }).catch(() => null);
        ok('the administrator sees the decision form', await ap.isVisible('#dp-decide'));
        await ap.selectOption('#dp-outcome', 'upheld_raiser');
        await ap.fill('#dp-decision', 'The requirements changed without agreement, so the dispute is upheld in favour of the worker.');
        await ap.selectOption('#dp-payment', 'release');
        await ap.click('#dp-decide button[type="submit"]');
        await ap.waitForSelector('#dp-decide', { state: 'detached', timeout: 8000 }).catch(() => null);
        ok('the decision form closes once the decision is recorded', !(await ap.isVisible('#dp-decide')));
        ok('the decision and its payment outcome are shown on the record', /upheld in favour/.test(await ap.textContent('.detail-layout')) && /released/.test(await ap.textContent('.detail-layout')));
    }
    await ap.close();

    await db.end();
    await browser.close();
    if (errors.length) console.log('Page errors:\n' + errors.join('\n'));
    const pass = failed === 0 && errors.length === 0;
    console.log(pass ? '\nAll phase 2 browser checks passed.' : `\n${failed} check(s) failed.`);
    process.exit(pass ? 0 : 1);

    async function browserPage(session) {
        const ctx = await browser.newContext();
        await ctx.addCookies([{ name: 'bounty_session', value: session.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: session.user });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('dialog', (d) => d.accept());
        return page;
    }
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
    void r;
}
