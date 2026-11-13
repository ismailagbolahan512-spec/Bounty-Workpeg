// scripts/coordinator-ui-test.js — the project page shows live progress to its owner, and not to visitors.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log NODE_PATH=/opt/npm-tools/node_modules node scripts/coordinator-ui-test.js
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
    await sleep(250);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    return { token: r.body.token, id: r.body.id, email, name, role };
}

(async() => {
    const biz = await signupVerified(`cuibiz+${stamp}@test.com`, 'business', 'Coordinator UI Biz');
    const visitor = await signupVerified(`cuivis+${stamp}@test.com`, 'worker', 'Coordinator UI Visitor');
    const plan = await api('POST', '/api/projects/plan', { prompt: 'Research the market, build a landing page and deliver the files.' }, biz.token);
    const approved = await api('POST', `/api/projects/plan/${plan.body.id}/approve`, { confirm_rewards: true }, biz.token);
    ok('fixture project approved', approved.status === 201, JSON.stringify(approved.body));
    const pid = approved.body.id;

    const browser = await chromium.launch();
    const errors = [];
    async function open(token, user) {
        const ctx = await browser.newContext();
        if (token) {
            await ctx.addCookies([{ name: 'bounty_session', value: token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: user });
        }
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('dialog', (d) => d.accept());
        await page.goto(BASE + '/#/projects/' + pid);
        await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((el) => el.click()).catch(() => null);
        await sleep(300);
        return page;
    }

    const owner = await open(biz.token, { id: biz.id, email: biz.email, name: biz.name, role: 'business', email_verified: true });
    await owner.waitForSelector('#project-progress .progress-bar', { timeout: 8000 }).catch(() => null);
    const text = await owner.textContent('#project-progress').catch(() => '');
    ok('owner sees the progress panel', text.includes('Progress') && text.includes('Ready to start'), text.slice(0, 200));
    ok('owner sees a waiting step', text.includes('Waiting'));

    const guest = await open(null, null);
    await guest.waitForSelector('.project-progress, text=Project', { timeout: 6000 }).catch(() => null);
    await sleep(800);
    ok('a visitor who is not signed in does not see progress', (await guest.$('#project-progress')) === null);

    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} coordinator UI checks passed.` : `\n${failed} of ${results.length} coordinator UI checks failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
