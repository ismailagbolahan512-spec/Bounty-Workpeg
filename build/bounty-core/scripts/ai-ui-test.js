// scripts/ai-ui-test.js — the create-task AI panel in a browser: draft fills the form, then publish.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log NODE_PATH=/opt/npm-tools/node_modules node scripts/ai-ui-test.js
// Server needs the mock AI settings (see scripts/ai-architect-test.js).
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
if (!LOG) { console.error('Set LOG_FILE to the server log.'); process.exit(1); }
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async() => {
    const email = `aiuibiz+${stamp}@test.com`;
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name: 'AI UI Biz', role: 'business' });
    await acceptFor(r.body && r.body.role, r.body && r.body.token);
    await sleep(250);
    const biz = { token: r.body.token, id: r.body.id, email, name: 'AI UI Biz', role: 'business' };

    const browser = await chromium.launch();
    const errors = [];
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'bounty_session', value: biz.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: { id: biz.id, email: biz.email, name: biz.name, role: biz.role, email_verified: true } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());

    await page.goto(BASE + '/#/bounties/new');
    await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((b) => b.click()).catch(() => null);
    await page.waitForSelector('#ai-goal', { timeout: 8000 }).catch(() => null);
    await sleep(500);
    ok('AI panel is shown on the create page', await page.$('#ai-draft') !== null);
    const statusText = await page.textContent('#ai-status');
    ok('panel shows drafts left today', /drafts left today/.test(statusText), statusText);

    await page.fill('#ai-goal', 'I run a small bakery and need a one-page website with our menu, opening hours and a contact form.');
    await page.click('#ai-draft-btn');
    await page.waitForFunction(() => { const el = document.querySelector('#bounty-title'); return el && el.value.length > 0; }, null, { timeout: 8000 }).catch(() => null);

    ok('title is filled from the draft', (await page.inputValue('#bounty-title')) === 'Landing page for a bakery');
    ok('category is filled from the draft', (await page.inputValue('#bounty-category')) === 'dev');
    ok('reward is filled as a suggestion', (await page.inputValue('#bounty-reward')) === '15000.00');
    ok('deadline is filled with a future time', (await page.inputValue('#bounty-deadline')) !== '');
    const criteria = await page.inputValue('#bounty-criteria');
    ok('criteria are written in the form syntax', criteria.includes('| words:20') && criteria.includes('Page has a menu section'), criteria);
    const notes = await page.textContent('#ai-notes');
    ok('questions and missing info are shown', /Do you have a logo/.test(notes) && /Hosting preference/.test(notes), notes);
    ok('reward is labelled as a suggestion', /Suggested reward/.test(notes) && /not a decision/.test(notes), notes);

    // Publish through the normal form
    await page.click('#create-bounty-btn');
    await page.waitForURL(/#\/bounties\/[0-9a-f-]{36}/, { timeout: 10000 }).catch(() => null);
    ok('publishing the reviewed draft creates the bounty', /#\/bounties\/[0-9a-f-]{36}/.test(page.url()), page.url());

    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} AI UI checks passed.` : `\n${failed} of ${results.length} checks failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });

// Accepts the agreement matching the account's role after signup or signin, as real users must.
async function acceptFor(role, token) {
    const kind = { business: 'creator_protection_business', worker: 'worker_submission_ip' }[role];
    if (!kind || !token) return;
    const r = await api('POST', '/api/protection/agreements/accept', { kind }, token);
    void r;
}
