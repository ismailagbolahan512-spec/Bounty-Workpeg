// scripts/signin-ip-cap-test.js — the per-IP cap on /api/auth.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log node scripts/signin-ip-cap-test.js
// Run on a server started with AUTH_IP_LIMIT=5.
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) { console.error('Set LOG_FILE to the server log.'); process.exit(1); }
const results = [];
let failed = 0;
function ok(label, cond, extra) {
    results.push((cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + JSON.stringify(extra).slice(0, 240) : ''));
    if (!cond) failed += 1;
}
let setupAddress = 1;
async function api(method, path, body, address) {
    // Setup requests each get their own address, so only the explicit phase below counts against the cap.
    const ip = address || ('10.7.' + (setupAddress >> 8 & 255) + '.' + (setupAddress++ & 255));
    const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
function tokenFromLog(to, marker) {
    const blocks = fs.readFileSync(LOG_FILE, 'utf8').split('--- [dev email, not sent]').slice(1);
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
    const stamp = Date.now();
    const email = `capuser+${stamp}@test.com`;
    await api('POST', '/api/auth/signup', { email, password: 'correct-horse-1', name: 'Cap Test', role: 'worker' });
    await sleep(200);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });

    const attacker = '203.0.113.' + (stamp % 200 + 1);
    let firstFive = true;
    for (let i = 0; i < 5; i++) {
        const r = await api('POST', '/api/auth/signin', { email: `ip${i}+${stamp}@test.com`, password: 'x-x-x-x' }, attacker);
        if (r.status !== 401) firstFive = false;
    }
    ok('the first 5 requests from one address are answered normally', firstFive);
    const sixth = await api('POST', '/api/auth/signin', { email: `ip9+${stamp}@test.com`, password: 'x-x-x-x' }, attacker);
    ok('the 6th request from that address is refused by the IP cap (429)', sixth.status === 429 && /Too many attempts/.test(sixth.body.message), sixth.body);
    const elsewhere = await api('POST', '/api/auth/signin', { email, password: 'correct-horse-1' }, '198.51.100.' + (stamp % 200 + 1));
    ok('a different address is not affected by that cap (200)', elsewhere.status === 200, elsewhere.body);

    console.log(results.join('\n'));
    if (failed) { console.error(`\n${failed} of ${results.length} IP cap checks failed.`); process.exit(1); }
    console.log(`\nAll ${results.length} IP cap checks passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
