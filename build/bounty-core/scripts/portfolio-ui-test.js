// scripts/portfolio-ui-test.js — the worker portfolio in a browser: show work, draft, edit, save, public view.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=rules|mock|anthropic NODE_PATH=/opt/npm-tools/node_modules node scripts/portfolio-ui-test.js
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
const AI_MODE = process.env.AI_MODE || 'rules';
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
    await sleep(200);
    return { token: r.body.token, id: r.body.id, email, name, role };
}

(async() => {
    const biz = await signupVerified(`poauibiz+${stamp}@test.com`, 'business', 'Cedar Studio');
    const worker = await signupVerified(`poauiw+${stamp}@test.com`, 'worker', 'Dami Okafor');
    const b = await api('POST', '/api/bounties', { title: 'UI portfolio task', description: 'Task used by the portfolio UI test.', category: 'design', difficulty: 'easy', reward_amount: 150, deadline: inDays(5), submission_type: 'github' }, biz.token);
    const s = await api('POST', '/api/submissions', { bounty_id: b.body.id, title: 'Event poster set', description: 'Designed three event posters in one consistent style.', github_link: 'https://github.com/example/posters' }, worker.token);
    const approve = await api('POST', `/api/submissions/${s.body.id}/approve`, null, biz.token);
    ok('setup: a business approves one submission from the worker', approve.status === 200, approve.body);

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(BASE + '/');
        await page.context().addCookies([{ name: 'bounty_session', value: worker.token, url: BASE }]);
        await page.evaluate(({ u }) => {
            localStorage.setItem('bounty_user', JSON.stringify(u));
        }, { u: { id: worker.id, email: worker.email, name: worker.name, role: 'worker', email_verified: true } });

        await page.reload();
        await page.goto(BASE + '/#/profile');
        await page.waitForSelector('#ob-skip', { timeout: 3000 }).then((b) => b.click()).catch(() => null);
        await page.waitForSelector('#portfolio-section', { timeout: 15000 });
        const card = await page.textContent('#portfolio-section');
        ok('portfolio card lists the approved work', card.includes('Event poster set'), card.slice(0, 200));
        ok('portfolio says verified work is approved on Bounty', card.includes('verified on Bounty'), card.slice(0, 200));

        await page.check('input[data-show]');
        await sleep(800);
        const after = await api('GET', '/api/portfolio/me', null, worker.token);
        ok('ticking the box shows the work (saved on the server)', after.body.approved[0].portfolio_visible === true, after.body);

        await page.click('#portfolio-draft');
        await page.waitForSelector('#portfolio-draft-output .notice', { timeout: 15000 });
        const notice = await page.textContent('#portfolio-draft-output .notice');
        const draftText = await page.inputValue('#portfolio-summary');
        ok('the draft fills the editable summary', draftText.length > 0, draftText);
        if (AI_MODE === 'mock' || AI_MODE === 'anthropic') {
            ok('the draft says an AI model wrote it', notice.includes('AI model'), notice);
        } else {
            ok('the draft says our rules engine wrote it, not an AI model', notice.includes('rules engine'), notice);
        }
        ok('the draft shows what it is verified on', (await page.textContent('#portfolio-draft-output')).includes('Verified on Bounty'));

        const edited = 'Designs event posters in a consistent style. Reviewed by the business that approved the work.';
        await page.fill('#portfolio-summary', edited);
        await page.click('#portfolio-save');
        await sleep(800);
        const saved = await api('GET', '/api/portfolio/me', null, worker.token);
        ok('saving stores the worker’s edited summary on the server', saved.body.summary === edited, saved.body.summary);

        await page.goto(BASE + '/#/worker/' + worker.id);
        await page.waitForSelector('text=Verified work on Bounty', { timeout: 15000 });
        const pub = await page.textContent('body');
        ok('public profile shows the verified work and the saved summary', pub.includes('Event poster set') && pub.includes(edited), pub.slice(0, 300));
        ok('public profile does not show the worker email', !pub.includes(worker.email), '');

        ok('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    } finally {
        await browser.close();
    }

    console.log(results.join('\n'));
    if (failed) { console.error(`\n${failed} of ${results.length} checks failed.`); process.exit(1); }
    console.log(`\nAll ${results.length} portfolio UI checks passed (AI_MODE=${AI_MODE}).`);
})().catch((err) => { console.error(err); process.exit(1); });
