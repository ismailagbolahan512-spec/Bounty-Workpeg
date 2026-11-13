// scripts/projects-ui-test.js — browser checks for projects, criteria, revisions and worker resubmits.
//
// Usage (server running with DATABASE_URL, NO AI_PROVIDER_URL, no RESEND_API_KEY):
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log NODE_PATH=/opt/npm-tools/node_modules node scripts/projects-ui-test.js
// Exits with code 1 on the first failed check.

const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) {
    console.error('Set LOG_FILE to the server log.');
    process.exit(1);
}

function ok(label, cond, extra) {
    if (!cond) {
        console.error('FAIL', label, extra !== undefined ? JSON.stringify(extra) : '');
        process.exit(1);
    }
    console.log('PASS', label);
}

async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}

function tokenFromLog(to, marker) {
    const log = fs.readFileSync(LOG_FILE, 'utf8');
    const blocks = log.split('--- [dev email, not sent]').slice(1);
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].includes(`to: ${to}`) && blocks[i].includes(marker)) {
            const m = blocks[i].match(/token=([0-9a-f]{64})/);
            if (m) return m[1];
        }
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function skipOnboarding(page) {
    await page.waitForSelector('#ob-skip', { timeout: 2000 }).then((b) => b.click()).catch(() => null);
}

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

async function verifiedUser(email, role, name) {
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
    await sleep(200);
    await acceptFor(r.body.role, r.body.token);
    return { token: r.body.token, id: r.body.id, email, name, role, email_verified: true };
}

