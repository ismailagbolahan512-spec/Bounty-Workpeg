// scripts/checker-ui-test.js — the business review screen shows checker findings.
// Server needs the mock AI settings (see scripts/checker-test.js). Usage:
// BASE=http://localhost:3100 LOG_FILE=/path/server.log NODE_PATH=/opt/npm-tools/node_modules node scripts/checker-ui-test.js
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
    return { token: r.body.token, id: r.body.id, email, name, role };
}

(async() => {
    const biz = await signupVerified(`ckuibiz+${stamp}@test.com`, 'business', 'Checker UI Biz');
    const worker = await signupVerified(`ckuiw+${stamp}@test.com`, 'worker', 'Checker UI Worker');
    const worker2 = await signupVerified(`ckuiw2+${stamp}@test.com`, 'worker', 'Checker UI Worker Two');
    const b = await api('POST', '/api/bounties', { title: 'Checker UI bounty ' + stamp, description: 'Bounty for the checker screen test.', category: 'dev', difficulty: 'easy', reward_amount: 35, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [{ text: 'Explains the design choices', rule: null }] }, biz.token);
    const bid = b.body.id;
    const s1 = await api('POST', '/api/submissions', { bounty_id: bid, title: 'Quoted work', description: 'Built the page with HTML and CSS and tested it on phones.', github_link: 'https://github.com/example/ui1' }, worker.token);
    const s2 = await api('POST', '/api/submissions', { bounty_id: bid, title: 'Fake quote work', description: 'CHECK_FAKE_QUOTE built a page with html and css.', github_link: 'https://github.com/example/ui2' }, worker2.token);
    ok('fixtures created', s1.status === 201 && s2.status === 201, JSON.stringify([s1.body, s2.body]));

    const browser = await chromium.launch();
    const errors = [];
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'bounty_session', value: biz.token, url: BASE }]);
        await ctx.addInitScript(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: { id: biz.id, email: biz.email, name: biz.name, role: 'business', email_verified: true } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());

    await page.goto(BASE + '/#/bounties/' + bid);
    await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((el) => el.click()).catch(() => null);
    await sleep(300);
    await page.waitForSelector(`[data-submission="${s1.body.id}"] [data-checks]`, { timeout: 8000 }).catch(() => null);

    await page.click(`[data-submission="${s1.body.id}"] [data-checks]`);
    await page.waitForSelector(`[data-submission="${s1.body.id}"] .check-pill`, { timeout: 8000 }).catch(() => null);
    const card1 = await page.textContent(`[data-submission="${s1.body.id}"] [data-checks-out]`).catch(() => '');
    ok('quoted criterion shows as met with an AI suggestion', card1.includes('Met') && card1.includes('AI suggestion'), card1.slice(0, 200));
    ok('quoted evidence is shown', (await page.$(`[data-submission="${s1.body.id}"] blockquote.evidence`)) !== null);
    ok('the check says it never rejects work', card1.includes('Checks never reject work') || (await page.textContent(`[data-submission="${s1.body.id}"]`)).includes('Checks never reject work'));

    await page.click(`[data-submission="${s2.body.id}"] [data-checks]`);
    await page.waitForSelector(`[data-submission="${s2.body.id}"] .check-pill`, { timeout: 8000 }).catch(() => null);
    const card2 = await page.textContent(`[data-submission="${s2.body.id}"] [data-checks-out]`).catch(() => '');
    ok('unquoted "met" shows as a possible issue, not met', card2.includes('Possible issue') && !card2.includes('Met'), card2.slice(0, 200));

    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
    await browser.close();
    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} checker UI checks passed.` : `\n${failed} of ${results.length} checker UI checks failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
