// scripts/phase3-test.js — Phase 3: matching, practical skill assessments, workspace deliverables
// and profile fields. API checks, access control, validation and concurrency.
//
// Usage:
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase3-test.js
// Exits with code 1 on the first failed check.

const fs = require('fs');
const { Pool } = require('pg');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) {
    console.error('Set LOG_FILE to the server log, so the test can read dev emails.');
    process.exit(1);
}
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });

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
    return { status: res.status, body: await res.json().catch(() => null) };
}

function tokenFromLog(to, marker) {
    const blocks = fs.readFileSync(LOG_FILE, 'utf8').split('--- [dev email, not sent]').slice(1);
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].includes(`to: ${to}`) && blocks[i].includes(marker)) {
            const m = blocks[i].match(/token=([0-9a-f]{64})/);
            if (m) return m[1];
        }
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const stamp = Date.now();
const SHOP = 'Build the checkout flow with payment steps, unit tests and a short write-up for review.';
const WORK = 'I built the checkout flow, wrote unit tests for each payment step, and documented how the flow handles failures.';
const RUBRIC = [
    { text: 'Explains the approach in clear steps', points: 40 },
    { text: 'Includes tests that pass on the submitted code', points: 50 },
];

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
    const v = await api('POST', '/api/auth/verify', { token: tokenFromLog(email, 'verify?token=') });
    if (v.status !== 200) throw new Error(`verify failed for ${email}: ${JSON.stringify(v.body)}`);
    return r.body.token;
}
const uid = async(token) => (await api('GET', '/api/profile/me', null, token)).body.id;

