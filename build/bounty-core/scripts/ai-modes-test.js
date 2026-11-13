// scripts/ai-modes-test.js — the two non-trivial engines: our rules engine and Claude's Messages API.
// AI_MODE=rules (default): no model settings. Expects rules-based drafts and "not checked" for subjective criteria.
// AI_MODE=anthropic: server env AI_PROVIDER=anthropic AI_BASE_URL=http://localhost:4555 AI_API_KEY=test-key
//   AI_MODEL=mock-model (mock provider on 4555 answers /v1/messages). Expects model drafts and checks.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=rules node scripts/ai-modes-test.js
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG = process.env.LOG_FILE;
const MODE = process.env.AI_MODE || 'rules';
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
    const biz = await signupVerified(`modebiz+${stamp}@test.com`, 'business', 'Modes Biz');
    const worker = await signupVerified(`modew+${stamp}@test.com`, 'worker', 'Modes Worker');

    const status = await api('GET', '/api/ai/status', null, biz.token);
    if (MODE === 'rules') {
        ok('status says rules engine, no model', status.body.provider === 'rules' && status.body.model_connected === false, status.body);

        const brief = 'I need a simple landing page for my bakery. It must show the menu and opening hours, and include a contact form. Deliver the code in a GitHub repository.';
        const d = await api('POST', '/api/ai/bounty-draft', { prompt: brief }, biz.token);
        ok('rules draft answers 200 with source rules', d.status === 200 && d.body.source === 'rules', d.body);
        ok('rules draft picks the dev category', d.body.draft && d.body.draft.category === 'dev', d.body.draft && d.body.draft.category);
        ok('rules draft picks easy from the word "simple"', d.body.draft && d.body.draft.difficulty === 'easy');
        ok('rules draft picks GitHub when a repository is mentioned', d.body.draft && d.body.draft.submission_type === 'github');
        ok('rules draft turns requirements into criteria', d.body.draft && d.body.draft.acceptance_criteria.length >= 3);
        ok('rules draft asks for the missing reward', (d.body.draft.missing_info || []).some((m) => m.includes('Reward')) && (d.body.draft.questions || []).length >= 1, d.body);
        ok('rules draft suggests no reward (it cannot judge one)', d.body.draft.suggested_reward === null);

        const ambiguous = await api('POST', '/api/ai/bounty-draft', { prompt: 'Help me with my stuff, make it good.' }, biz.token);
        ok('vague goal still returns a draft with gaps listed', ambiguous.status === 200 && ambiguous.body.draft.missing_info.length >= 2, ambiguous.body);

        // Subjective criteria cannot be judged without a model
        const b = await api('POST', '/api/bounties', { title: 'Modes bounty ' + stamp, description: 'Bounty for the rules checker test.', category: 'dev', difficulty: 'easy', reward_amount: 20, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [{ text: 'Explains the design choices', rule: null }] }, biz.token);
        const sub = await api('POST', '/api/submissions', { bounty_id: b.body.id, title: 'Rules work', description: 'Built the page and tested it on phones.', github_link: 'https://github.com/example/rules' }, worker.token);
        const chk = await api('POST', `/api/ai/submissions/${sub.body.id}/check`, null, biz.token);
        const c1 = (chk.body.results || [])[0];
        ok('rules mode leaves subjective criteria not checked', c1 && c1.status === 'not_checked' && chk.body.ai_used === false, JSON.stringify(c1));
    } else {
        ok('status says anthropic provider with a model', status.body.provider === 'anthropic' && status.body.model_connected === true, status.body);

        const brief = 'A one-page site for a bakery with the menu and a contact form.';
        const d = await api('POST', '/api/ai/bounty-draft', { prompt: brief }, biz.token);
        ok('anthropic draft answers 200 with source ai', d.status === 200 && d.body.source === 'ai', d.body);
        ok('anthropic draft has a title and criteria', d.body.draft && d.body.draft.title.length > 0 && d.body.draft.acceptance_criteria.length >= 1);
        ok('anthropic draft usage is counted', d.body.usage && d.body.usage.used === 1, d.body.usage);

        const b = await api('POST', '/api/bounties', { title: 'Anthropic bounty ' + stamp, description: 'Bounty for the Anthropic checker test.', category: 'dev', difficulty: 'easy', reward_amount: 20, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [{ text: 'Explains the design choices', rule: null }] }, biz.token);
        const sub = await api('POST', '/api/submissions', { bounty_id: b.body.id, title: 'Anthropic work', description: 'Built the page and tested it on phones.', github_link: 'https://github.com/example/anth' }, worker.token);
        const chk = await api('POST', `/api/ai/submissions/${sub.body.id}/check`, null, biz.token);
        const c1 = (chk.body.results || [])[0];
        ok('anthropic checker answers subjective criteria', c1 && (c1.status === 'passed' || c1.status === 'possible_issue') && c1.source === 'ai', JSON.stringify(c1));
        ok('anthropic checker records AI use', chk.body.ai_used === true);
    }

    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} engine checks passed (AI_MODE=${MODE}).` : `\n${failed} of ${results.length} engine checks failed (AI_MODE=${MODE}).`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
