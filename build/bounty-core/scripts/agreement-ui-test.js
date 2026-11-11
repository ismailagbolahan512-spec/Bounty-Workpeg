// scripts/agreement-ui-test.js — the agreement prompt in a real browser.
// A worker takes a confidential task. The NDA prompt must appear, show the text, require a tick,
// record the acceptance and then complete the take. The task text must stay hidden until then.
// Usage: BASE=http://localhost:3100 NODE_PATH=/opt/npm-tools/node_modules node scripts/agreement-ui-test.js
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3100';
const stamp = Date.now();
const SECRET = `UI-SECRET-${stamp}-do-not-show`;
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
const { pool } = require('../db');
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

async function account(role, name) {
    const email = `agui-${role}-${stamp}@example.com`;
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
    await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [r.body.id]);
    return { id: r.body.id, token: r.body.token, email, name, role };
}

(async() => {
    const biz = await account('business', 'Agui Biz');
    const worker = await account('worker', 'Agui Worker');
    const accepted = await api('POST', '/api/protection/agreements/accept', { kind: 'creator_protection_business' }, biz.token);
    ok('fixture business accepts the agreement', accepted.status === 200, accepted.body);
    await api('POST', '/api/protection/agreements/accept', { kind: 'worker_submission_ip' }, worker.token);

    const created = await api('POST', '/api/bounties', {
        title: 'Agui confidential task', description: `Internal plan: ${SECRET}`,
        category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(5),
        submission_type: 'github', confidential: true,
    }, biz.token);
    ok('fixture confidential task created', created.status === 201, created.body);
    const bid = created.body.id;

    const browser = await chromium.launch();
    try {
        const ctx = await browser.newContext();
        await ctx.addCookies([{ name: 'bounty_session', value: worker.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: { id: worker.id, email: worker.email, name: worker.name, role: 'worker', email_verified: true } });
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        await page.goto(BASE + '/#/bounties/' + bid);
        // Skip the first-run onboarding overlay, as the other UI suites do.
        await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((b) => b.click()).catch(() => null);
        const takeButton = await page.waitForSelector('#take-task', { timeout: 10000 }).catch(() => null);
        ok('the worker sees the take button on the confidential task', takeButton !== null);
        const beforeText = await page.innerText('body');
        ok('the task text is hidden before the NDA is accepted', !beforeText.includes(SECRET));

        await takeButton.click();
        const dialog = await page.waitForSelector('.agreement-dialog', { timeout: 8000 }).catch(() => null);
        ok('the NDA prompt appears', dialog !== null);
        const dialogText = dialog ? await dialog.innerText() : '';
        ok('the prompt shows the NDA heading', /Task Confidentiality Agreement/.test(dialogText), dialogText.slice(0, 120));
        ok('the prompt shows the NDA body', /Confidential Information means/.test(dialogText));

        await page.click('.agreement-actions .btn-primary');
        const refused = await page.waitForSelector('.agreement-error:not([hidden])', { timeout: 3000 }).catch(() => null);
        ok('accepting without ticking the box is refused in the prompt', refused !== null);

        await page.check('.agreement-check input[type="checkbox"]');
        await page.click('.agreement-actions .btn-primary');
        await page.waitForSelector('.agreement-dialog', { state: 'detached', timeout: 10000 }).catch(() => null);
        ok('the prompt closes after accepting', (await page.$('.agreement-dialog')) === null);

        await page.waitForTimeout(1500);
        const state = await api('GET', '/api/bounties/' + bid, null, worker.token);
        ok('the acceptance is recorded on the server',
            (await pool.query("SELECT 1 FROM agreement_acceptances WHERE user_id = $1 AND kind = 'task_nda' AND bounty_id = $2", [worker.id, bid])).rows.length === 1);
        ok('the worker is now on the task', state.body.my_participation && state.body.my_participation.status === 'active', state.body.my_participation);
        const afterText = await page.innerText('body');
        ok('the task text appears once the NDA is accepted', afterText.includes(SECRET));
        ok('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
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
