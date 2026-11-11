// scripts/protection-ui-test.js — trust and safety screens in a real browser.
// Worker files a report, business removes a worker's NDA access, admin works the queue and
// records a decision, restricted business sees its standing and appeals.
// Usage: BASE=http://localhost:3100 NODE_PATH=/opt/npm-tools/node_modules node scripts/protection-ui-test.js
const { chromium } = require('playwright');
const { pool } = require('../db');

const BASE = process.env.BASE || 'http://localhost:3100';
const stamp = Date.now();
const results = [];
let failed = 0;
function ok(label, cond, extra) {
    results.push((cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
}
async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const GOOD = 'Protection UI fixture: implemented the requested change and tested it before review.';

async function account(role, name, admin) {
    const email = `pui-${role}-${name.replace(/\W/g, '').toLowerCase()}-${stamp}@example.com`;
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
    await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [r.body.id]);
    if (admin) await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [r.body.id]);
    await api('POST', '/api/protection/agreements/accept', { kind: role === 'business' ? 'creator_protection_business' : 'worker_submission_ip' }, r.body.token);
    return { id: r.body.id, token: r.body.token, email, name, role, admin: !!admin };
}

async function pageFor(browser, user) {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'bounty_session', value: user.token, url: BASE }]);
    await ctx.addInitScript(({ u }) => {
        localStorage.setItem('bounty_user', JSON.stringify(u));
    }, { u: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: true, is_admin: user.admin } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    return { page, errors };
}

async function openProtection(page) {
    await page.goto(BASE + '/#/protection');
    await page.waitForSelector('#ob-skip', { timeout: 2000 }).then((b) => b.click()).catch(() => null);
    await page.waitForSelector('h1:has-text("Trust and safety")', { timeout: 10000 }).catch(() => null);
}

