// scripts/signin-limit-test.js — per-account, per-network sign-in limits, and the hourly per-account backstop.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log node scripts/signin-limit-test.js
// Run on a server with default limits. The per-IP cap has its own test (signin-ip-cap-test.js).
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
const MAX = Number(process.env.SIGNIN_MAX_FAILURES) || 10;
const MAX_EMAIL = Number(process.env.SIGNIN_MAX_PER_EMAIL) || 50;
if (!LOG_FILE) { console.error('Set LOG_FILE to the server log.'); process.exit(1); }
const results = [];
let failed = 0;
function ok(label, cond, extra) {
    results.push((cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + JSON.stringify(extra).slice(0, 240) : ''));
    if (!cond) failed += 1;
}
// The attacker's network. Every request defaults to it, so this is "one shared network".
const NETWORK = '198.51.100.' + (Date.now() % 200 + 1);
const OWNER_NETWORK = '203.0.113.77';
async function api(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': NETWORK, ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
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
async function signupVerifiedBase(email) {
    await api('POST', '/api/auth/signup', { email, password: 'correct-horse-1', name: 'Lock Test', role: 'worker' });
    await sleep(200);
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
}

(async() => {
    const stamp = Date.now();
    const a = `lockA+${stamp}@test.com`;
    const b = `lockB+${stamp}@test.com`;
    const c = `lockC+${stamp}@test.com`;
    await signupVerified(a);
    await signupVerified(b);
    await signupVerified(c);
    const good = 'correct-horse-1';

    // 1. Failures on the attacker's network get the generic 401, then that network is locked for the account.
    let generic = true;
    for (let i = 0; i < MAX; i++) {
        const r = await api('POST', '/api/auth/signin', { email: a, password: 'wrong-guess-' + i });
        if (r.status !== 401 || !r.body || r.body.message !== 'Invalid email or password') generic = false;
    }
    ok(`the first ${MAX} wrong passwords get the generic 401`, generic);
    const locked = await api('POST', '/api/auth/signin', { email: a, password: good });
    ok('after the limit on that network, the right password is refused (429)', locked.status === 429, locked.body);
    ok('the locked response says why and when to retry', locked.body && /failed sign-in attempts/.test(locked.body.message) && Number(locked.headers.get('retry-after')) > 0, { body: locked.body, retry: locked.headers.get('retry-after') });

    // 2. Email case does not get around the lock.
    const upper = await api('POST', '/api/auth/signin', { email: a.toUpperCase(), password: good });
    ok('upper-case email hits the same lock (429)', upper.status === 429, upper.body);

    // 3. The attacker cannot lock the owner out from the owner's own network.
    const owner = await api('POST', '/api/auth/signin', { email: a, password: good }, { 'x-forwarded-for': OWNER_NETWORK });
    ok("the owner still signs in from their own network (200)", owner.status === 200 && !!owner.body.token, owner.body);

    // 4. A locked account does not lock anyone else on the same network.
    const other = await api('POST', '/api/auth/signin', { email: c, password: good });
    ok('another account on the same network still signs in (200)', other.status === 200 && !!other.body.token, other.body);

    // 5. Unknown email gets exactly the same answer as a wrong password.
    const unknown = await api('POST', '/api/auth/signin', { email: `nobody+${stamp}@test.com`, password: 'whatever-123' });
    ok('an unknown email gets the same generic 401', unknown.status === 401 && unknown.body.message === 'Invalid email or password', unknown.body);

    // 6. A success clears the count: 5 failures, success, then 9 more failures are still allowed.
    for (let i = 0; i < 5; i++) await api('POST', '/api/auth/signin', { email: c, password: 'nope-' + i });
    const cleared = await api('POST', '/api/auth/signin', { email: c, password: good });
    ok('5 failures then the right password: signs in (200)', cleared.status === 200, cleared.body);
    let nineOk = true;
    for (let i = 0; i < MAX - 1; i++) {
        const r = await api('POST', '/api/auth/signin', { email: c, password: 'again-' + i });
        if (r.status !== 401) nineOk = false;
    }
    ok(`after a success, ${MAX - 1} more failures are still just 401s`, nineOk);
    const stillIn = await api('POST', '/api/auth/signin', { email: c, password: good });
    ok('and the right password still works (200)', stillIn.status === 200, stillIn.body);

    // 7. The hourly backstop: many failures from many networks lock the account for everyone.
    let spreadOk = true;
    for (let i = 0; i < MAX_EMAIL; i++) {
        const r = await api('POST', '/api/auth/signin', { email: b, password: 'spread-' + i }, { 'x-forwarded-for': '192.0.2.' + (i + 1) });
        if (r.status !== 401) spreadOk = false;
    }
    ok(`${MAX_EMAIL} failures from ${MAX_EMAIL} networks are each a normal 401`, spreadOk);
    const backstop = await api('POST', '/api/auth/signin', { email: b, password: good }, { 'x-forwarded-for': '198.18.0.9' });
    ok('then the account is locked for an hour, even from a new network (429)', backstop.status === 429, backstop.body);

    console.log(results.join('\n'));
    if (failed) { console.error(`\n${failed} of ${results.length} sign-in limit checks failed.`); process.exit(1); }
    console.log(`\nAll ${results.length} sign-in limit checks passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
