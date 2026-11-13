// scripts/integration-test.js — Phase 7: one business and its workers go through all four AI features
// and the existing marketplace, over the real HTTP API.
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=rules|mock|anthropic|unconfigured node scripts/integration-test.js
// AI_MODE must match the server. Set AI_API_KEY_VALUE to the server's key to check it never leaks in a response.
// Run it on a fresh server. The auth limiter allows 100 sign-ups per 15 minutes per IP, so running many
// suites back to back on one server makes sign-ups fail with 429. Restart the server between suites.
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
const AI_MODE = process.env.AI_MODE || 'rules';
const MODEL_ON = AI_MODE === 'mock' || AI_MODE === 'anthropic';
const KEY_VALUE = process.env.AI_API_KEY_VALUE || '';
if (!LOG_FILE) { console.error('Set LOG_FILE to the server log.'); process.exit(1); }

const results = [];
let failed = 0;
const bodies = []; // every response body, for the cross-cutting leak checks
function ok(label, cond, extra) {
    results.push((cond ? 'PASS ' : 'FAIL ') + label + (extra && !cond ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
    if (!cond) failed += 1;
}
async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    bodies.push(text);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
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
    await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    return { token: r.body.token, id: r.body.id, email, name };
}
const words = (n) => Array.from({ length: n }, (_, i) => 'word' + (i % 9)).join(' ');

(async() => {
    const stamp = Date.now();
    const biz = await signupVerified(`intbiz+${stamp}@test.com`, 'business', 'Bakehouse Co');
    const otherBiz = await signupVerified(`intbiz2+${stamp}@test.com`, 'business', 'Rival Co');
    const w1 = await signupVerified(`intw1+${stamp}@test.com`, 'worker', 'Ada Okoro');
    const w2 = await signupVerified(`intw2+${stamp}@test.com`, 'worker', 'Ben Eze');

    // ---------------------------------------------------- 1. Task Architect -> normal bounty creation
    const draft = await api('POST', '/api/ai/bounty-draft', { prompt: 'Landing page for a bakery with a menu section and a contact form' }, biz.token);
    ok('architect: business gets a draft (200)', draft.status === 200 && draft.body && draft.body.draft, draft.body);
    const d = (draft.body && draft.body.draft) || { acceptance_criteria: [], title: '', description: '', category: 'dev', difficulty: 'easy', submission_type: 'text' };
    ok('architect: draft has a title and at least one criterion', d && d.title && d.acceptance_criteria && d.acceptance_criteria.length >= 1, draft.body);
    ok(`architect: draft source is "${MODEL_ON ? 'ai' : 'rules'}" for ${AI_MODE}`, draft.body && draft.body.source === (MODEL_ON ? 'ai' : 'rules'), draft.body);

    const noAuthPublish = await api('POST', '/api/bounties', { title: 'Ghost task', description: 'Should never be posted.', category: 'dev', difficulty: 'easy', reward_amount: 100, deadline: inDays(5), submission_type: 'text' });
    ok('a draft cannot be published without signing in (401)', noAuthPublish.status === 401, noAuthPublish.body);
    const workerPublish = await api('POST', '/api/bounties', { title: 'Worker task', description: 'Workers cannot post bounties.', category: 'dev', difficulty: 'easy', reward_amount: 100, deadline: inDays(5), submission_type: 'text' }, w1.token);
    ok('a worker cannot publish a bounty (403)', workerPublish.status === 403, workerPublish.body);
    const badReward = await api('POST', '/api/bounties', { title: d.title, description: d.description, category: d.category, difficulty: d.difficulty, reward_amount: 0, deadline: inDays(5), submission_type: d.submission_type, acceptance_criteria: d.acceptance_criteria }, biz.token);
    ok('the server still validates a draft: reward 0 is refused (400)', badReward.status === 400, badReward.body);

    const publish = await api('POST', '/api/bounties', {
        title: d.title, description: d.description, category: d.category, difficulty: d.difficulty,
        reward_amount: 150, deadline: inDays(6), submission_type: d.submission_type,
        requirements: d.requirements || [], acceptance_criteria: d.acceptance_criteria,
    }, biz.token);
    ok('the business reviews and publishes the draft with its own reward (201)', publish.status === 201 && publish.body.id, publish.body);
    const solo = publish.body && publish.body.id;
    const soloBounty = await api('GET', `/api/bounties/${solo}`);
    ok('the published task keeps the acceptance criteria', soloBounty.status === 200 && (soloBounty.body.acceptance_criteria || []).length === d.acceptance_criteria.length, soloBounty.body);

    // ---------------------------------------------------- 2. Project Coordinator
    const plan = await api('POST', '/api/projects/plan', { prompt: 'Coffee brand website: research the brand, design the pages, build the site, test it and deliver the final files' }, biz.token);
    ok('coordinator: business gets a project plan (201)', plan.status === 201 && plan.body.plan && plan.body.plan.tasks, plan.body);
    ok(`coordinator: plan source is "${MODEL_ON ? 'ai' : 'rules'}" for ${AI_MODE}`, plan.body && plan.body.source === (MODEL_ON ? 'ai' : 'rules'), plan.body);
    ok('coordinator: plan has between 2 and 12 tasks', plan.body && plan.body.plan.tasks.length >= 2 && plan.body.plan.tasks.length <= 12, plan.body && plan.body.plan.tasks.length);
    const workerPlan = await api('POST', '/api/projects/plan', { prompt: 'Coffee brand website: research and build' }, w1.token);
    ok('a worker cannot plan a project (403)', workerPlan.status === 403, workerPlan.body);

    const approve = await api('POST', `/api/projects/plan/${plan.body.id}/approve`, { confirm_rewards: true }, biz.token);
    ok('coordinator: approving the plan creates the project', (approve.status === 200 || approve.status === 201) && approve.body.id, approve.body);
    const projectId = approve.body.id;
    const again = await api('POST', `/api/projects/plan/${plan.body.id}/approve`, {}, biz.token);
    ok('approving the same plan twice does not create a second project', again.body && again.body.already_approved === true && again.body.id === projectId, again.body);

    const progress = await api('GET', `/api/projects/${projectId}/progress`, null, biz.token);
    ok('progress: the business sees the project progress (200)', progress.status === 200 && progress.body.tasks.length === plan.body.plan.tasks.length, progress.body);
    const root = progress.body.tasks[0];
    ok('progress: the first task is ready, not blocked', root && root.state === 'ready', root);
    ok('progress: later tasks wait on earlier ones', progress.body.tasks.slice(1).every((t) => t.state === 'blocked'), progress.body.tasks.map((t) => t.state));
    const otherView = await api('GET', `/api/projects/${projectId}/progress`, null, w2.token);
    ok('a worker with no submission on the project cannot see its progress (403)', otherView.status === 403, otherView.body);

    // ---------------------------------------------------- 3. Dependencies gate submissions
    const second = progress.body.tasks[1];
    const bountyFor = async (id) => (await api('GET', `/api/bounties/${id}`)).body;
    const secondBounty = await bountyFor(second.id);
    const blockedSubmit = await api('POST', '/api/submissions', { bounty_id: second.id, title: 'Too early', description: words(40), github_link: 'https://github.com/example/bakery' }, w1.token);
    ok('a task waiting on another task refuses an early submission (409)', blockedSubmit.status === 409, blockedSubmit.body);

    const rootBounty = await bountyFor(root.id);
    const link = rootBounty.submission_type === 'text' ? undefined : 'https://github.com/example/bakery-root';
    const rootSub = await api('POST', '/api/submissions', { bounty_id: root.id, title: 'Brand brief', description: words(60), github_link: link }, w1.token);
    ok('the worker submits to the ready task (201)', rootSub.status === 201 && rootSub.body.id, rootSub.body);
    const rootSubId = rootSub.body && rootSub.body.id;

    // ---------------------------------------------------- 4. Submission Checker: advisory, never automatic
    const check = await api('POST', `/api/ai/submissions/${rootSubId}/check`, {}, biz.token);
    ok('checker: business runs the checks (201)', check.status === 201 && Array.isArray(check.body.criteria || check.body.results), check.body);
    const allowedStatuses = ['confirmed_fail', 'possible_issue', 'passed', 'not_checked'];
    const crit = (check.body && (check.body.criteria || check.body.results)) || [];
    ok('checker: every finding has a known status', crit.length > 0 && crit.every((c) => allowedStatuses.includes(c.status)), crit);
    const mineAfterCheck = await api('GET', '/api/submissions/mine', null, w1.token);
    const stillPending = (mineAfterCheck.body || []).find((s) => s.id === rootSubId);
    ok('checker does not reject or approve anything by itself', stillPending && stillPending.status === 'pending', stillPending);
    const checkWorker = await api('POST', `/api/ai/submissions/${rootSubId}/check`, {}, w1.token);
    ok('a worker cannot run the checker (403)', checkWorker.status === 403, checkWorker.body);
    const checkOther = await api('POST', `/api/ai/submissions/${rootSubId}/check`, {}, otherBiz.token);
    ok('another business cannot check this submission (403)', checkOther.status === 403, checkOther.body);
    const readCheck = await api('GET', `/api/ai/submissions/${rootSubId}/check`, null, biz.token);
    ok('the saved check report can be read back by the owner (200)', readCheck.status === 200, readCheck.body);

    // ---------------------------------------------------- 5. Human approval unlocks the next task
    const approveSub = await api('POST', `/api/submissions/${rootSubId}/approve`, {}, biz.token);
    ok('the business approves the submission (200)', approveSub.status === 200, approveSub.body);
    const after = await api('GET', `/api/projects/${projectId}/progress`, null, biz.token);
    ok('progress: the finished task counts as completed', after.body.completed === 1 && after.body.percent > 0, after.body);
    ok('progress: the next task is now ready', after.body.tasks[1].state === 'ready', after.body.tasks[1]);
    const nextBounty = await bountyFor(second.id);
    const nextLink = nextBounty.submission_type === 'text' ? undefined : 'https://github.com/example/bakery-site';
    const nextSub = await api('POST', '/api/submissions', { bounty_id: second.id, title: 'Site build', description: words(60), github_link: nextLink }, w1.token);
    ok('the worker can now submit to the next task (201)', nextSub.status === 201, nextSub.body);

    // ---------------------------------------------------- 6. Proof-of-Ability: only shown, approved work
    const hidden = await api('POST', '/api/ai/proof-of-ability/generate', {}, w1.token);
    ok('portfolio: with nothing shown, the draft cites no work', hidden.status === 200 && hidden.body.verified.length === 0 && hidden.body.usage === null, hidden.body);
    const show = await api('PATCH', `/api/portfolio/submissions/${rootSubId}`, { visible: true }, w1.token);
    ok('portfolio: the worker shows the approved work (200)', show.status === 200 && show.body.portfolio_visible === true, show.body);
    const pendingShow = await api('PATCH', `/api/portfolio/submissions/${nextSub.body.id}`, { visible: true }, w1.token);
    ok('portfolio: work that is not yet approved cannot be shown (409)', pendingShow.status === 409, pendingShow.body);
    const draftWork = await api('POST', '/api/ai/proof-of-ability/generate', {}, w1.token);
    ok('portfolio: draft is built from the one shown item', draftWork.status === 200 && draftWork.body.verified.length === 1 && draftWork.body.verified[0].id === rootSubId, draftWork.body);
    ok(`portfolio: draft source is "${MODEL_ON ? 'ai' : 'rules'}" for ${AI_MODE}`, draftWork.body.source === (MODEL_ON ? 'ai' : 'rules'), draftWork.body);
    ok('portfolio: draft has no links', !/https?:\/\/|@/i.test(draftWork.body.summary), draftWork.body.summary);
    const saveSummary = await api('PUT', '/api/portfolio/me/summary', { summary: 'Brand briefs and site builds for small food businesses.' }, w1.token);
    ok('portfolio: the worker saves their summary (200)', saveSummary.status === 200, saveSummary.body);
    const pub = await api('GET', `/api/profile/worker/${w1.id}`);
    ok('public profile: shows the verified work and the saved summary',
        pub.status === 200 && pub.body.portfolio.items.length === 1 && pub.body.portfolio.summary !== null, pub.body && pub.body.portfolio);
    const w2Draft = await api('POST', '/api/ai/proof-of-ability/generate', {}, w2.token);
    ok('portfolio: a worker with no shown work gets an honest empty draft', w2Draft.status === 200 && w2Draft.body.verified.length === 0, w2Draft.body);

    // ---------------------------------------------------- 7. Existing marketplace still works
    const list = await api('GET', '/api/bounties');
    ok('marketplace: the published task appears in the public list (200)', list.status === 200 && JSON.stringify(list.body).includes(solo), list.status);
    const dashBiz = await api('GET', `/api/dashboard/${biz.id}`, null, biz.token);
    ok('marketplace: the business dashboard loads (200)', dashBiz.status === 200, dashBiz.body);
    const dashWorker = await api('GET', `/api/dashboard/${w1.id}`, null, w1.token);
    ok('marketplace: the worker dashboard loads (200)', dashWorker.status === 200, dashWorker.body);
    const message = await api('POST', `/api/bounties/${root.id}/messages`, { body: 'Thanks, the brief is clear.' }, w1.token);
    ok('marketplace: the task workspace accepts a message from a worker with a submission (201)', message.status === 201, message.body);
    const reject = await api('POST', `/api/submissions/${nextSub.body.id}/reject`, { reason: 'The second step needs the agreed format.' }, w2.token);
    ok('marketplace: a worker cannot approve or reject (403)', reject.status === 403, reject.body);

    // ---------------------------------------------------- 8. Cross-cutting privacy and secrets
    const everything = bodies.join('\n');
    ok('no password hash appears in any response', !/\$2[aby]\$\d\d\$/.test(everything), null);
    ok('no password appears in any response', !everything.includes('password123'), null);
    if (KEY_VALUE) ok('the AI provider key never appears in any response', !everything.includes(KEY_VALUE), null);
    const publicBodies = [JSON.stringify(pub.body), JSON.stringify(list.body)].join('\n');
    ok('public pages do not show any account email', ![biz, w1, w2, otherBiz].some((u) => publicBodies.includes(u.email)), null);
    ok('public pages do not show earnings fields', !publicBodies.includes('total_earned'), null);

    console.log(results.join('\n'));
    if (failed) { console.error(`\n${failed} of ${results.length} integration checks failed (AI_MODE=${AI_MODE}).`); process.exit(1); }
    console.log(`\nAll ${results.length} integration checks passed (AI_MODE=${AI_MODE}).`);
})().catch((err) => { console.error(err); process.exit(1); });