(async() => {
    const biz = await account('business', 'Pui Biz');
    const worker = await account('worker', 'Pui Worker');
    const admin = await account('worker', 'Pui Admin', true);
    const restricted = await account('business', 'Pui Restricted');

    const open = await api('POST', '/api/bounties', {
        title: 'Protection UI open task', description: 'An ordinary task for the report fixture.',
        category: 'dev', difficulty: 'easy', reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    const sub = await api('POST', '/api/submissions', { bounty_id: open.body.id, title: 'Fixture work', description: GOOD, github_link: 'https://github.com/example/pui' }, worker.token);
    ok('fixture submission created', sub.status === 201, sub.body);

    const conf = await api('POST', '/api/bounties', {
        title: 'Protection UI confidential', description: 'Confidential fixture for NDA records.',
        category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(5), submission_type: 'github', confidential: true,
    }, biz.token);
    await api('POST', '/api/protection/agreements/accept', { kind: 'task_nda', bounty_id: conf.body.id }, worker.token);
    const take = await api('POST', `/api/bounties/${conf.body.id}/accept`, {}, worker.token);
    ok('worker takes the confidential fixture task', take.status === 200 || take.status === 201, take.body);

    // Fixture decision on a second business, so its standing and appeal can be tested in the UI.
    const restrict = await api('POST', '/api/protection/admin/enforcement', {
        user_id: restricted.id, action: 'restrict_publishing', reason: 'Fixture restriction for the appeal screen.',
    }, admin.token);
    ok('fixture restriction recorded', restrict.status === 201, restrict.body);

    const browser = await chromium.launch();
    try {
        // Worker: file a report from the screen.
        const w = await pageFor(browser, worker);
        await openProtection(w.page);
        ok('the worker sees the report form', (await w.page.$('#report-form')) !== null);
        await w.page.waitForFunction(() => document.querySelectorAll('#report-ref option[value]:not([value=""])').length > 0, null, { timeout: 8000 }).catch(() => null);
        ok('the worker\'s submission appears in the task picker', (await w.page.$$('#report-ref option[value]:not([value=""])')).length >= 1);
        await w.page.selectOption('#report-form select[name="kind"]', 'copyright_misuse');
        await w.page.selectOption('#report-ref', { index: 1 });
        await w.page.fill('#report-form textarea[name="description"]', 'The advert uses my work without a licence.');
        await w.page.click('#report-form button[type="submit"]');
        await w.page.waitForSelector('#my-reports table tbody tr', { timeout: 8000 }).catch(() => null);
        ok('the new report appears in the worker\'s list', (await w.page.$$('#my-reports table tbody tr')).length === 1);
        ok('the worker sees no internal findings', !(await w.page.innerText('#my-reports')).toLowerCase().includes('findings'));
        ok('no uncaught page errors for the worker', w.errors.length === 0, w.errors.join(' | '));

        // Business: remove a worker's NDA access from the records screen.
        const b = await pageFor(browser, biz);
        await openProtection(b.page);
        await b.page.waitForFunction(() => document.querySelectorAll('#nda-task option[value]:not([value=""])').length > 0, null, { timeout: 8000 }).catch(() => null);
        await b.page.selectOption('#nda-task', conf.body.id);
        await b.page.waitForSelector('.revoke-btn', { timeout: 8000 }).catch(() => null);
        ok('the business sees the NDA record with a remove control', (await b.page.$('.revoke-btn')) !== null);
        await b.page.click('.revoke-btn');
        await b.page.waitForFunction(() => !document.querySelector('.revoke-btn'), null, { timeout: 8000 }).catch(() => null);
        ok('after removal the worker no longer has access', (await b.page.$('.revoke-btn')) === null);
        const rec = await api('GET', `/api/protection/business/nda-records?bounty_id=${conf.body.id}`, null, biz.token);
        ok('the NDA record is kept after removal', rec.body.records.length === 1, rec.body);
        ok('no uncaught page errors for the business', b.errors.length === 0, b.errors.join(' | '));

        // Admin: open the queue, open the report, move it to review.
        const a = await pageFor(browser, admin);
        await openProtection(a.page);
        await a.page.waitForSelector('#report-queue tr.clickable', { timeout: 8000 }).catch(() => null);
        ok('the admin queue lists the report', (await a.page.$$('#report-queue tr.clickable')).length >= 1);
        await a.page.click('#report-queue tr.clickable');
        await a.page.waitForSelector('#status-form', { timeout: 8000 }).catch(() => null);
        const detailText = await a.page.innerText('#report-detail');
        ok('the admin sees the description and the audit trail', /without a licence/.test(detailText) && /report\.submitted/.test(detailText), detailText.slice(0, 160));
        await a.page.selectOption('#status-form select[name="status"]', 'under_review');
        await a.page.click('#status-form button[type="submit"]');
        await a.page.waitForFunction(() => /Under review/.test(document.querySelector('#report-detail')?.innerText || ''), null, { timeout: 8000 }).catch(() => null);
        ok('the admin moves the report to under review', /Under review/.test(await a.page.innerText('#report-detail')));

        // Admin: enforcement form shows the legal confirmation only for termination.
        const legalHidden = await a.page.$eval('#legal-line', (el) => el.hidden);
        await a.page.selectOption('#enforce-form select[name="action"]', 'terminate');
        const legalShown = await a.page.$eval('#legal-line', (el) => !el.hidden);
        ok('the legal review line appears for termination only', legalHidden && legalShown);
        await a.page.selectOption('#enforce-form select[name="action"]', 'warning');
        ok('the legal review line hides again for a warning', await a.page.$eval('#legal-line', (el) => el.hidden));
        ok('no uncaught page errors for the admin', a.errors.length === 0, a.errors.join(' | '));

        // Restricted business: standing shows, and an appeal can be sent.
        const r = await pageFor(browser, restricted);
        await openProtection(r.page);
        await r.page.waitForSelector('.appeal-form textarea', { timeout: 8000 }).catch(() => null);
        ok('the restricted business sees its decision and an appeal form', (await r.page.$('.appeal-form textarea')) !== null);
        await r.page.fill('.appeal-form textarea', 'The restriction was made in error; the work is licensed.');
        await r.page.click('.appeal-form button[type="submit"]');
        await r.page.waitForFunction(() => /Appeal open|open/i.test(document.body.innerText) && !document.querySelector('.appeal-form'), null, { timeout: 8000 }).catch(() => null);
        ok('after appealing the form is replaced by the appeal status', (await r.page.$('.appeal-form')) === null);
        const queue = await api('GET', '/api/protection/admin/appeals?status=open', null, admin.token);
        ok('the appeal reaches the admin queue', queue.body.appeals.some((x) => x.user_name === restricted.name), queue.body);
        ok('no uncaught page errors for the restricted business', r.errors.length === 0, r.errors.join(' | '));
    } finally {
        await browser.close();
        await pool.end();
    }

    for (const line of results) console.log(line);
    console.log(`${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(async(err) => {
    console.error('FAIL unexpected error:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
});
