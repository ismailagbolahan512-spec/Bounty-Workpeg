// scripts/project-ui-test.js — drives the project, criteria, revision and resubmit screens in a browser.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/to/server.log NODE_PATH=/opt/npm-tools/node_modules node scripts/project-ui-test.js
// The server must run WITHOUT AI_PROVIDER_URL (the AI draft check expects the "not configured" message).
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
// First-run onboarding can cover the page; skip it like a user would.
async function go(page, hash) {
    await page.goto(BASE + '/' + hash);
    await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((b) => b.click()).catch(() => null);
    await sleep(300);
}
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const localInput = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 16);

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
const task = (title, extra) => Object.assign({ title, description: 'Work item: ' + title + ' details.', category: 'dev', difficulty: 'easy', reward_amount: 90, deadline: inDays(6), submission_type: 'github' }, extra || {});

(async() => {
    const biz = await signupVerified(`uiprojbiz+${stamp}@test.com`, 'business', 'UI Project Biz');
    const worker = await signupVerified(`uiprojw+${stamp}@test.com`, 'worker', 'UI Project Worker');

    // Fixture: a 2-task project (second waits on first) and a criteria bounty with a pending submission.
    const project = await api('POST', '/api/projects', { title: 'Fixture project ' + stamp, description: 'Two linked tasks for the UI test.', tasks: [task('Step one ' + stamp), task('Step two ' + stamp, { depends_on: [0] })] }, biz.token);
    ok('fixture project created via API', project.status === 201, project.body);
    const crit = await api('POST', '/api/bounties', { title: 'Criteria bounty ' + stamp, description: 'Bounty with criteria for the UI test.', category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [{ text: 'Write at least fifty words', rule: { type: 'min_words', min: 50 } }, { text: 'Clear code style', rule: null }] }, biz.token);
    ok('fixture criteria bounty created', crit.status === 201, crit.body);
    const sub = await api('POST', '/api/submissions', { bounty_id: crit.body.id, title: 'UI fixture work', description: 'Short note. Tested and ready for review by the business.', github_link: 'https://github.com/example/ui' }, worker.token);
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

    // 1. Project detail shows the chain and the block
    const bizPage = await pageFor(biz);
    await bizPage.goto(BASE + '/#/projects/' + project.body.id);
    await bizPage.waitForSelector('text=Step two', { timeout: 10000 }).catch(() => null);
    const projText = await bizPage.textContent('#project-content');
    ok('project page lists both tasks', projText.includes('Step one') && projText.includes('Step two'), projText.slice(0, 200));
    ok('project page says the second task waits on the first', projText.includes('Waiting on: Step one'), projText.slice(0, 400));
    ok('project page shows the blocked label', projText.includes('Blocked'));

    // 2. Bounty detail: criteria, run checks, request changes
    await bizPage.goto(BASE + '/#/bounties/' + crit.body.id);
    await bizPage.waitForSelector('text=Acceptance criteria', { timeout: 10000 }).catch(() => null);
    ok('bounty page shows acceptance criteria', (await bizPage.textContent('body')).includes('Write at least fifty words'));
    await bizPage.waitForSelector('[data-checks]', { timeout: 10000 }).catch(() => null);
    await bizPage.click('[data-checks]');
    await bizPage.waitForSelector('[data-checks-out] >> text=Some automatic checks fail', { timeout: 8000 }).catch(() => null);
    ok('run checks shows the fail summary without rejecting', (await bizPage.textContent('body')).includes('Some automatic checks fail'));
    await bizPage.click('[data-revise]');
    await bizPage.fill('[data-revise-box] textarea', 'Please explain the change in more detail.');
    await bizPage.click('[data-revise-send]');
    await sleep(1200);
    const afterRev = await api('GET', '/api/submissions/bounty/' + crit.body.id, null, biz.token);
    ok('request changes moves the submission to revision_requested', afterRev.body[0].status === 'revision_requested', afterRev.body);

    // 3. Worker sees the request and resubmits the same row
    const wPage = await pageFor(worker);
    await go(wPage, '#/dashboard');
    await wPage.waitForSelector('[data-resubmit]', { timeout: 10000 }).catch(() => null);
    ok('worker sees the changes requested section', (await wPage.textContent('body')).includes('Changes requested'));
    await wPage.fill('[data-resubmit-card] [data-f="description"]', 'Here is a much longer explanation of the change.');
    await wPage.click('[data-resubmit]');
    await sleep(1200);
    const afterResub = await api('GET', '/api/submissions/mine', null, worker.token);
    const row = (afterResub.body || []).find((s) => s.id === sub.body.id);
    ok('resubmit returns the same row to pending', row && row.status === 'pending', row);

    // 4. Business dashboard lists the project
    await go(bizPage, '#/dashboard');
    await bizPage.waitForSelector('#my-projects', { timeout: 10000 }).catch(() => null);
    ok('dashboard lists the business project', (await bizPage.textContent('#my-projects')).includes('Fixture project ' + stamp));

    // 5. AI draft: unconfigured server says so, nothing is created
    await go(bizPage, '#/projects/new');
    await bizPage.waitForSelector('#ai-prompt', { timeout: 10000 });
    await bizPage.fill('#ai-prompt', 'Launch a landing page for a coffee brand with copy.');
    await bizPage.click('#ai-plan-btn');
    await bizPage.waitForSelector('#ai-plan-error:not([hidden])', { timeout: 8000 }).catch(() => null);
    ok('with no model, the planner drafts with our rules engine and says so', (await bizPage.textContent('#ai-plan-output')).includes('Drafted by our rules engine'));

    // 6. Manual project created through the form
    const manualTitle = 'Manual project ' + stamp;
    await bizPage.fill('#project-title', manualTitle);
    await bizPage.fill('#project-description', 'Created through the form in the UI test.');
    await bizPage.locator('.task-row').nth(0).locator('[data-f="title"]').fill('Manual task A');
    await bizPage.locator('.task-row').nth(0).locator('[data-f="description"]').fill('Manual task A description here.');
    await bizPage.locator('.task-row').nth(0).locator('[data-f="reward"]').fill('120');
    await bizPage.locator('.task-row').nth(0).locator('[data-f="deadline"]').fill(localInput(4));
    await bizPage.locator('.task-row').nth(1).locator('[data-f="title"]').fill('Manual task B');
    await bizPage.locator('.task-row').nth(1).locator('[data-f="description"]').fill('Manual task B description here.');
    await bizPage.locator('.task-row').nth(1).locator('[data-f="reward"]').fill('150');
    await bizPage.locator('.task-row').nth(1).locator('[data-f="deadline"]').fill(localInput(5));
    await bizPage.locator('.task-row').nth(1).locator('[data-f="depends"]').fill('1');
    await bizPage.click('#create-project-btn');
    await sleep(1500);
    const created = bizPage.url().includes('#/projects/');
    ok('manual project form creates a project and opens it', created, bizPage.url());
    if (created) {
        const mine = await api('GET', '/api/projects/mine', null, biz.token);
        ok('manual project exists with 2 tasks', (mine.body || []).some((p) => p.title === manualTitle && p.task_count === 2), mine.body);
    }

    await browser.close();
    results.forEach((r) => console.log(r));
    if (errors.length) { console.log('PAGE ERRORS: ' + errors.join(' | ')); failed += 1; }
    console.log(failed ? `\n${failed} check(s) failed.` : '\nAll project UI checks passed.');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Crashed:', e.message); process.exit(1); });
