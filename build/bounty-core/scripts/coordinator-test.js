// scripts/coordinator-test.js — AI Project Coordinator: planning, approval, and live progress.
// AI_MODE=rules (default): no model settings. Plans come from the rules planner.
// AI_MODE=mock: server env AI_BASE_URL=http://localhost:4555/v1 AI_API_KEY=test-key AI_MODEL=mock-model
//   (mock provider on 4555 answers project plans). Plans come from the model path.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=rules node scripts/coordinator-test.js
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
const stateOf = (progress, idx) => progress.tasks[idx].state;
const byId = (progress, id) => progress.tasks.find((t) => t.id === id);

(async() => {
    const biz = await signupVerified(`coordbiz+${stamp}@test.com`, 'business', 'Coord Biz');
    const other = await signupVerified(`coordother+${stamp}@test.com`, 'business', 'Coord Other');
    const worker = await signupVerified(`coordw+${stamp}@test.com`, 'worker', 'Coord Worker');
    const stranger = await signupVerified(`coordx+${stamp}@test.com`, 'worker', 'Coord Stranger');

    // --- Planning
    const prompt = MODE === 'rules'
        ? 'Research the market, design a landing page, build it, test it and deliver the files for a coffee brand.'
        : 'A small website for a coffee brand, delivered in connected steps.';
    const plan = await api('POST', '/api/projects/plan', { prompt }, biz.token);
    ok('planning returns a draft (201)', plan.status === 201 && plan.body.status === 'draft', plan.body);
    const expectedSource = MODE === 'rules' ? 'rules' : 'ai';
    ok(`draft says where it came from (${expectedSource})`, plan.body.source === expectedSource, plan.body.source);
    const tasks = plan.body.plan.tasks;
    ok('draft has a chain of at least two dependent tasks', tasks.length >= 2 && tasks.slice(1).every((t, i) => t.depends_on.length === 1 && t.depends_on[0] === i), JSON.stringify(tasks.map((t) => t.depends_on)));
    ok('rewards are placeholders, marked in the description', tasks.every((t) => /Placeholder reward/.test(t.description) && Number(t.reward_amount) > 0));

    if (MODE === 'rules') {
        const again = await api('POST', '/api/projects/plan', { prompt: 'Launch a website.' }, biz.token);
        ok('a short brief still gets a usable default plan', again.status === 201 && again.body.plan.tasks.length >= 2, again.body);
    } else {
        const cyc = await api('POST', '/api/projects/plan', { prompt: 'MOCK_CYCLE build a small site for a coffee brand.' }, biz.token);
        ok('a model plan with a cycle is rejected (422) and nothing is stored', cyc.status === 422, cyc.body);
    }

    // --- Approval makes real bounties
    const approved = await api('POST', `/api/projects/plan/${plan.body.id}/approve`, { confirm_rewards: true }, biz.token);
    ok('approval creates the project (201)', approved.status === 201 && approved.body.task_ids.length === tasks.length, approved.body);
    const pid = approved.body.id;
    const taskIds = approved.body.task_ids;

    // --- Progress: initial state
    const p0 = await api('GET', `/api/projects/${pid}/progress`, null, biz.token);
    ok('owner sees progress (200)', p0.status === 200, p0.body);
    ok('first task is ready, the rest are blocked', byId(p0.body, taskIds[0]).state === 'ready' && taskIds.slice(1).every((id) => byId(p0.body, id).state === 'blocked'), JSON.stringify(p0.body.tasks.map((t) => t.state)));
    ok('progress starts at 0 percent', p0.body.percent === 0 && p0.body.completed === 0);
    ok('bottlenecks are open tasks that block others', p0.body.bottlenecks.length >= 1 && p0.body.bottlenecks.every((b) => b.blocks_count >= 1 && byId(p0.body, b.id).state !== 'completed'), JSON.stringify(p0.body.bottlenecks));
    ok('tasks are listed in project order', p0.body.tasks.map((t) => t.id).join() === taskIds.join(), JSON.stringify(p0.body.tasks.map((t) => t.title)));
    ok('blocked tasks with no work on their prerequisite are flagged', p0.body.missing_prerequisites.length >= 1, JSON.stringify(p0.body.missing_prerequisites));

    // --- Access control
    ok('a stranger cannot see progress (403)', (await api('GET', `/api/projects/${pid}/progress`, null, stranger.token)).status === 403);
    ok('a logged-out visitor cannot see progress (401)', (await api('GET', `/api/projects/${pid}/progress`)).status === 401);
    ok('bad project id is rejected (400)', (await api('GET', '/api/projects/not-an-id/progress', null, biz.token)).status === 400);

    // --- Backend enforces dependencies: work on task 2 is refused while task 1 is open
    const early = await api('POST', '/api/submissions', { bounty_id: taskIds[1], title: 'Too early', description: 'Trying to start the second step early, before the brief is done.', github_link: 'https://github.com/example/early' }, worker.token);
    ok('submitting to a blocked task is refused (409)', early.status === 409, early.body);

    // --- A worker submits on task 1; progress moves to under review
    const s1 = await api('POST', '/api/submissions', { bounty_id: taskIds[0], title: 'Brief written', description: 'Here is the brief for the brand and audience.', github_link: 'https://github.com/example/brief' }, worker.token);
    ok('worker submits on the first task', s1.status === 201, s1.body);
    const p1 = await api('GET', `/api/projects/${pid}/progress`, null, worker.token);
    ok('a worker on the project can see progress (200)', p1.status === 200, p1.body);
    ok('first task is under review after a submission', byId(p1.body, taskIds[0]).state === 'under_review' && byId(p1.body, taskIds[0]).submissions.pending === 1, JSON.stringify(byId(p1.body, taskIds[0])));

    // --- Owner approves; the next task becomes ready
    const ap = await api('POST', `/api/submissions/${s1.body.id}/approve`, null, biz.token);
    ok('owner approves the first task', ap.status === 200, ap.body);
    const p2 = await api('GET', `/api/projects/${pid}/progress`, null, biz.token);
    ok('first task is completed', byId(p2.body, taskIds[0]).state === 'completed');
    ok('second task becomes ready, third stays blocked', byId(p2.body, taskIds[1]).state === 'ready' && byId(p2.body, taskIds[2]).state === 'blocked', JSON.stringify(p2.body.tasks.map((t) => t.state)));
    ok('progress reflects one of the tasks done', p2.body.completed === 1 && p2.body.percent === Math.round(100 / tasks.length), JSON.stringify({ c: p2.body.completed, p: p2.body.percent }));

    // --- Owner-only detail: another business sees nothing
    ok('another business cannot see this project progress (403)', (await api('GET', `/api/projects/${pid}/progress`, null, other.token)).status === 403);

    console.log(results.join('\n'));
    console.log(failed === 0 ? `\nAll ${results.length} coordinator checks passed (AI_MODE=${MODE}).` : `\n${failed} of ${results.length} coordinator checks failed (AI_MODE=${MODE}).`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
