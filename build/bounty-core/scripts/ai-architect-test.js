// scripts/ai-architect-test.js — AI Task Architect, API level.
// Server env for AI_MODE=mock (default):
//   AI_BASE_URL=http://localhost:4555/v1 AI_API_KEY=test-key AI_MODEL=mock-model
//   AI_DAILY_LIMIT=6 AI_TIMEOUT_MS=3000   (with scripts/ai-mock-provider.js on port 4555)
// Server env for AI_MODE=unconfigured: no model settings (rules engine answers; model_connected=false).
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=mock node scripts/ai-architect-test.js
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
const MODE = process.env.AI_MODE || 'mock';
if (!LOG) { console.error('Set LOG_FILE to the server log.'); process.exit(1); }
const stamp = Date.now();
const results = [];
let failed = 0;

function ok(label, cond, extra) {
    results.push((cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
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
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    return { token: r.body.token, id: r.body.id, email, name, role };
}

const GOAL = 'I run a small bakery and need a one-page website with our menu, opening hours and a contact form.';

(async() => {
    const biz = await signupVerified(`aibiz+${stamp}@test.com`, 'business', 'AI Biz');
    const worker = await signupVerified(`aiw+${stamp}@test.com`, 'worker', 'AI Worker');

    const status = await api('GET', '/api/ai/status', null, biz.token);
    if (MODE === 'unconfigured') {
        ok('status reports rules mode with no model connected', status.body && status.body.enabled === true && status.body.provider === 'rules' && status.body.model_connected === false, status.body);
        const r = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL }, biz.token);
        ok('draft uses the rules engine and says so', r.status === 200 && r.body.source === 'rules' && r.body.usage === null, r);
        console.log(results.join('\n'));
        console.log(failed === 0 ? `\nAll ${results.length} AI checks passed (unconfigured).` : `\n${failed} of ${results.length} checks failed.`);
        process.exit(failed === 0 ? 0 : 1);
    }

    ok('status reports enabled with a limit of 6', status.body && status.body.enabled === true && status.body.limit === 6, status.body);

    const workerTry = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL }, worker.token);
    ok('workers cannot use the drafter (403)', workerTry.status === 403, workerTry);

    const short = await api('POST', '/api/ai/bounty-draft', { prompt: 'too short' }, biz.token);
    ok('very short prompt rejected (400)', short.status === 400, short);

    // 1. Normal draft
    const good = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL }, biz.token);
    ok('valid goal returns a draft (200)', good.status === 200, good.body);
    const d = good.body && good.body.draft;
    ok('draft has a title and description', d && d.title.length >= 3 && d.description.length >= 10, d);
    ok('category and difficulty come from the allowed lists', d && ['dev', 'design', 'content', 'marketing', 'other'].includes(d.category) && ['easy', 'medium', 'hard'].includes(d.difficulty), d);
    ok('submission type is one the drafter may use', d && ['github', 'url', 'text'].includes(d.submission_type), d);
    ok('criteria are normalized (link_host and min_words kept)', d && d.acceptance_criteria.length === 2 && d.acceptance_criteria[1].rule.type === 'min_words' && d.acceptance_criteria[1].rule.min === 20, d && d.acceptance_criteria);
    ok('suggested reward is shown as a suggestion with a note', d && d.suggested_reward && d.suggested_reward.amount === '15000.00' && d.suggested_reward.note, d && d.suggested_reward);
    ok('suggested deadline is a future ISO date', d && d.suggested_deadline && new Date(d.suggested_deadline).getTime() > Date.now(), d && d.suggested_deadline);
    ok('clarifying questions and missing info are returned', d && d.questions.length >= 1 && d.missing_info.length >= 1, d);
    ok('a clean draft has no issues', good.body && Array.isArray(good.body.issues) && good.body.issues.length === 0, good.body && good.body.issues);
    ok('usage counts the first call', good.body && good.body.usage.used === 1, good.body && good.body.usage);

    // 2. Malformed model output
    const bad = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL + ' MOCK_INVALID' }, biz.token);
    ok('non-JSON model output returns 422 with a clear message', bad.status === 422 && /expected format/.test(bad.body.message), bad);

    // 3. Slow provider
    const slow = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL + ' MOCK_SLOW' }, biz.token);
    ok('slow provider times out with 504', slow.status === 504, slow);

    // 4. Injection attempt: the model is told to set an absurd reward; the app must refuse it
    const inject = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL + ' MOCK_INJECT' }, biz.token);
    ok('injected reward is dropped, not used', inject.status === 200 && inject.body.draft.suggested_reward === null, inject.body);

    // 5. Daily cap (4 used so far, including failures; limit is 6)
    const s2 = await api('GET', '/api/ai/status', null, biz.token);
    ok('status counts failed attempts too (used 4, remaining 2)', s2.body.used === 4 && s2.body.remaining === 2, s2.body);
    await api('POST', '/api/ai/bounty-draft', { prompt: GOAL }, biz.token);
    await api('POST', '/api/ai/bounty-draft', { prompt: GOAL }, biz.token);
    const capped = await api('POST', '/api/ai/bounty-draft', { prompt: GOAL }, biz.token);
    ok('the request past the daily cap returns 429', capped.status === 429, capped);

    // 6. Publishing still goes through the normal create form path
    const created = await api('POST', '/api/bounties', {
        title: good.body.draft.title, description: good.body.draft.description, category: good.body.draft.category,
        difficulty: good.body.draft.difficulty, reward_amount: good.body.draft.suggested_reward.amount,
        deadline: good.body.draft.suggested_deadline, submission_type: good.body.draft.submission_type,
        requirements: good.body.draft.requirements, acceptance_criteria: good.body.draft.acceptance_criteria,
    }, biz.token);
    ok('an accepted draft publishes through the normal create route (201)', created.status === 201, created.body);

    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} AI checks passed.` : `\n${failed} of ${results.length} checks failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
