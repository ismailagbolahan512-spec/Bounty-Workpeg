// scripts/project-test.js — projects, dependencies, criteria, revisions and AI planning.
//
// Two server configurations are tested:
//   AI_MODE=unconfigured  server started WITHOUT AI_PROVIDER_URL or model settings. /plan uses the rules planner.
//   AI_MODE=mock          server started WITH AI_PROVIDER_URL=http://127.0.0.1:4555/plan.
//                         This script starts a stub provider on port 4555 and checks the draft path.
//
// Usage:
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=unconfigured node scripts/project-test.js
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log AI_MODE=mock node scripts/project-test.js
// Exits with code 1 on the first failed check.

const fs = require('fs');
const http = require('http');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
const AI_MODE = process.env.AI_MODE || 'unconfigured';
if (!LOG_FILE) {
    console.error('Set LOG_FILE to the server log, so the test can read dev emails.');
    process.exit(1);
}
if (!['unconfigured', 'mock'].includes(AI_MODE)) {
    console.error('AI_MODE must be "unconfigured" or "mock"');
    process.exit(1);
}

let passed = 0;
function check(label, condition, detail) {
    if (!condition) {
        console.error(`✗ ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
        process.exit(1);
    }
    passed += 1;
    console.log(`✓ ${label}`);
}

async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, body: data };
}

function tokenFromLog(to, marker) {
    const log = fs.readFileSync(LOG_FILE, 'utf8');
    const blocks = log.split('--- [dev email, not sent]').slice(1);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.includes(`to: ${to}`) && block.includes(marker)) {
            const m = block.match(/token=([0-9a-f]{64})/);
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
    if (r.status !== 201) throw new Error(`signup failed for ${email}: ${JSON.stringify(r.body)}`);
    await sleep(200);
    return r.body.token;
}

function task(title, extra = {}) {
    return {
        title,
        description: `Work item: ${title}. Describe the deliverable clearly.`,
        category: 'dev',
        difficulty: 'easy',
        reward_amount: 100,
        deadline: inDays(7),
        submission_type: 'github',
        ...extra,
    };
}

function startMockProvider() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            const plan = {
                title: 'Launch a landing page',
                description: `Plan for: ${parsed.prompt || 'a landing page'}`,
                tasks: [
                    task('Write the copy', { category: 'content', submission_type: 'text', difficulty: 'easy', reward_amount: 50,
                        acceptance_criteria: [{ text: 'At least 150 words', rule: { type: 'min_words', min: 150 } }] }),
                    task('Build the page', { difficulty: 'medium', reward_amount: 200, depends_on: [0] }),
                    task('QA the page', { difficulty: 'easy', reward_amount: 80, depends_on: [1] }),
                ],
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(plan));
        });
    });
    return new Promise((resolve) => server.listen(4555, '127.0.0.1', () => resolve(server)));
}

(async() => {
    const stamp = Date.now();
    const mock = AI_MODE === 'mock' ? await startMockProvider() : null;

    const biz = await signupVerified(`pbiz+${stamp}@test.com`, 'business', 'Project Biz');
    const biz2 = await signupVerified(`pbiz2+${stamp}@test.com`, 'business', 'Other Biz');
    const w1 = await signupVerified(`pw1+${stamp}@test.com`, 'worker', 'Worker One');
    const w2 = await signupVerified(`pw2+${stamp}@test.com`, 'worker', 'Worker Two');
    const unverified = await api('POST', '/api/auth/signup', { email: `punv+${stamp}@test.com`, password: 'password123', name: 'Unverified', role: 'business' });

    // --- permissions
    const unverifiedCreate = await api('POST', '/api/projects', { title: 'Nope', description: 'Nope nope nope', tasks: [task('x task')] }, unverified.body.token);
    check('business signup can create a project right away (201)', unverifiedCreate.status === 201, unverifiedCreate.body);
    const workerCreate = await api('POST', '/api/projects', { title: 'Nope', description: 'Nope nope nope', tasks: [task('x task')] }, w1);
    check('worker cannot create a project (403)', workerCreate.status === 403, workerCreate.body);

    // --- cycle and self-dependency rejection
    const cyclic = await api('POST', '/api/projects', {
        title: 'Cyclic plan', description: 'Two tasks waiting on each other.',
        tasks: [task('First step', { depends_on: [1] }), task('Second step', { depends_on: [0] })],
    }, biz);
    check('cyclic dependencies are rejected (400)', cyclic.status === 400 && /cycle/i.test(cyclic.body.message), cyclic.body);
    const selfDep = await api('POST', '/api/projects', {
        title: 'Self plan', description: 'A task waiting on itself.',
        tasks: [task('Lonely step', { depends_on: [0] })],
    }, biz);
    check('self-dependency is rejected (400)', selfDep.status === 400 && /itself/.test(selfDep.body.message), selfDep.body);
    const missingDep = await api('POST', '/api/projects', {
        title: 'Missing plan', description: 'Depends on a task that does not exist.',
        tasks: [task('Only step', { depends_on: [5] })],
    }, biz);
    check('dependency on a missing task index is rejected (400)', missingDep.status === 400, missingDep.body);

    // --- a valid three-task chain: A -> B -> C
    const created = await api('POST', '/api/projects', {
        title: 'Storefront rebuild', description: 'Rebuild the storefront in three steps.',
        tasks: [
            task('Design the catalog', { category: 'design' }),
            task('Build the catalog', { depends_on: [0], reward_amount: 300 }),
            task('Test the catalog', { depends_on: [1], reward_amount: 120 }),
        ],
    }, biz);
    check('valid project is created (201) with 3 task ids', created.status === 201 && created.body.task_ids.length === 3, created.body);
    const projectId = created.body.id;
    const [taskA, taskB, taskC] = created.body.task_ids;

    const detail = await api('GET', `/api/projects/${projectId}`);
    check('project detail is public and lists 3 tasks', detail.status === 200 && detail.body.tasks.length === 3, detail.body);
    const byId = Object.fromEntries(detail.body.tasks.map((t) => [t.id, t]));
    check('only the first task is unblocked', !byId[taskA].blocked && byId[taskB].blocked && byId[taskC].blocked, detail.body.tasks);

    const bountyDetail = await api('GET', `/api/bounties/${taskB}`);
    check('bounty detail exposes project_id and blocked dependencies', bountyDetail.body.project_id === projectId && bountyDetail.body.blocked === true && bountyDetail.body.depends_on.length === 1, bountyDetail.body);

    // --- eligibility: B waits for A
    const early = await api('POST', '/api/submissions', { bounty_id: taskB, title: 'Early work', description: 'Trying to start before the first task is done.', github_link: 'https://github.com/example/work'  }, w1);
    check('submission to a blocked task is rejected (409)', early.status === 409 && /waits for other tasks/.test(early.body.message), early.body);

    const subA = await api('POST', '/api/submissions', { bounty_id: taskA, title: 'Catalog design', description: 'Design delivered as a document.', github_link: 'https://github.com/example/catalog' }, w1);
    check('worker can submit to the unblocked task (201)', subA.status === 201, subA.body);
    const approveA = await api('POST', `/api/submissions/${subA.body.id}/approve`, null, biz);
    check('owner approves task A (200)', approveA.status === 200, approveA.body);

    const subB = await api('POST', '/api/submissions', { bounty_id: taskB, title: 'Catalog build', description: 'Catalog built and deployed to staging.', github_link: 'https://github.com/example/catalog-build' }, w2);
    check('task B opens once task A is completed (201)', subB.status === 201, subB.body);

    // --- acceptance criteria on a single-task bounty
    const badRule = await api('POST', '/api/bounties', {
        title: 'Criteria test bounty', description: 'A bounty with an invalid criterion rule.',
        category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github',
        acceptance_criteria: [{ text: 'Bad rule', rule: { type: 'magic' } }],
    }, biz);
    check('unknown criterion rule type is rejected (400)', badRule.status === 400, badRule.body);

    const single = await api('POST', '/api/bounties', {
        title: 'Single task bounty', description: 'A plain one-off bounty with no project.',
        category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github',
        acceptance_criteria: [
            { text: 'Write at least five words', rule: { type: 'min_words', min: 5 } },
            { text: 'Link to a GitHub repo', rule: { type: 'link_host', hosts: ['github.com'] } },
            { text: 'Code is readable', rule: null },
        ],
    }, biz);
    check('single-task bounty still creates with criteria (201)', single.status === 201 && single.body.acceptance_criteria.length === 3, single.body);
    const plain = await api('POST', '/api/bounties', {
        title: 'Plain bounty', description: 'No criteria given at all here.',
        category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github',
    }, biz);
    check('bounty without criteria stores an empty list', plain.status === 201 && Array.isArray(plain.body.acceptance_criteria) && plain.body.acceptance_criteria.length === 0, plain.body);

    const sub = await api('POST', '/api/submissions', { bounty_id: single.body.id, title: 'Quick fix', description: 'Fixed it now. Tested and ready for review by the business.', github_link: 'https://example.com/fix' }, w1);
    check('submission to criteria bounty (201)', sub.status === 201, sub.body);
    const checks = await api('GET', `/api/submissions/${sub.body.id}/checks`, null, biz);
    const r = checks.body.results || [];
    check('checks report pass (word count), fail (link host) and subjective with no auto-reject',
        checks.status === 200 && checks.body.overall === 'needs_attention' && r[0].result === 'pass' && r[1].result === 'fail' && r[2].result === 'subjective',
        checks.body);
    const subStatus = await api('GET', `/api/submissions/bounty/${single.body.id}`, null, biz);
    check('a failed check does not reject the submission', subStatus.body[0].status === 'pending', subStatus.body);

    const checksOther = await api('GET', `/api/submissions/${sub.body.id}/checks`, null, biz2);
    check('another business cannot read checks (403)', checksOther.status === 403, checksOther.body);

    // --- revisions
    const revNoNotes = await api('POST', `/api/submissions/${sub.body.id}/request-revision`, { notes: 'x' }, biz);
    check('revision request needs an explanation (400)', revNoNotes.status === 400, revNoNotes.body);
    const revOther = await api('POST', `/api/submissions/${sub.body.id}/request-revision`, { notes: 'Please add tests for the change.' }, biz2);
    check('another business cannot request revisions (403)', revOther.status === 403, revOther.body);

    const rev = await api('POST', `/api/submissions/${sub.body.id}/request-revision`, { notes: 'Please add tests for the change.' }, biz);
    check('owner requests revisions (200)', rev.status === 200 && rev.body.status === 'revision_requested', rev.body);
    const mine = await api('GET', '/api/submissions/mine', null, w1);
    const mineRow = (mine.body || []).find((s) => s.id === sub.body.id);
    check('worker sees the revision notes', mineRow && mineRow.revision_notes === 'Please add tests for the change.' && mineRow.status === 'revision_requested', mineRow);

    const resubOther = await api('POST', `/api/submissions/${sub.body.id}/resubmit`, { title: 'Quick fix v2', description: 'Now with tests included. Tested and ready for review by the business.', github_link: 'https://github.com/example/work'  }, w2);
    check('another worker cannot resubmit (403)', resubOther.status === 403, resubOther.body);

    const resub = await api('POST', `/api/submissions/${sub.body.id}/resubmit`, { title: 'Quick fix v2', description: 'Now with tests included, as requested.', github_link: 'https://github.com/example/fix' }, w1);
    check('worker resubmits the same row (200, pending)', resub.status === 200 && resub.body.id === sub.body.id && resub.body.status === 'pending', resub.body);
    const resubAgain = await api('POST', `/api/submissions/${sub.body.id}/resubmit`, { title: 'Quick fix v3', description: 'Trying to resubmit while pending.', github_link: 'https://github.com/example/work'  }, w1);
    check('resubmit while pending is rejected (409)', resubAgain.status === 409, resubAgain.body);

    const approveSingle = await api('POST', `/api/submissions/${sub.body.id}/approve`, null, biz);
    check('owner approves the resubmitted work (200)', approveSingle.status === 200 && approveSingle.body.status === 'approved', approveSingle.body);

    // --- AI planning
    const planNoAi = await api('POST', '/api/projects/plan', { prompt: 'Launch a landing page for a coffee brand.' }, biz);
    if (AI_MODE === 'unconfigured') {
        check('planning falls back to the rules planner when no model is set (201, source rules)', planNoAi.status === 201 && planNoAi.body.source === 'rules' && planNoAi.body.plan.tasks.length >= 2, planNoAi.body);
        const shortPrompt = await api('POST', '/api/projects/plan', { prompt: 'short' }, biz);
        check('AI planning validates the prompt first (400)', shortPrompt.status === 400, shortPrompt.body);
    } else {
        check('AI planning returns a draft when a provider is configured (201)', planNoAi.status === 201 && planNoAi.body.status === 'draft', planNoAi.body);
        const draftId = planNoAi.body.id;
        check('draft has 3 tasks with a dependency chain', planNoAi.body.plan.tasks.length === 3 && planNoAi.body.plan.tasks[2].depends_on.length === 1, planNoAi.body.plan);

        const hidden = await api('POST', `/api/projects/plan/${draftId}/approve`, null, biz2);
        check('another business cannot approve the draft (404)', hidden.status === 404, hidden.body);

        const badEdit = await api('POST', `/api/projects/plan/${draftId}/approve`, {
            plan: { title: 'Edited', description: 'Edited with a cycle inside.', tasks: [task('One', { depends_on: [1] }), task('Two', { depends_on: [0] })] },
        }, biz);
        check('an edited plan is validated again on approve (400, nothing created)', badEdit.status === 400, badEdit.body);

        const hasPlaceholder = planNoAi.body.plan.tasks.some((t) => Number(t.reward_amount) === 5000);
        if (hasPlaceholder) {
            const unconfirmed = await api('POST', `/api/projects/plan/${draftId}/approve`, null, biz);
            check('approval is refused (409) while tasks still use the placeholder reward', unconfirmed.status === 409 && /placeholder reward/.test(unconfirmed.body.message), unconfirmed.body);
        }
        const approved = await api('POST', `/api/projects/plan/${draftId}/approve`, { confirm_rewards: true }, biz);
        check('approving the draft creates the project (201)', approved.status === 201 && approved.body.task_ids.length === 3, approved.body);
        const again = await api('POST', `/api/projects/plan/${draftId}/approve`, null, biz);
        check('approving twice is idempotent (same project, no duplicates)', again.status === 200 && again.body.already_approved === true && again.body.id === approved.body.id, again.body);

        const aiDetail = await api('GET', `/api/projects/${approved.body.id}`);
        check('AI-created project is a real project with dependencies', aiDetail.status === 200 && aiDetail.body.tasks.length === 3, aiDetail.body);
        mock.close();
    }

    console.log(`\nAll ${passed} checks passed (AI_MODE=${AI_MODE}).`);
    process.exit(0);
})().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