(async() => {
    const biz = await signupVerified(`p3-biz+${stamp}@test.com`, 'business', 'Phase Three Biz');
    const w1 = await signupVerified(`p3-w1+${stamp}@test.com`, 'worker', 'Worker One');
    const w2 = await signupVerified(`p3-w2+${stamp}@test.com`, 'worker', 'Worker Two');
    const outsider = await signupVerified(`p3-out+${stamp}@test.com`, 'worker', 'Outsider');
    const adminToken = await signupVerified(`p3-admin+${stamp}@test.com`, 'business', 'Platform Admin');
    const adminId = await uid(adminToken);
    await db.query('UPDATE users SET is_admin = true WHERE id = $1', [adminId]);
    const admin = (await api('POST', '/api/auth/signin', { email: `p3-admin+${stamp}@test.com`, password: 'password123' })).body.token;
    const w1Id = await uid(w1);
    const w2Id = await uid(w2);
    const outId = await uid(outsider);

    // ---------------------------------------------------------------- profile fields
    check('a timezone that is not an IANA name is refused (400)', (await api('PATCH', '/api/profile/me', { timezone: 'Mars/Olympus' }, w1)).status === 400);
    const tz = await api('PATCH', '/api/profile/me', { timezone: 'Europe/London', languages: ['English', ' French ', 'English'], weekly_hours: 20, available_from: '2027-01-15', discoverable: true }, w1);
    check('a worker saves timezone, languages, hours, start date and opt-in', tz.status === 200, tz.body);
    check('the saved languages are de-duplicated and trimmed', JSON.stringify(tz.body.languages) === JSON.stringify(['English', 'French']), tz.body.languages);
    check('the start date is returned as a plain date', tz.body.available_from === '2027-01-15', tz.body.available_from);
    check('discoverable is opt-in and now true for this worker', tz.body.discoverable === true);
    check('more than 10 languages are refused (400)', (await api('PATCH', '/api/profile/me', { languages: Array.from({ length: 11 }, (_, i) => 'L' + i) }, w1)).status === 400);
    check('weekly hours above 80 are refused (400)', (await api('PATCH', '/api/profile/me', { weekly_hours: 81 }, w1)).status === 400);
    check('an impossible start date is refused (400)', (await api('PATCH', '/api/profile/me', { available_from: '2026-13-45' }, w1)).status === 400);
    check('discoverable must be a boolean (400)', (await api('PATCH', '/api/profile/me', { discoverable: 'yes' }, w1)).status === 400);
    check('a worker who has not opted in is not discoverable by default', (await api('GET', '/api/profile/me', null, w2)).body.discoverable === false);

    // ---------------------------------------------------------------- assessments
    const badRubric = await api('POST', '/api/assessments', { category: 'dev', difficulty: 'easy', title: 'Checkout test', description: 'A short practical check of checkout code and tests.', instructions: 'Build the checkout function and tests as described.', submission_requirements: 'A link to the repository and a short note.', rubric: [{ text: 'Only one point here', points: 5 }] }, admin);
    check('an assessment needs at least two rubric points (400)', badRubric.status === 400, badRubric.body);
    const assessmentBody = (title) => ({ category: 'dev', difficulty: 'easy', title, description: 'A short practical check of checkout code and its tests for review.', instructions: 'Build the checkout function and write tests for each payment step as described.', submission_requirements: 'A link to the repository and a short written note.', rubric: RUBRIC });
    check('a non-administrator cannot create an assessment (403)', (await api('POST', '/api/assessments', assessmentBody('Checkout one'), w1)).status === 403);
    const a1 = await api('POST', '/api/assessments', assessmentBody('Checkout tests'), admin);
    check('an administrator creates an assessment with a rubric (201)', a1.status === 201 && a1.body.id, a1.body);
    const a2 = await api('POST', '/api/assessments', assessmentBody('Checkout retry'), admin);
    const a3 = await api('POST', '/api/assessments', assessmentBody('Checkout concurrency'), admin);
    check('two more assessments are created for the other checks', a2.status === 201 && a3.status === 201);

    const listed = await api('GET', '/api/assessments', null, w1);
    check('a worker sees active assessments with no attempt yet', listed.status === 200 && listed.body.some((x) => x.id === a1.body.id && x.my_status === null));

    const start = await api('POST', `/api/assessments/${a1.body.id}/start`, null, w1);
    check('a worker starts an attempt (201)', start.status === 201 && start.body.id, start.body);
    const attemptId = start.body.id;
    check('a second open attempt at the same assessment is refused (409)', (await api('POST', `/api/assessments/${a1.body.id}/start`, null, w1)).status === 409);

    const racing = await Promise.all([
        api('POST', `/api/assessments/${a3.body.id}/start`, null, w1),
        api('POST', `/api/assessments/${a3.body.id}/start`, null, w1),
        api('POST', `/api/assessments/${a3.body.id}/start`, null, w1),
    ]);
    check('three simultaneous starts create exactly one attempt', racing.filter((r) => r.status === 201).length === 1 && racing.filter((r) => r.status === 409).length === 2, racing.map((r) => r.status));

    check('another worker cannot submit someone else\'s attempt (403)', (await api('POST', `/api/assessments/attempts/${attemptId}/submit`, { submission_text: WORK }, w2)).status === 403);
    check('a short submission is refused (400)', (await api('POST', `/api/assessments/attempts/${attemptId}/submit`, { submission_text: 'Done.' }, w1)).status === 400);
    check('a submission link must be https (400)', (await api('POST', `/api/assessments/attempts/${attemptId}/submit`, { submission_text: WORK, submission_link: 'http://example.com/x' }, w1)).status === 400);
    const sub = await api('POST', `/api/assessments/attempts/${attemptId}/submit`, { submission_text: WORK, submission_link: 'https://github.com/example/checkout' }, w1);
    check('the worker submits the attempt', sub.status === 200 && sub.body.status === 'submitted', sub.body);
    check('a submitted attempt cannot be submitted again (409)', (await api('POST', `/api/assessments/attempts/${attemptId}/submit`, { submission_text: WORK }, w1)).status === 409);

    check('a worker cannot see the review queue (403)', (await api('GET', '/api/assessments/review', null, w1)).status === 403);
    const queue = await api('GET', '/api/assessments/review', null, admin);
    check('the reviewer sees the submitted attempt with the advisory pre-check', queue.status === 200 && queue.body.some((x) => x.id === attemptId && x.ai_prescore), queue.body && queue.body.length);
    const mine = await api('GET', '/api/assessments/mine', null, w1);
    check('the worker\'s own list does not expose the pre-check', mine.status === 200 && !JSON.stringify(mine.body).includes('ai_prescore'));

    check('a review without notes is refused (400)', (await api('POST', `/api/assessments/attempts/${attemptId}/review`, { decision: 'verified', score: 80, notes: 'ok' }, admin)).status === 400);
    check('a score above 100 is refused (400)', (await api('POST', `/api/assessments/attempts/${attemptId}/review`, { decision: 'verified', score: 150, notes: 'Covers the approach and tests well.' }, admin)).status === 400);
    check('a non-administrator cannot review (403)', (await api('POST', `/api/assessments/attempts/${attemptId}/review`, { decision: 'verified', score: 90, notes: 'Covers the approach and tests well.' }, w1)).status === 403);
    const verdict = await api('POST', `/api/assessments/attempts/${attemptId}/review`, { decision: 'verified', score: 85, notes: 'Clear approach and tests that pass on the submitted code.' }, admin);
    check('the reviewer verifies the attempt', verdict.status === 200 && verdict.body.status === 'verified', verdict.body);
    check('a verified attempt cannot be reviewed again (409)', (await api('POST', `/api/assessments/attempts/${attemptId}/review`, { decision: 'not_verified', score: 10, notes: 'Changing the decision after the fact.' }, admin)).status === 409);
    check('a verified worker cannot start the same assessment again (409)', (await api('POST', `/api/assessments/${a1.body.id}/start`, null, w1)).status === 409);

    const pub = await api('GET', `/api/assessments/verified/${w1Id}`);
    check('verified assessments are public and carry no score or submission', pub.status === 200 && pub.body.length === 1 && pub.body[0].title === 'Checkout tests' && !('score' in pub.body[0]) && !('submission_text' in pub.body[0]), pub.body);
    const profile = await api('GET', `/api/profile/worker/${w1Id}`);
    check('the public worker profile lists verified assessments', profile.status === 200 && Array.isArray(profile.body.verified_assessments) && profile.body.verified_assessments.length === 1, profile.body && profile.body.verified_assessments);

    // Not verified: the cooldown applies.
    const s2 = await api('POST', `/api/assessments/${a2.body.id}/start`, null, w1);
    await api('POST', `/api/assessments/attempts/${s2.body.id}/submit`, { submission_text: WORK }, w1);
    const notVerified = await api('POST', `/api/assessments/attempts/${s2.body.id}/review`, { decision: 'not_verified', score: 40, notes: 'The tests do not cover the payment failure path.' }, admin);
    check('the reviewer records a not-verified outcome', notVerified.status === 200 && notVerified.body.status === 'not_verified', notVerified.body);
    check('a worker is held to the cooldown after a not-verified result (409)', (await api('POST', `/api/assessments/${a2.body.id}/start`, null, w1)).status === 409);
    const listedAgain = await api('GET', '/api/assessments', null, w1);
    check('the cooldown date is shown on the assessment list', listedAgain.body.find((x) => x.id === a2.body.id).cooldown_until !== null);

    check('a deactivated assessment cannot be started (409)', (await api('PATCH', `/api/assessments/${a3.body.id}`, { active: false }, admin)).status === 200 && (await api('POST', `/api/assessments/${a3.body.id}/start`, null, w2)).status === 409);

    // ---------------------------------------------------------------- matching
    const project = await api('POST', '/api/projects', {
        title: 'Phase three project', description: 'A project for the Phase 3 checks.',
        tasks: [{ title: 'Checkout flow', description: SHOP, category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(10), submission_type: 'github', acceptance_criteria: [] }],
    }, biz);
    check('a project with one task is created for the workspace checks', project.status === 201, project.body);
    const taskId = project.body.task_ids[0];

    const ownerMatches = await api('GET', `/api/matching/tasks/${taskId}`, null, biz);
    check('the business gets ranked matches with reasons for its task', ownerMatches.status === 200 && Array.isArray(ownerMatches.body.results), ownerMatches.body);
    check('matches never include workers who have not opted in', ownerMatches.body.results.every((r) => r.worker_id !== w2Id && r.worker_id !== outId));
    check('each match explains its factors and reasons', ownerMatches.body.results.every((r) => r.factors && Array.isArray(r.reasons)));
    check('a worker cannot see business-side matches (403)', (await api('GET', `/api/matching/tasks/${taskId}`, null, w1)).status === 403);
    check('a non-owner cannot see the matches for a task (403)', (await api('GET', `/api/matching/tasks/${taskId}`, null, outsider)).status === 403);
    const workerTasks = await api('GET', '/api/matching/tasks', null, w1);
    check('a worker gets ranked open tasks', workerTasks.status === 200 && Array.isArray(workerTasks.body.results), workerTasks.body);
    check('the worker task list explains each score', workerTasks.body.results.every((r) => typeof r.score === 'number' && Array.isArray(r.reasons)));

    // ---------------------------------------------------------------- workspace
    const addParticipant = async(workerId) => db.query(
        `INSERT INTO bounty_participants (bounty_id, worker_id, status) VALUES ((SELECT id FROM bounties WHERE id = $1), $2, 'active')
         ON CONFLICT (bounty_id, worker_id) DO NOTHING`, [taskId, workerId]
    );
    await addParticipant(w1Id);
    await addParticipant(w2Id);

    check('an outsider cannot see the workspace (403)', (await api('GET', `/api/workspace/${taskId}`, null, outsider)).status === 403);
    const bad = await api('POST', `/api/workspace/${taskId}`, { title: 'Hi', description: '' }, biz);
    check('a deliverable needs a real title (400)', bad.status === 400);
    check('a worker cannot create deliverables (403)', (await api('POST', `/api/workspace/${taskId}`, { title: 'Sneaky item' }, w1)).status === 403);
    check('a deliverable cannot be assigned to someone not on the task (400)', (await api('POST', `/api/workspace/${taskId}`, { title: 'Assign outsider', worker_id: outId }, biz)).status === 400);
    check('a deliverable link must be https (400)', (await api('POST', `/api/workspace/${taskId}`, { title: 'Insecure link item', link: 'http://example.com' }, biz)).status === 400);

    const d1 = await api('POST', `/api/workspace/${taskId}`, { title: 'Design the layout', component: 'UI', description: 'Agree the layout with the business.', due_at: inDays(3) }, biz);
    check('the business adds the first deliverable (201)', d1.status === 201 && d1.body.id, d1.body);
    const d2 = await api('POST', `/api/workspace/${taskId}`, { title: 'Build the checkout', component: 'Payments', description: 'Build the payment steps.', depends_on: d1.body.id }, biz);
    check('the business adds a deliverable that depends on the first (201)', d2.status === 201, d2.body);
    const d3 = await api('POST', `/api/workspace/${taskId}`, { title: 'Write the notes', description: 'Document the flow.' }, biz);
    const d4 = await api('POST', `/api/workspace/${taskId}`, { title: 'Review the flow', description: 'A later review step.' }, biz);

    const board = await api('GET', `/api/workspace/${taskId}`, null, w1);
    check('a participant sees the workspace with progress', board.status === 200 && board.body.progress.total === 4 && board.body.progress.percent === 0, board.body && board.body.progress);
    check('the board reports the caller as a participant, not the business', board.body.role === 'participant');

    check('work cannot start before its dependency is accepted (409)', (await api('PATCH', `/api/workspace/deliverables/${d2.body.id}`, { status: 'in_progress' }, w1)).status === 409);
    const claimed = await api('PATCH', `/api/workspace/deliverables/${d1.body.id}`, { status: 'in_progress' }, w1);
    check('a participant claims and starts an unassigned deliverable', claimed.status === 200 && claimed.body.status === 'in_progress' && claimed.body.worker_id === w1Id, claimed.body);

    const raced = await Promise.all([
        api('PATCH', `/api/workspace/deliverables/${d3.body.id}`, { status: 'in_progress' }, w1),
        api('PATCH', `/api/workspace/deliverables/${d3.body.id}`, { status: 'in_progress' }, w2),
    ]);
    check('two participants racing to claim one deliverable: exactly one wins', raced.filter((r) => r.status === 200).length === 1, raced.map((r) => r.status));
    const winner = raced.find((r) => r.status === 200).body.worker_id;
    const loser = winner === w1Id ? w2 : w1;
    check('the losing participant cannot act on the claimed deliverable (403)', (await api('PATCH', `/api/workspace/deliverables/${d3.body.id}`, { status: 'delivered' }, loser)).status === 403);

    const delivered = await api('PATCH', `/api/workspace/deliverables/${d1.body.id}`, { status: 'delivered', link: 'https://github.com/example/layout' }, w1);
    check('the assigned worker delivers the work with a link', delivered.status === 200 && delivered.body.status === 'delivered', delivered.body);
    check('a worker cannot accept their own work (403)', (await api('PATCH', `/api/workspace/deliverables/${d1.body.id}`, { status: 'accepted' }, w1)).status === 403);
    check('an impossible jump is refused (409)', (await api('PATCH', `/api/workspace/deliverables/${d4.body.id}`, { status: 'accepted' }, biz)).status === 409);
    check('the business accepts the delivered work', (await api('PATCH', `/api/workspace/deliverables/${d1.body.id}`, { status: 'accepted' }, biz)).status === 200);
    const nowUnblocked = await api('PATCH', `/api/workspace/deliverables/${d2.body.id}`, { status: 'in_progress' }, w1);
    check('once the dependency is accepted the dependent work can start', nowUnblocked.status === 200, nowUnblocked.body);

    check('blocking needs a reason (400)', (await api('PATCH', `/api/workspace/deliverables/${d2.body.id}`, { status: 'blocked' }, w1)).status === 400);
    const blocked = await api('PATCH', `/api/workspace/deliverables/${d2.body.id}`, { status: 'blocked', blocked_reason: 'Waiting for the payment sandbox keys.' }, w1);
    check('a participant marks work blocked with a reason', blocked.status === 200 && blocked.body.blocked_reason, blocked.body);
    check('the board counts the blocked deliverable', (await api('GET', `/api/workspace/${taskId}`, null, biz)).body.progress.blocked === 1);

    check('the business cannot edit a deliverable once it is under way (409)', (await api('PATCH', `/api/workspace/deliverables/${d2.body.id}`, { title: 'Renamed later' }, biz)).status === 409);
    const planned = await api('POST', `/api/workspace/${taskId}`, { title: 'Planned loop A', description: 'Planned item.' }, biz);
    const planned2 = await api('POST', `/api/workspace/${taskId}`, { title: 'Planned loop B', description: 'Depends on A.', depends_on: planned.body.id }, biz);
    check('a dependency that would form a loop is refused (409)', (await api('PATCH', `/api/workspace/deliverables/${planned.body.id}`, { depends_on: planned2.body.id }, biz)).status === 409);
    check('a deliverable cannot depend on itself (400)', (await api('PATCH', `/api/workspace/deliverables/${planned.body.id}`, { depends_on: planned.body.id }, biz)).status === 400);
    check('a planned deliverable can be assigned to a participant', (await api('PATCH', `/api/workspace/deliverables/${planned.body.id}`, { worker_id: w2Id }, biz)).status === 200);

    const timeline = await api('GET', `/api/workspace/${taskId}/timeline`, null, biz);
    check('the timeline records the changes', timeline.status === 200 && timeline.body.length >= 6, timeline.body && timeline.body.length);
    check('the timeline names what changed and who changed it', timeline.body.some((e) => e.event === 'status_changed' && e.actor_name));
    check('a non-member cannot read the timeline (403)', (await api('GET', `/api/workspace/${taskId}/timeline`, null, outsider)).status === 403);

    console.log(`\nPhase 3 API checks passed: ${passed}`);
    await db.end();
    process.exit(0);
})().catch(async(err) => {
    console.error('Phase 3 test crashed:', err);
    await db.end().catch(() => {});
    process.exit(1);
});