(async() => {
    const stamp = Date.now();
    const biz = await verifiedUser(`uipbiz+${stamp}@test.com`, 'business', 'UI Project Biz');
    const worker = await verifiedUser(`uipw+${stamp}@test.com`, 'worker', 'UI Project Worker');

    // Single bounty with criteria, submitted to, so the business can check and request changes.
    const bounty = await api('POST', '/api/bounties', {
        title: 'Criteria review bounty', description: 'A bounty used to test checks and revisions.',
        category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(5), submission_type: 'github',
        acceptance_criteria: [{ text: 'At least fifty words', rule: { type: 'min_words', min: 50 } }, { text: 'Clean code', rule: null }],
    }, biz.token);
    ok('API setup: criteria bounty created', bounty.status === 201, bounty.body);
    const sub = await api('POST', '/api/submissions', { bounty_id: bounty.body.id, title: 'First try', description: 'Short note. Tested and ready for review by the business.', github_link: 'https://github.com/example/first' }, worker.token);
    ok('API setup: worker submits', sub.status === 201, sub.body);

    // Blocked project task, for the waiting-state checks.
    const project = await api('POST', '/api/projects', {
        title: 'UI project', description: 'Two steps, the second waits on the first.',
        tasks: [
            { title: 'Step one', description: 'The first step of the project.', category: 'dev', difficulty: 'easy', reward_amount: 90, deadline: inDays(6), submission_type: 'github', acceptance_criteria: [] },
            { title: 'Step two', description: 'The second step, waits on step one.', category: 'dev', difficulty: 'easy', reward_amount: 60, deadline: inDays(6), submission_type: 'github', depends_on: [0], acceptance_criteria: [{ text: 'Has a link', rule: { type: 'link_required' } }] },
        ],
    }, biz.token);
    ok('API setup: project created', project.status === 201, project.body);

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
        return page;
    }

    try {
        // 1. Business builds a project by hand, with a dependency and criteria
        const bp = await pageFor(biz);
        await bp.goto(BASE + '/#/projects/new');
        await skipOnboarding(bp);
        await bp.waitForSelector('#project-form', { timeout: 8000 });
        await bp.fill('#project-title', 'Hand-built launch');
        await bp.fill('#project-description', 'Built by hand in the browser test.');
        const rows = await bp.$$('.task-row');
        ok('new project form starts with two task rows', rows.length === 2, rows.length);
        const fillRow = async(index, title, extra) => {
            const row = (await bp.$$('.task-row'))[index];
            await row.$('[data-f="title"]').then((el) => el.fill(title));
            await row.$('[data-f="description"]').then((el) => el.fill('Description for ' + title + '.'));
            await row.$('[data-f="reward"]').then((el) => el.fill('150'));
            await row.$('[data-f="deadline"]').then((el) => el.fill(inDays(4).slice(0, 16)));
            if (extra.criteria) await row.$('[data-f="criteria"]').then((el) => el.fill(extra.criteria));
            if (extra.depends) await row.$('[data-f="depends"]').then((el) => el.fill(extra.depends));
        };
        await fillRow(0, 'Hand task one', { criteria: 'At least 3 words | words:3' });
        await fillRow(1, 'Hand task two', { depends: '1' });
        await bp.click('#create-project-btn');
        await bp.waitForURL(/#\/projects\/[0-9a-f-]{36}/, { timeout: 8000 }).catch(() => null);
        ok('creating a project lands on its page', /#\/projects\/[0-9a-f-]{36}/.test(await bp.evaluate(() => location.hash)), await bp.evaluate(() => location.hash));
        await bp.waitForSelector('.dashboard-item h3 a', { timeout: 8000 });
        const detailText = await bp.textContent('#project-content');
        ok('project page lists both tasks', detailText.includes('Hand task one') && detailText.includes('Hand task two'), detailText.slice(0, 200));
        ok('second task shows it is waiting on the first', detailText.includes('Waiting on: Hand task one'));
        ok('criteria are shown on the task', detailText.includes('At least 3 words'));

        // 2. Criteria on a single bounty form
        await bp.goto(BASE + '/#/bounties/new');
        await skipOnboarding(bp);
        await bp.waitForSelector('#create-bounty-form', { timeout: 8000 });
        await bp.fill('#bounty-title', 'Form criteria bounty');
        await bp.fill('#bounty-description', 'Created with acceptance criteria in the form.');
        await bp.selectOption('#bounty-category', 'dev');
        await bp.selectOption('#bounty-difficulty', 'easy');
        await bp.fill('#bounty-reward', '200');
        await bp.fill('#bounty-deadline', inDays(3).slice(0, 16));
        await bp.fill('#bounty-criteria', 'Mentions a deadline | words:4\nReadable names');
        await bp.click('#create-bounty-btn');
        await bp.waitForURL(/#\/bounties\/[0-9a-f-]{36}/, { timeout: 8000 }).catch(() => null);
        await bp.waitForSelector('text=Mentions a deadline', { timeout: 8000 }).catch(() => null);
        ok('bounty form saves criteria and detail shows them', (await bp.textContent('body')).includes('Mentions a deadline'), { hash: await bp.evaluate(() => location.hash), error: await bp.evaluate(() => { const e = document.getElementById('create-error'); return e && !e.hidden ? e.textContent : ''; }) });

        // 3. Business reviews the criteria bounty: run checks, then request changes
        await bp.goto(BASE + '/#/bounties/' + bounty.body.id);
        await skipOnboarding(bp);
        await bp.waitForSelector('[data-checks]', { timeout: 8000 });
        await bp.click('[data-checks]');
        await bp.waitForSelector('.check-fail', { timeout: 8000 });
        ok('checks show a failing word count without rejecting', (await bp.textContent('[data-submission]')).includes('needs attention') || (await bp.$('.check-fail')) !== null);
        await bp.click('[data-revise]');
        await bp.fill('[data-revise-box] textarea', 'Please explain the approach in more detail.');
        bp.once('dialog', (d) => d.accept());
        await bp.click('[data-revise-send]');
        await bp.waitForFunction(() => (document.querySelector('#review-list') || {}).textContent?.includes('Changes requested'), null, { timeout: 8000 }).catch(() => null);
        ok('business sends the submission back for changes', (await bp.textContent('#review-list')).includes('Changes requested'));

        // 4. Worker sees the request and resubmits
        const wp = await pageFor(worker);
        await wp.goto(BASE + '/#/dashboard');
        await skipOnboarding(wp);
        await wp.waitForSelector('#revision-requests', { timeout: 8000 }).catch(() => null);
        ok('worker dashboard shows changes requested', (await wp.$('#revision-requests')) !== null);
        await wp.fill('[data-resubmit-card] [data-f="description"]', 'A fuller explanation of the approach, as requested.');
        await wp.click('[data-resubmit]');
        await sleep(800);
        const after = await api('GET', '/api/submissions/mine', null, worker.token);
        const row = (after.body || []).find((s) => s.id === sub.body.id);
        ok('resubmit moves the same submission back to pending', row && row.status === 'pending', row);

        // 5. Blocked task: worker cannot submit to step two until step one completes
        const step2 = project.body.task_ids[1];
        await wp.goto(BASE + '/#/bounties/' + step2);
        await skipOnboarding(wp);
        await wp.waitForSelector('text=waits for other tasks', { timeout: 8000 }).catch(() => null);
        ok('blocked task shows the waiting notice', (await wp.textContent('body')).includes('waits for other tasks'));
        ok('blocked task hides the submit form', (await wp.$('#submission-form')) === null);

        // 6. AI drafting when unconfigured shows a clear message
        await bp.goto(BASE + '/#/projects/new');
        await skipOnboarding(bp);
        await bp.waitForSelector('#ai-plan-form', { timeout: 8000 });
        await bp.fill('#ai-prompt', 'Launch a landing page for a coffee brand.');
        await bp.click('#ai-plan-btn');
        await bp.waitForSelector('#ai-plan-error:not([hidden])', { timeout: 8000 }).catch(() => null);
        ok('with no model, the planner drafts with our rules engine and says so', (await bp.textContent('#ai-plan-output')).includes('Drafted by our rules engine'));
    } finally {
        await browser.close();
    }

    ok('no uncaught page errors', errors.length === 0, errors);
    console.log('\nAll projects UI checks passed.');
    process.exit(0);
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
