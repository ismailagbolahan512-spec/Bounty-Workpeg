// scripts/ui-test.js — drives the real UI (signup, reset, reviews, reports, public pages).
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/to/server.log node scripts/ui-test.js
// Needs: npm i -D playwright && npx playwright install chromium (or set PLAYWRIGHT_BROWSERS_PATH).
// The server must run WITHOUT RESEND_API_KEY so emails are written to the log.
// Browser test: drives the real UI against the local server (port 3100).
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
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
    const browser = await chromium.launch();
    const errors = [];

    async function newPage() {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
        return page;
    }

    async function authedPage(token, user) {
        const ctx = await browser.newContext();
        await ctx.addCookies([{ name: 'bounty_session', value: token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: user });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
        return page;
    }

    // ---------- 1. Signup in the browser shows the verification banner
    const workerEmail = 'ui-worker+' + stamp + '@test.com';
    const bizEmail = 'ui-biz+' + stamp + '@test.com';
    const PASS = 'password123';

    let page = await newPage();
    await page.goto(BASE + '/#/auth/signup');
    await page.fill('#auth-name', 'UI Worker');
    await page.fill('#auth-email', workerEmail);
    await page.fill('#auth-password', PASS);
    await page.click('#auth-submit');
    await sleep(400);

    // Dismiss the existing worker onboarding popup, as a real user would
    await page.waitForSelector('#onboarding-modal', { timeout: 5000 }).catch(() => null);
    if (await page.$('#onboarding-modal')) { await page.click('#onboarding-modal button:has-text("Skip")'); await sleep(300); }



    // ---------- 3. Forgot and reset password through the UI
    const forgotPage = await newPage();
    await forgotPage.goto(BASE + '/#/auth/forgot');
    await forgotPage.fill('#forgot-email', workerEmail);
    await forgotPage.click('#forgot-submit');
    await forgotPage.waitForSelector('#forgot-note:not([hidden])', { timeout: 8000 }).catch(() => null);
    ok('forgot password shows generic confirmation', await forgotPage.isVisible('#forgot-note'));
    await sleep(400);
    const resetToken = tokenFromLog(workerEmail, 'reset?token=');
    ok('reset email reached the log', !!resetToken);
    await forgotPage.goto(BASE + '/#/reset?token=' + resetToken);
    await forgotPage.fill('#reset-password', 'brandnewpass1');
    await forgotPage.fill('#reset-confirm', 'brandnewpass2');
    await forgotPage.click('#reset-submit');
    await sleep(500);
    ok('mismatched passwords are refused', (await forgotPage.textContent('#reset-error')).includes('do not match'));
    await forgotPage.fill('#reset-confirm', 'brandnewpass1');
    await forgotPage.click('#reset-submit');
    await sleep(1200);
    ok('valid reset returns user to log in', (await forgotPage.evaluate(() => location.hash)).indexOf('auth/login') !== -1);
    const login = await api('POST', '/api/auth/signin', { email: workerEmail, password: 'brandnewpass1' });
    await acceptFor(login.body && login.body.role, login.body && login.body.token);
    ok('new password works via API', login.status === 200, login.body);

    // ---------- 4. Business completes a bounty, worker reviews & reports (through the UI)
    const biz = await api('POST', '/api/auth/signup', { email: bizEmail, password: PASS, name: 'UI Biz', role: 'business' });
    await acceptFor(biz.body && biz.body.role, biz.body && biz.body.token);
    await sleep(300);
    const bizLogin = await api('POST', '/api/auth/signin', { email: bizEmail, password: PASS });
    await acceptFor(bizLogin.body && bizLogin.body.role, bizLogin.body && bizLogin.body.token);
    const bounty = await api('POST', '/api/bounties', {
        title: 'UI review test bounty', description: 'Created by the browser test to check reviews.',
        category: 'dev', difficulty: 'easy', reward_amount: 500,
        deadline: new Date(Date.now() + 86400000).toISOString(), submission_type: 'github',
    }, bizLogin.body.token);
    ok('business creates bounty via API', bounty.status === 201, bounty.body);
    const wLogin = await api('POST', '/api/auth/signin', { email: workerEmail, password: 'brandnewpass1' });
    await acceptFor(wLogin.body && wLogin.body.role, wLogin.body && wLogin.body.token);
    const sub = await api('POST', '/api/submissions', { bounty_id: bounty.body.id, title: 'UI submission', description: 'Browser test submission text. Tested and ready for review by the business.', github_link: 'https://github.com/example/ui-submit' }, wLogin.body.token);
    ok('worker submits via API', sub.status === 201, sub.body);
    const appr = await api('POST', '/api/submissions/' + sub.body.id + '/approve', null, bizLogin.body.token);
    ok('business approves via API', appr.status === 200, appr.body);

    // Business in browser: review form and report button
    const bizPage = await authedPage(bizLogin.body.token, { id: bizLogin.body.id, email: bizEmail, name: 'UI Biz', role: 'business', email_verified: true });
    await bizPage.goto(BASE + '/#/bounties/' + bounty.body.id);
    await bizPage.waitForSelector('#review-section', { timeout: 8000 }).catch(() => null);
    ok('business sees review form on completed bounty', await bizPage.$('#review-section') !== null);
    ok('business sees report button', await bizPage.$('#report-toggle') !== null);
    await bizPage.selectOption('#review-rating', '4');
    await bizPage.fill('#review-comment', 'Solid submission, thank you.');
    await bizPage.click('#review-submit');
    await bizPage.waitForSelector('text=Thanks for your review', { timeout: 8000 }).catch(() => null);
    ok('business submits review in UI', (await bizPage.textContent('#review-section')).includes('Thanks for your review'));

    await bizPage.click('#report-toggle');
    await bizPage.selectOption('#report-reason', 'spam');
    await bizPage.click('#report-submit');
    await sleep(800);
    ok('business report toast shows after sending', /Report sent/.test(await bizPage.textContent('#toast')));

    // Worker in browser: sees review form for the business and the report button
    const wPage = await authedPage(wLogin.body.token, { id: wLogin.body.id, email: workerEmail, name: 'UI Worker', role: 'worker', email_verified: true });
    await wPage.goto(BASE + '/#/bounties/' + bounty.body.id);
    await wPage.waitForSelector('#review-section', { timeout: 8000 }).catch(() => null);
    ok('worker (winner) sees review form', await wPage.$('#review-section') !== null);
    ok('worker who submitted sees report button', await wPage.waitForSelector('#report-toggle', { timeout: 5000 }).then(() => true).catch(() => false));

    // ---------- 5. Public worker portfolio and legal pages
    const pub = await newPage();
    await pub.goto(BASE + '/#/worker/' + wLogin.body.id);
    await pub.waitForSelector('text=Completed bounties', { timeout: 8000 }).catch(() => null);
    const pubText = await pub.textContent('#app');
    ok('public worker page shows name and completed bounty', pubText.includes('UI Worker') && pubText.includes('UI review test bounty'));
    ok('public worker page does not show email', !pubText.includes(workerEmail));

    await pub.goto(BASE + '/#/terms');
    await pub.waitForSelector('text=Terms of use', { timeout: 5000 }).catch(() => null);
    ok('terms page renders', (await pub.textContent('#app')).includes('Who we are'));
    await pub.goto(BASE + '/#/privacy');
    await pub.waitForSelector('text=Privacy policy', { timeout: 5000 }).catch(() => null);
    ok('privacy page renders', (await pub.textContent('#app')).includes('What we collect'));

    // ---------- 5b. Admin reports screen
    const adminEmailUi = 'ui-admin+' + stamp + '@test.com';
    await api('POST', '/api/auth/signup', { email: adminEmailUi, password: PASS, name: 'UI Admin', role: 'worker' });
    await sleep(300);
    const { pool } = require('../db');
    await pool.query('UPDATE users SET is_admin = TRUE, onboarding_done = TRUE WHERE email = $1', [adminEmailUi]);
    const adminLoginUi = await api('POST', '/api/auth/signin', { email: adminEmailUi, password: PASS });
    await acceptFor(adminLoginUi.body && adminLoginUi.body.role, adminLoginUi.body && adminLoginUi.body.token);
    // Logged in the normal way: the cached user has no is_admin, so the page must ask the server.
    const adminPageUi = await authedPage(adminLoginUi.body.token, { id: adminLoginUi.body.id, email: adminEmailUi, name: 'UI Admin', role: 'worker', email_verified: true });
    await adminPageUi.goto(BASE + '/#/admin');
    ok('admin footer link appears after the server confirms admin', (await adminPageUi.textContent('footer')).includes('Admin'));
    await adminPageUi.waitForSelector('[data-decision="resolved"]', { timeout: 8000 }).catch(() => null);
    ok('admin sees open report cards', await adminPageUi.$('[data-decision="resolved"]') !== null);
    await adminPageUi.fill('[id^="note-"]', 'Reviewed in browser test.');
    let confirmText = '';
    adminPageUi.once('dialog', (dialog) => { confirmText = dialog.message(); dialog.accept(); });
    await adminPageUi.click('[data-decision="resolved"]');
    ok('resolve asks for confirmation first', /Resolve this report/.test(confirmText));
    await sleep(1200);
    ok('admin resolves a report in the UI', /Report resolved/.test(await adminPageUi.textContent('#toast')));
    await pool.end();

    const nonAdminUi = await authedPage(wLogin.body.token, { id: wLogin.body.id, email: workerEmail, name: 'UI Worker', role: 'worker', email_verified: true });
    await nonAdminUi.goto(BASE + '/#/admin');
    await nonAdminUi.waitForSelector('text=Admins only', { timeout: 5000 }).catch(() => null);
    ok('non-admin sees Admins only on the admin page', (await nonAdminUi.textContent('#app')).includes('Admins only'));

    // ---------- 6. Business email is not exposed on the public bounty API
    const detail = await api('GET', '/api/bounties/' + bounty.body.id);
    ok('bounty API does not expose business email', detail.body && detail.body.business && !('email' in detail.body.business), detail.body && detail.body.business);

    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

    await browser.close();
    results.forEach((r) => console.log(r));
    console.log(failed === 0 ? '\nAll UI checks passed.' : '\n' + failed + ' UI check(s) failed.');
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Crashed:', err);
    process.exit(1);
});

// Accepts the agreement matching the account's role after signup or signin, as real users must.
async function acceptFor(role, token) {
    const kind = { business: 'creator_protection_business', worker: 'worker_submission_ip' }[role];
    if (!kind || !token) return;
    const r = await api('POST', '/api/protection/agreements/accept', { kind }, token);
    void r;
}
