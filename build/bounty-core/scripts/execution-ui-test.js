// scripts/execution-ui-test.js — drives the create form and the take-a-task screens in a browser:
// mode cards, job-type guidance, security fields, the NDA then rules steps, and the audit trail.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/to/server.log node scripts/execution-ui-test.js
// Needs Playwright (NODE_PATH). The server must run WITHOUT RESEND_API_KEY so emails reach the log.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
if (!LOG) {
    console.error('Set LOG_FILE to the server log.');
    process.exit(1);
}
const stamp = Date.now();
const results = [];
let failed = 0;

function ok(label, cond, extra) {
    const line = (cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + extra : '');
    results.push(line);
    console.log(line);
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

async function verifiedUser(email, role, name) {
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    await acceptFor(r.body && r.body.role, r.body && r.body.token);
    if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
    await sleep(200);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    const signin = await api('POST', '/api/auth/signin', { email, password: 'password123' });
    await acceptFor(signin.body && signin.body.role, signin.body && signin.body.token);
    return { token: signin.body.token, user: { id: signin.body.id, email, name, role, email_verified: true } };
}

(async() => {
    const browser = await chromium.launch();
    const errors = [];

    async function pageFor(session) {
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
    async function skipOnboarding(page) {
        await page.waitForSelector('#ob-skip', { timeout: 2000 }).then((b) => b.click()).catch(() => null);
    }

    const biz = await verifiedUser(`exui-biz+${stamp}@test.com`, 'business', 'Execution UI Biz');
    const worker = await verifiedUser(`exui-w+${stamp}@test.com`, 'worker', 'Execution UI Worker');

    // ---- create form
    const bp = await pageFor(biz);
    await bp.goto(BASE + '/#/bounties/new');
    await skipOnboarding(bp);
    await bp.waitForSelector('#mode-grid .mode-card', { timeout: 10000 });
    ok('create form shows the four execution modes', (await bp.$$('#mode-grid .mode-card')).length === 4);
    ok('team mode is shown but cannot be chosen on a single task',
        await bp.$eval('#mode-grid input[value="team"]', (el) => el.disabled));
    ok('the default mode is competitive', await bp.$eval('#mode-grid input[value="competitive"]', (el) => el.checked));
    ok('winners field appears for competitive selection', await bp.isVisible('#winners-field'));

    await bp.selectOption('#bounty-job-type', 'sec-pentest-scoped');
    ok('choosing a security job type selects its recommended mode',
        await bp.$eval('#mode-grid input[value="first_valid"]', (el) => el.checked));
    ok('security fields appear for a security job type', await bp.isVisible('#security-fields'));
    ok('the recommended badge marks the suggested mode', await bp.isVisible('#mode-grid [data-badge="first_valid"]'));

    await bp.selectOption('#bounty-job-type', 'sw-bug-fix');
    await bp.click('#mode-grid label.mode-independent');
    ok('an unusual mode gets a plain-language note', await bp.isVisible('#execution-note') &&
        /usually works best as First Valid/.test(await bp.textContent('#execution-note')));
    ok('security fields hide for ordinary work', !(await bp.isVisible('#security-fields')));

    await bp.selectOption('#bounty-job-type', 'sec-pentest-scoped');
    await bp.fill('#bounty-title', 'Scoped pentest for staging UI');
    await bp.fill('#bounty-description', 'Test the staging web application within the written scope and report findings.');
    await bp.fill('#bounty-reward', '5000.00');
    const future = new Date(Date.now() + 3 * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    await bp.fill('#bounty-deadline', `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00`);
    await bp.click('#create-bounty-btn');
    await bp.waitForSelector('#create-error:not([hidden])', { timeout: 8000 }).catch(() => null);
    ok('publishing a security task without its authorization shows the reason',
        await bp.isVisible('#create-error') && /required/i.test(await bp.textContent('#create-error')));

    await bp.fill('#bounty-nda-text', 'The worker keeps every detail of the engagement confidential, uses it only for this task, and destroys copies when it closes.');
    await bp.fill('#bounty-authorization-statement', 'The business authorises testing of the single named staging system below, for the period of this task, and no other system.');
    await bp.fill('#bounty-rules-of-engagement', 'Test only the approved host. No denial-of-service. Stop and report at once if real customer data is reached.');
    await bp.fill('#bounty-permitted-targets', 'staging.example-shop.test (web application only)');
    await bp.fill('#bounty-prohibited-activities', 'No social engineering, no physical access, no denial-of-service, and no testing of other hosts.');
    await bp.click('#create-bounty-btn');
    await bp.waitForURL(/#\/bounties\/[0-9a-f-]{36}/, { timeout: 10000 }).catch(() => null);
    const created = bp.url().match(/#\/bounties\/([0-9a-f-]{36})/);
    ok('the security task is published once its fields are complete', Boolean(created), bp.url());
    const bountyId = created ? created[1] : null;

    if (bountyId) {
        // ---- business sees the audit trail
        await bp.goto(BASE + '/#/bounties/' + bountyId);
        await bp.waitForSelector('#history-toggle', { timeout: 10000 }).catch(() => null);
        ok('the business sees the workers section and audit trail toggle', await bp.isVisible('#history-toggle'));
        await bp.click('#history-toggle');
        await bp.waitForSelector('#history-box li', { timeout: 8000 }).catch(() => null);
        ok('the audit trail lists the task being published',
            /Task published/.test(await bp.textContent('#history-box')));
        await bp.close();

        // ---- worker: NDA first, then rules of engagement
        const wp = await pageFor(worker);
        await wp.goto(BASE + '/#/bounties/' + bountyId);
        await skipOnboarding(wp);
        await wp.waitForSelector('#accept-nda', { timeout: 10000 }).catch(() => null);
        const ndaShown = await wp.isVisible('#accept-nda');
        ok('a worker sees the NDA step first', ndaShown, 'section: ' + (await wp.textContent('#participation-section').catch(() => 'missing')).slice(0, 300));
        if (!ndaShown) throw new Error('NDA step not shown; stopping worker checks');
        ok('the rules of engagement are hidden before the NDA is accepted', !(await wp.isVisible('#accept-roe')));
        ok('taking the task is disabled until the NDA is accepted', await wp.$eval('#take-task', (el) => el.disabled));
        await wp.click('#accept-nda');
        await wp.click('#take-task');
        await wp.waitForSelector('#accept-roe', { timeout: 8000 }).catch(() => null);
        ok('after the NDA the rules of engagement appear', await wp.isVisible('#accept-roe'));
        ok('the rules text is shown to the worker', /Test only the approved host/.test(await wp.textContent('#participation-section')));
        await wp.click('#accept-roe');
        await wp.click('#accept-roe-btn');
        await wp.waitForSelector('text=You are working on this task', { timeout: 8000 }).catch(() => null);
        ok('after accepting the rules the worker can submit',
            /You are working on this task/.test(await wp.textContent('#participation-section')));
        await wp.close();
    }

    await browser.close();
    if (errors.length) console.log('Page errors:\n' + errors.join('\n'));
    console.log(failed === 0 && errors.length === 0 ? '\nAll execution UI checks passed.' : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Crashed:', err.message);
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
