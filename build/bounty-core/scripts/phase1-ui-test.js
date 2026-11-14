// scripts/phase1-ui-test.js — browser checks for the Phase 1 screens: milestones on a project
// (business and worker views), the verification report on a submission, and proof of work
// on a worker profile.
//
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log node scripts/phase1-ui-test.js
// Needs Playwright (NODE_PATH). Run against a server without RESEND_API_KEY.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
if (!LOG) {
    console.error('Set LOG_FILE to the server log.');
    process.exit(1);
}
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
    const biz = await verifiedUser(`p1ui-biz+${stamp}@test.com`, 'business', 'Phase One UI Biz');
    const w = await verifiedUser(`p1ui-w+${stamp}@test.com`, 'worker', 'Phase One UI Worker');

    const project = await api('POST', '/api/projects', {
        title: 'UI storefront project', description: 'A project used by the phase one browser checks.',
        tasks: [{ title: 'Storefront research task', description: 'Research the storefront requirements and report.', category: 'dev', difficulty: 'easy', reward_amount: 500, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz.token);
    const projectId = project.body.id;
    const taskId = project.body.task_ids[0];
    const sub = await api('POST', '/api/submissions', { bounty_id: taskId, title: 'Research', description: 'Storefront research task completed with a full report on the requirements and risks.', github_link: 'https://github.com/example/research' }, w.token);
    const subId = sub.body.id;

    const browser = await chromium.launch();
    async function pageFor(session) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await ctx.addCookies([{ name: 'bounty_session', value: session.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: session.user });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('dialog', (d) => d.accept());
        page.gotoSkipping = async(url) => {
            await page.goto(url);
            await page.waitForSelector('#ob-skip', { timeout: 2000 }).then((b) => b.click()).catch(() => null);
        };
        return page;
    }

    // ---- business: add a milestone assigned to the worker
    const bp = await pageFor(biz);
    await bp.gotoSkipping(BASE + '/#/projects/' + projectId);
    await bp.waitForSelector('.milestones', { timeout: 10000 }).catch(() => null);
    ok('the business sees a milestones section on the project', await bp.isVisible('.milestones'));
    await bp.click('[data-ms-new]');
    await bp.fill('#ms-title', 'Research and planning');
    await bp.fill('#ms-del', 'A written plan with timeline and risks');
    await bp.fill('#ms-acc', 'The owner agrees the plan');
    await bp.fill('#ms-budget', '250');
    await bp.selectOption('#ms-worker', { label: 'Phase One UI Worker' }).catch(() => null);
    await bp.click('.ms-form button[type="submit"]');
    await bp.waitForSelector('.milestone-card', { timeout: 8000 }).catch(() => null);
    ok('the business adds a milestone and sees it listed', (await bp.textContent('.milestone-list')).includes('Research and planning'));
    ok('the milestone shows the assigned worker', (await bp.textContent('.milestone-list')).includes('Phase One UI Worker'));

    // Project budget cap: a cap below what the milestones already allocate is refused.
    await bp.fill('#ms-project-budget', '200');
    await bp.click('[data-ms-budget-form] button[type="submit"]');
    await bp.waitForFunction(() => /cannot be set below/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => null);
    ok('a project budget below the milestone total is refused in the page', /cannot be set below/.test(await bp.textContent('body')));
    // A cap that covers the milestones is saved and shown with the remaining amount.
    await bp.fill('#ms-project-budget', '300');
    await bp.click('[data-ms-budget-form] button[type="submit"]');
    await bp.waitForFunction(() => /Project budget NGN 300\.00/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => null);
    ok('a valid project budget is saved and shows the remaining amount', /Project budget NGN 300\.00 · allocated NGN 250\.00 · remaining NGN 50\.00/.test(await bp.textContent('body')));
    await bp.close();

    // ---- worker: start, then submit for review
    const wp = await pageFor(w);
    await wp.gotoSkipping(BASE + '/#/projects/' + projectId);
    await wp.waitForSelector('[data-ms-action="start"]', { timeout: 10000 }).catch(() => null);
    ok('the worker sees a start button on their milestone', await wp.isVisible('[data-ms-action="start"]'));
    await wp.click('[data-ms-action="start"]');
    await wp.waitForSelector('.ms-submit', { timeout: 8000 }).catch(() => null);
    ok('starting shows the submission form', await wp.isVisible('.ms-submit'));
    await wp.fill('.ms-submit textarea[name="text"]', 'Completed the plan covering the timeline, the risks and the agreed budget split.');
    await wp.fill('.ms-submit input[name="link"]', 'https://docs.example.com/plan');
    await wp.click('.ms-submit button[type="submit"]');
    await wp.waitForFunction(() => document.querySelector('.milestone-card') && /Submitted for review/.test(document.querySelector('.milestone-card').textContent), null, { timeout: 8000 }).catch(() => null);
    ok('the worker submits and sees the milestone as submitted', /Submitted for review/.test(await wp.textContent('.milestone-card')));
    await wp.close();

    // ---- business: approve the milestone
    const bp2 = await pageFor(biz);
    await bp2.gotoSkipping(BASE + '/#/projects/' + projectId);
    await bp2.waitForSelector('[data-ms-action="approve"]', { timeout: 10000 }).catch(() => null);
    ok('the business can approve a submitted milestone', await bp2.isVisible('[data-ms-action="approve"]'));
    await bp2.click('[data-ms-action="approve"]');
    await bp2.waitForFunction(() => document.querySelector('.milestone-card') && /Approved/.test(document.querySelector('.milestone-card').textContent), null, { timeout: 8000 }).catch(() => null);
    ok('approval records eligibility and says no payment was made', /No payment has been made/.test(await bp2.textContent('.milestone-card')));
    await bp2.close();

    // ---- business: verification report on the submission
    const bp3 = await pageFor(biz);
    await bp3.gotoSkipping(BASE + '/#/bounties/' + taskId);
    await bp3.waitForSelector('[data-verify]', { timeout: 10000 }).catch(() => null);
    await bp3.click('[data-verify]');
    await bp3.waitForSelector('.verify-report', { timeout: 8000 }).catch(() => null);
    const reportInfo = await bp3.$eval('.verify-report', (el) => {
        const r = el.getBoundingClientRect();
        const chain = [];
        for (let n = el; n && n !== document.body; n = n.parentElement) chain.push(n.tagName + '.' + n.className + (n.hidden ? '[hidden]' : '') + ':' + getComputedStyle(n).display);
        return { w: r.width, h: r.height, chain: chain.slice(0, 6).join(' < ') };
    }).catch((e) => ({ error: e.message }));
    if (!(await bp3.isVisible('.verify-report'))) await bp3.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/verify-debug.png', fullPage: true });
    ok('the business sees a verification report', await bp3.isVisible('.verify-report'), JSON.stringify(reportInfo));
    ok('the report says it does not decide', /never accepts or rejects work/.test(await bp3.textContent('.verify-report')));
    await bp3.close();

    // ---- public worker profile: proof of work (approve the submission first)
    await api('POST', `/api/submissions/${subId}/approve`, null, biz.token);
    const pp = await pageFor(biz);
    await pp.gotoSkipping(BASE + '/#/worker/' + w.id);
    await pp.waitForSelector('.reputation', { timeout: 10000 }).catch(() => null);
    ok('the public worker profile shows proof of work', await pp.isVisible('.reputation'));
    ok('proof of work lists the industry it was earned in', /Dev/i.test(await pp.textContent('.reputation')));
    await pp.close();

    await browser.close();
    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
    console.log(failed === 0 ? '\nAll phase 1 UI checks passed.' : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Crashed:', err.message);
    process.exit(1);
});

// Accepts the agreement matching the account's role after signup or signin, as real users must.
async function acceptFor(role, token) {
    const kind = { business: 'creator_protection_business', worker: 'worker_submission_ip' }[role];
    if (!kind || !token) return;
    const r = await api('POST', '/api/protection/agreements/accept', { kind }, token);
    void r;
}
