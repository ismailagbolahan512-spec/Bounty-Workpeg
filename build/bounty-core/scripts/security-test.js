// scripts/security-test.js — security headers, origin policy, body limits and auth hardening.
// Usage: BASE=http://localhost:3100 node scripts/security-test.js

const BASE = process.env.BASE || 'http://localhost:3100';
let passed = 0;
let failed = 0;
function check(label, condition, detail) {
    if (condition) { passed++; console.log('  ✓', label); }
    else { failed++; console.log('  ✗', label, detail === undefined ? '' : JSON.stringify(detail)); }
}

async function run() {
    console.log('\n=== Security headers ===');
    const page = await fetch(BASE + '/');
    const csp = page.headers.get('content-security-policy') || '';
    check('pages send a Content-Security-Policy', csp.length > 0);
    check('CSP blocks plugins and framing', /object-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp));
    check('CSP only allows scripts from this origin', /script-src 'self'(;|$)/.test(csp) && !/script-src[^;]*unsafe/.test(csp), csp);
    check('X-Content-Type-Options is nosniff', page.headers.get('x-content-type-options') === 'nosniff');
    check('X-Frame-Options is DENY', page.headers.get('x-frame-options') === 'DENY');
    check('Referrer-Policy is set', !!page.headers.get('referrer-policy'));
    check('the framework version is not advertised', !page.headers.get('x-powered-by'));
    const api = await fetch(BASE + '/api/bounties');
    check('API responses carry the same headers', api.headers.get('x-content-type-options') === 'nosniff' && !!api.headers.get('content-security-policy'));

    console.log('\n=== Origin policy ===');
    const foreign = await fetch(BASE + '/api/bounties', { headers: { Origin: 'https://evil.example' } });
    check('a foreign origin gets no CORS allow header', !foreign.headers.get('access-control-allow-origin'));

    console.log('\n=== Request limits ===');
    const big = await fetch(BASE + '/api/auth/signin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@example.com', password: 'a'.repeat(200 * 1024) }),
    });
    check('oversized request bodies are refused (413)', big.status === 413, big.status);

    console.log('\n=== Authentication ===');
    const forged = await fetch(BASE + '/api/profile/me', { headers: { Authorization: 'Bearer not.a.token' } });
    check('a forged token is rejected (401)', forged.status === 401, forged.status);
    const none = await fetch(BASE + '/api/admin/users');
    check('admin routes reject anonymous callers (401)', none.status === 401, none.status);
    const weak = await fetch(BASE + '/api/auth/signin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-123' }),
    });
    check('wrong credentials do not reveal whether the account exists', weak.status === 401 && !/not found|no account|does not exist/i.test(await weak.text()));


    console.log('\n=== Session cookie and revocation ===');
    const email = `sec-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = 'SecureTest-2026';
    const signup = await fetch(BASE + '/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name: 'Sec Worker', role: 'worker' }),
    });
    const signupBody = await signup.json().catch(() => ({}));
    check('a new account can sign up with a strong password (201)', signup.status === 201, signupBody);
    const login = await fetch(BASE + '/api/auth/signin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const loginBody = await login.json().catch(() => ({}));
    const setCookie = login.headers.get('set-cookie') || '';
    check('sign-in sets the session cookie', /bounty_session=/.test(setCookie), setCookie);
    check('the session cookie is HttpOnly', /HttpOnly/i.test(setCookie));
    check('the session cookie is SameSite=Strict', /SameSite=Strict/i.test(setCookie));
    const cookie = (setCookie.match(/bounty_session=([^;]+)/) || [])[1];
    const token = loginBody.token;
    const viaCookie = await fetch(BASE + '/api/profile/me', { headers: { Cookie: 'bounty_session=' + cookie } });
    check('the cookie alone authenticates a request (200)', viaCookie.status === 200, viaCookie.status);
    const cross = await fetch(BASE + '/api/profile/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: 'bounty_session=' + cookie, Origin: 'https://evil.example' },
        body: JSON.stringify({ name: 'Hijacked' }),
    });
    check('a cross-site write using the cookie is refused (403)', cross.status === 403, cross.status);
    const noOriginWrite = await fetch(BASE + '/api/profile/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: 'Sec Worker' }),
    });
    check('an API client with a Bearer header is not blocked by the origin rule', noOriginWrite.status === 200, noOriginWrite.status);
    const escalate = await fetch(BASE + '/api/profile/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ is_admin: true, role: 'business', email_verified: true }),
    });
    const me = await (await fetch(BASE + '/api/profile/me', { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => ({}));
    check('a profile update cannot grant admin rights (mass assignment blocked)', me.is_admin !== true, me);
    check('a profile update cannot change the account role', me.role === 'worker', me.role);
    const adminRoute = await fetch(BASE + '/api/admin/reports', { headers: { Authorization: 'Bearer ' + token } });
    check('a worker is refused admin routes (403)', adminRoute.status === 403, adminRoute.status);
    const logout = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { Cookie: 'bounty_session=' + cookie } });
    check('logout succeeds and clears the cookie', logout.status === 200 && /bounty_session=;/.test(logout.headers.get('set-cookie') || ''));
    const replay = await fetch(BASE + '/api/profile/me', { headers: { Authorization: 'Bearer ' + token } });
    check('a token copied before logout is revoked (401)', replay.status === 401, replay.status);

    console.log('\n=== Token forgery ===');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const noneToken = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ sub: '00000000-0000-0000-0000-000000000001', iat: Math.floor(Date.now() / 1000), iss: 'bounty-api', aud: 'bounty-web' }) + '.';
    const forgedNone = await fetch(BASE + '/api/profile/me', { headers: { Authorization: 'Bearer ' + noneToken } });
    check('an unsigned (alg none) token is rejected (401)', forgedNone.status === 401, forgedNone.status);
    const wrongKey = require('crypto').createHmac('sha256', 'not-the-real-secret').update(b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: '00000000-0000-0000-0000-000000000001', iat: Math.floor(Date.now() / 1000), iss: 'bounty-api', aud: 'bounty-web' })).digest('base64url');
    const forgedKey = await fetch(BASE + '/api/profile/me', { headers: { Authorization: 'Bearer ' + b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: '00000000-0000-0000-0000-000000000001', iat: Math.floor(Date.now() / 1000), iss: 'bounty-api', aud: 'bounty-web' }) + '.' + wrongKey } });
    check('a token signed with the wrong key is rejected (401)', forgedKey.status === 401, forgedKey.status);

    console.log('\n=== Password policy ===');
    const weakCases = [
        ['too short', 'Short-1'],
        ['no number', 'NoNumbersHere'],
        ['no letter', '1234567890123'],
        ['over 72 bytes', 'a1' + 'x'.repeat(80)],
    ];
    for (const [label, pw] of weakCases) {
        const r = await fetch(BASE + '/api/auth/signup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `weak-${Date.now()}-${Math.random()}@example.com`, password: pw, name: 'Weak', role: 'worker' }),
        });
        check(`signup refuses a password that is ${label} (400)`, r.status === 400, r.status);
    }

    console.log('\n=== Injection and error handling ===');
    const sqli = await fetch(BASE + "/api/bounties?category=' OR '1'='1");
    check('SQL injection in a filter does not crash or leak (no 500)', sqli.status !== 500, sqli.status);
    const sqliId = await fetch(BASE + "/api/reputation/' OR '1'='1");
    check('SQL injection in a path id is refused (400)', sqliId.status === 400, sqliId.status);
    const broken = await fetch(BASE + '/api/auth/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    const brokenText = await broken.text();
    check('malformed JSON gets a clean 400 with no stack trace', broken.status === 400 && !/\n\s+at /.test(brokenText), brokenText.slice(0, 120));
    const boom = await fetch(BASE + '/api/no-such-route');
    const boomText = await boom.text();
    check('unknown routes return JSON without internals', boom.status === 404 && !/node_modules|\n\s+at /.test(boomText));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
