// scripts/workspace-ui-test.js — drives the task workspace and deadline proposal screens in a browser.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/to/server.log NODE_PATH=/opt/npm-tools/node_modules node scripts/workspace-ui-test.js
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
async function go(page, hash) {
    await page.goto(BASE + '/' + hash);
    await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((b) => b.click()).catch(() => null);
    await sleep(300);
}
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
    await sleep(250);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    return { token: r.body.token, id: r.body.id, email, name, role };
}

(async() => {
    const biz = await signupVerified(`wsbiz+${stamp}@test.com`, 'business', 'Workspace Biz');
    const worker = await signupVerified(`wsw+${stamp}@test.com`, 'worker', 'Workspace Worker');
    const outsider = await signupVerified(`wsout+${stamp}@test.com`, 'worker', 'Workspace Outsider');

    const bounty = await api('POST', '/api/bounties', { title: 'Workspace bounty ' + stamp, description: 'Bounty for the workspace UI test.', category: 'dev', difficulty: 'easy', reward_amount: 60, deadline: inDays(5), submission_type: 'github' }, biz.token);
    ok('fixture bounty created', bounty.status === 201, bounty.body);
    const bid = bounty.body.id;
    const sub = await api('POST', '/api/submissions', { bounty_id: bid, title: 'Workspace work', description: 'Work for review. Tested and ready for review by the business.', github_link: 'https://github.com/example/ws' }, worker.token);
    ok('fixture submission created', sub.status === 201, sub.body);

    const browser = await chromium.launch();
    const errors = [];
    async function pageFor(user) {
        const ctx = await browser.newContext();
        await ctx.addCookies([{ name: 'bounty_session', value: user.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: true } });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('dialog', (d) => d.accept());
        return page;
    }

    // 1. Business: workspace visible, sends a message
    const bizPage = await pageFor(biz);
    await go(bizPage, '#/bounties/' + bid);
    await bizPage.waitForSelector('#workspace #workspace-input', { timeout: 8000 }).catch(() => null);
    ok('business sees the task workspace', await bizPage.$('#workspace #workspace-input') !== null);
    await bizPage.fill('#workspace #workspace-input', 'Hi, please check the README first.');
    await bizPage.click('#workspace #workspace-send');
    await bizPage.waitForSelector('#workspace .message', { timeout: 5000 }).catch(() => null);
    const bizText = await bizPage.textContent('#workspace .message-list');
    ok('business message appears in thread', bizText.includes('check the README'), bizText);

    // 2. Worker on the task: sees the message and replies
    const workerPage = await pageFor(worker);
    await go(workerPage, '#/bounties/' + bid);
    await workerPage.waitForSelector('#workspace .message', { timeout: 8000 }).catch(() => null);
    const wText = await workerPage.textContent('#workspace .message-list').catch(() => '');
    ok('worker sees business message', wText.includes('check the README'), wText);
    await workerPage.fill('#workspace #workspace-input', 'On it, will update soon.');
    await workerPage.click('#workspace #workspace-send');
    await sleep(600);
    const wReply = await workerPage.textContent('#workspace .message-list').catch(() => '');
    ok('worker reply appears in thread', wReply.includes('On it, will update soon.'), wReply);

    // 3. Outsider with no submission: no workspace section at all
    const outPage = await pageFor(outsider);
    await go(outPage, '#/bounties/' + bid);
    await sleep(1200);
    ok('outsider does not see the workspace', await outPage.$('#workspace') === null);

    // 4. Business proposes a new deadline with a revision request
    await bizPage.reload();
    await bizPage.waitForSelector('[data-revise]', { timeout: 8000 }).catch(() => null);
    await bizPage.click('[data-revise]');
    await bizPage.fill('[data-revise-box] textarea', 'Please add tests for the edge cases.');
    const newDeadline = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 16);
    await bizPage.fill('[data-revise-deadline]', newDeadline);
    await bizPage.click('[data-revise-send]');
    await sleep(1200);
    const after = await api('GET', '/api/submissions/mine', null, worker.token);
    const mine = Array.isArray(after.body) ? after.body.find((s) => s.bounty_id === bid) : null;
    ok('revision request stored a proposed deadline', mine && mine.proposed_deadline, after.body);

    // 5. Worker sees the proposal and accepts it
    await workerPage.goto(BASE + '/#/dashboard');
    await workerPage.waitForSelector('[data-accept-deadline]', { timeout: 8000 }).catch(() => null);
    ok('worker sees accept button for proposal', await workerPage.$('[data-accept-deadline]') !== null);
    await workerPage.click('[data-accept-deadline]');
    await sleep(1200);
    const b2 = await api('GET', '/api/bounties/' + bid, null, worker.token);
    const newMs = new Date(b2.body.deadline).getTime();
    const wantMs = new Date(newDeadline).getTime();
    ok('accepting moved the bounty deadline', Math.abs(newMs - wantMs) < 120000, { newMs, wantMs });

    // 6. Errors and cleanup
    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} of ${results.length} checks failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
