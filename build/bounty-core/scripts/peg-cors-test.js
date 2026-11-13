// scripts/peg-cors-test.js — pure tests for middleware/peg-cors.js (no server, no database).
// Run: npm run test:peg-cors
const test = require('node:test');
const assert = require('node:assert/strict');
const { pegCors, parseOrigins, safeOrigin } = require('../middleware/peg-cors');

const PEG = 'https://bounty-hospitality.workpeg.com';
const DEV = 'https://bounty-hospitality.dev.workpeg.com';

function fakeRes() {
    const headers = {};
    const res = {
        headers,
        statusCode: 200,
        ended: false,
        set(name, value) { headers[name.toLowerCase()] = value; return res; },
        vary(name) { headers.vary = name; return res; },
        status(code) { res.statusCode = code; return res; },
        end() { res.ended = true; return res; },
    };
    return res;
}

function run(origins, { url = '/api/peg/bounties', method = 'GET', origin } = {}) {
    const req = { originalUrl: url, method, headers: origin ? { origin } : {} };
    const res = fakeRes();
    let nextCalled = false;
    pegCors({ origins })(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

test('an allowed peg origin gets exact CORS headers and no credentials header', () => {
    const { res, nextCalled } = run(`${PEG},${DEV}`, { origin: PEG });
    assert.equal(nextCalled, true);
    assert.equal(res.headers['access-control-allow-origin'], PEG);
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    assert.equal(res.headers['access-control-allow-headers'], 'Authorization, Content-Type');
    assert.equal(res.headers.vary, 'Origin');
});

test('a preflight from an allowed origin answers 204 without reaching the routes', () => {
    const { res, nextCalled } = run(PEG, { method: 'OPTIONS', origin: PEG });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
    assert.equal(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
});

test('an unknown origin gets no allow header, and a preflight from it is refused', () => {
    const plain = run(PEG, { origin: 'https://evil.example' });
    assert.equal(plain.nextCalled, true);
    assert.equal(plain.res.headers['access-control-allow-origin'], undefined);

    const pre = run(PEG, { method: 'OPTIONS', origin: 'https://evil.example' });
    assert.equal(pre.res.statusCode, 403);
    assert.equal(pre.nextCalled, false);
});

test('a request with no origin gets no CORS headers', () => {
    const { res, nextCalled } = run(PEG, {});
    assert.equal(nextCalled, true);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('other Bounty routes are untouched', () => {
    const { res, nextCalled } = run(PEG, { url: '/api/bounties', origin: PEG });
    assert.equal(nextCalled, true);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers.vary, undefined);
});

test('wildcards, paths, credentials and plain http are refused', () => {
    assert.equal(safeOrigin('https://*.workpeg.com'), null);
    assert.equal(safeOrigin('https://bounty.workpeg.com/b/123'), null);
    assert.equal(safeOrigin('https://user:pass@bounty.workpeg.com'), null);
    assert.equal(safeOrigin('https://bounty.workpeg.com?x=1'), null);
    assert.equal(safeOrigin('http://bounty.workpeg.com'), null);
    assert.equal(safeOrigin('not a url'), null);
    assert.equal(safeOrigin('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(safeOrigin(PEG), PEG);
});

test('parseOrigins keeps the safe entries and drops the rest', () => {
    const set = parseOrigins(`${PEG}, http://bounty.workpeg.com ,*,${DEV}`);
    assert.deepEqual([...set].sort(), [DEV, PEG].sort());
    assert.equal(parseOrigins('').size, 0);
    assert.equal(parseOrigins(undefined).size, 0);
});
