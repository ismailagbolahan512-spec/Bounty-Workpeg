// scripts/execution-modes-test.js — the four execution modes, classification rules,
// security gating, team assignment, cancellation, expiry and access control.
//
// Usage:
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log node scripts/execution-modes-test.js
// Exits with code 1 on the first failed check.

const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) {
    console.error('Set LOG_FILE to the server log, so the test can read dev emails.');
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
const stamp = Date.now();

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

const GOOD = 'Implemented the agreed change and tested it locally before sending it for review.';
const LINK_OK = 'https://github.com/example/work';
const LINK_BAD = 'https://example.com/work';
const CRIT_LINK = [{ text: 'Link to the repository', rule: { type: 'link_host', hosts: ['github.com'] } }];
const SEC = {
    nda_text: 'The worker keeps every detail of the engagement confidential, uses it only for this task, and destroys all copies when the task closes.',
    authorization_statement: 'The business authorises testing of the single named staging system below, for the period of this task, and no other system.',
    rules_of_engagement: 'Test only the approved host. No denial-of-service. Stop and report at once if real customer data is reached.',
    permitted_targets: 'staging.example-shop.test (web application only)',
    prohibited_activities: 'No social engineering, no physical access, no denial-of-service, and no testing of any other host.',
};

function base(extra = {}) {
    return {
        title: 'Execution test task', description: 'A task used by the execution mode checks.',
        category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github',
        ...extra,
    };
}
function submission(bountyId, extra = {}) {
    return { bounty_id: bountyId, title: 'Work', description: GOOD, github_link: LINK_OK, ...extra };
}

(async () => {
    const biz = await signupVerified(`em-biz-${stamp}@example.com`, 'business', 'Modes Biz');
    const biz2 = await signupVerified(`em-biz2-${stamp}@example.com`, 'business', 'Other Biz');
    const workers = [];
    for (let i = 0; i < 4; i++) workers.push(await signupVerified(`em-w${i}-${stamp}@example.com`, 'worker', `Modes Worker ${i}`));
    const [t1, t2, t3, t4] = workers;

    // ------------------------------------------------ 1. classification matrix
    const cat = await api('GET', '/api/classification');
    check('classification endpoint is public and returns 200', cat.status === 200, cat.body);
    check('four execution modes are published', JSON.stringify(cat.body.modes.map((m) => m.id)) === JSON.stringify(['first_valid', 'competitive', 'team', 'independent']), cat.body.modes);
    check('eleven industries are published, including hospitality', cat.body.industries.length === 11 && cat.body.industries.some((i) => i.id === 'hospitality'), cat.body.industries.length);
    const jobs = cat.body.industries.flatMap((i) => i.job_types);
    check('every job type carries its full classification',
        jobs.length >= 25 && jobs.every((j) => j.recommended_mode && Array.isArray(j.alternative_modes) && j.deliverables.length > 0 &&
            j.verification && typeof j.human_approval_required === 'boolean' && j.confidentiality && typeof j.requires_authorization === 'boolean'), jobs[0]);

    // ------------------------------------------------ 2. creation rules
    const badMode = await api('POST', '/api/bounties', base({ execution_mode: 'lottery' }), biz);
    check('an unknown execution mode is rejected (400)', badMode.status === 400, badMode.body);
    const teamAlone = await api('POST', '/api/bounties', base({ execution_mode: 'team' }), biz);
    check('team execution cannot be set on a single task (400)', teamAlone.status === 400, teamAlone.body);
    const badJob = await api('POST', '/api/bounties', base({ job_type: 'not-a-job' }), biz);
    check('an unknown job type is rejected (400)', badJob.status === 400, badJob.body);
    const zeroWorkers = await api('POST', '/api/bounties', base({ max_workers: 0 }), biz);
    check('zero workers is rejected (400)', zeroWorkers.status === 400, zeroWorkers.body);
    const tooManyWinners = await api('POST', '/api/bounties', base({ execution_mode: 'competitive', winner_limit: 3, max_workers: 2 }), biz);
    check('more winners than workers is rejected (400)', tooManyWinners.status === 400, tooManyWinners.body);
    const fvTwoWinners = await api('POST', '/api/bounties', base({ execution_mode: 'first_valid', winner_limit: 2 }), biz);
    check('first valid submission cannot have two winners (400)', fvTwoWinners.status === 400, fvTwoWinners.body);
    const secNoFields = await api('POST', '/api/bounties', base({ job_type: 'sec-pentest-scoped', execution_mode: 'first_valid' }), biz);
    check('a security task without authorization and rules is rejected (400)', secNoFields.status === 400, secNoFields.body);
    const secOk = await api('POST', '/api/bounties', base({ title: 'Scoped pentest', job_type: 'sec-pentest-scoped', execution_mode: 'first_valid', ...SEC }), biz);
    check('a security task with authorization and rules is created (201)', secOk.status === 201 && secOk.body.requires_authorization === true, secOk.body);
    const mismatch = await api('POST', '/api/bounties', base({ job_type: 'sw-bug-fix', execution_mode: 'independent', independent_target: 2 }), biz);
    check('a mismatched mode is allowed but explained (201)', mismatch.status === 201 && /usually works best as First Valid/.test(mismatch.body.execution_note || ''), mismatch.body);
    const matched = await api('POST', '/api/bounties', base({ job_type: 'sw-bug-fix', execution_mode: 'first_valid' }), biz);
    check('a recommended mode has no note (201)', matched.status === 201 && matched.body.execution_note === null, matched.body);

    // ------------------------------------------------ 3. first valid submission
    const fv = await api('POST', '/api/bounties', base({ title: 'Fix login crash', job_type: 'sw-bug-fix', execution_mode: 'first_valid', acceptance_criteria: CRIT_LINK, max_workers: 3 }), biz);
    check('first valid task is created (201)', fv.status === 201, fv.body);
    const fvId = fv.body.id;
    const sA = await api('POST', '/api/submissions', submission(fvId), t1);
    const sB = await api('POST', '/api/submissions', submission(fvId, { github_link: LINK_BAD }), t2);
    const sC = await api('POST', '/api/submissions', submission(fvId), t3);
    check('three submissions are accepted while the task is open', [sA, sB, sC].every((r) => r.status === 201), [sA.body, sB.body, sC.body]);

    const failing = await api('POST', `/api/submissions/${sB.body.id}/approve`, null, biz);
    check('a submission that fails the criteria cannot be confirmed (409)', failing.status === 409 && /does not meet the requirements/.test(failing.body.message || ''), failing.body);

    // Two verified submissions approved at the same instant: exactly one may win.
    const [r1, r3] = await Promise.all([
        api('POST', `/api/submissions/${sA.body.id}/approve`, null, biz),
        api('POST', `/api/submissions/${sC.body.id}/approve`, null, biz),
    ]);
    const codes = [r1.status, r3.status].sort();
    check('two simultaneous approvals produce exactly one winner', JSON.stringify(codes) === JSON.stringify([200, 409]), codes);

    const fvAfter = await api('GET', `/api/bounties/${fvId}`, null, t4);
    check('the task completes with the reason recorded', fvAfter.body.status === 'completed' && fvAfter.body.closure_reason === 'winner_confirmed', fvAfter.body);
    const fvSubs = await api('GET', `/api/submissions/bounty/${fvId}`, null, biz);
    const approvedCount = fvSubs.body.filter((s) => s.status === 'approved').length;
    const closedCount = fvSubs.body.filter((s) => s.status === 'closed').length;
    check('exactly one submission is approved and the rest are closed', approvedCount === 1 && closedCount === 2, fvSubs.body.map((s) => s.status));

    const late = await api('POST', '/api/submissions', submission(fvId), t4);
    check('no submission is accepted after the winner is confirmed (409)', late.status === 409, late.body);

    await sleep(600);
    const notes = await api('GET', '/api/notifications', null, t2);
    check('the worker whose submission was closed is told why',
        notes.body.some((n) => /completed by another worker/.test(n.message)), notes.body.map((n) => n.message));

    // ------------------------------------------------ 4. capacity under concurrent submissions
    const cap = await api('POST', '/api/bounties', base({ title: 'Capacity test', job_type: 'sw-bug-fix', execution_mode: 'first_valid', max_workers: 3 }), biz);
    const capResults = await Promise.all(workers.map((tok) => api('POST', '/api/submissions', submission(cap.body.id), tok)));
    const created = capResults.filter((r) => r.status === 201).length;
    const full = capResults.filter((r) => r.status === 409 && /maximum number of workers/.test(r.body.message || '')).length;
    check('four simultaneous submissions to a 3-worker task admit exactly three', created === 3 && full === 1, capResults.map((r) => r.status));

    // ------------------------------------------------ 5. competitive selection
    const comp = await api('POST', '/api/bounties', base({ title: 'Logo for Diff Timeline', job_type: 'design-logo', execution_mode: 'competitive', winner_limit: 2, max_workers: 3 }), biz);
    check('competitive task with two winners is created (201)', comp.status === 201 && comp.body.execution_mode === 'competitive', comp.body);
    const compSubs = [];
    for (const tok of [t1, t2, t3]) compSubs.push((await api('POST', '/api/submissions', submission(comp.body.id), tok)).body);
    const pick1 = await api('POST', `/api/submissions/${compSubs[0].id}/approve`, null, biz);
    check('first chosen winner is approved and the task stays open', pick1.status === 200 && pick1.body.bounty_status === 'open', pick1.body);
    const pick2 = await api('POST', `/api/submissions/${compSubs[1].id}/approve`, null, biz);
    check('second chosen winner completes the task', pick2.status === 200 && pick2.body.bounty_status === 'completed' && pick2.body.winners_confirmed === 2, pick2.body);
    const pick3 = await api('POST', `/api/submissions/${compSubs[2].id}/approve`, null, biz);
    check('a third winner is refused once the limit is reached (409)', pick3.status === 409, pick3.body);

    // ------------------------------------------------ 6. independent assessment
    const ind = await api('POST', '/api/bounties', base({ title: 'Market survey', job_type: 'research-market', execution_mode: 'independent', independent_target: 2, max_workers: 3, acceptance_criteria: CRIT_LINK }), biz);
    check('independent assessment is created (201)', ind.status === 201 && ind.body.execution_mode === 'independent', ind.body);
    const i1 = (await api('POST', '/api/submissions', submission(ind.body.id), t1)).body;
    const i2 = (await api('POST', '/api/submissions', submission(ind.body.id, { github_link: LINK_BAD }), t2)).body;
    const i3 = (await api('POST', '/api/submissions', submission(ind.body.id), t3)).body;
    const a1 = await api('POST', `/api/submissions/${i1.id}/approve`, null, biz);
    check('first independent result is accepted and the task stays open', a1.status === 200 && a1.body.bounty_status === 'open' && a1.body.winners_confirmed === 1, a1.body);
    const a2 = await api('POST', `/api/submissions/${i2.id}/approve`, null, biz);
    check('an independent result that fails the criteria is not accepted (409)', a2.status === 409, a2.body);
    const a3 = await api('POST', `/api/submissions/${i3.id}/approve`, null, biz);
    check('the second accepted result reaches the target and completes the task', a3.status === 200 && a3.body.bounty_status === 'completed', a3.body);
    const indAfter = await api('GET', `/api/bounties/${ind.body.id}`, null, biz);
    check('the completed assessment records why it closed', indAfter.body.closure_reason === 'target_reached', indAfter.body);

    // ------------------------------------------------ 7. worker limit on accept
    const one = await api('POST', '/api/bounties', base({ title: 'Single seat', job_type: 'sw-bug-fix', execution_mode: 'competitive', max_workers: 1 }), biz);
    const seat1 = await api('POST', `/api/bounties/${one.body.id}/accept`, {}, t1);
    check('a worker takes the only seat (201)', seat1.status === 201 && seat1.body.status === 'active', seat1.body);
    const seat2 = await api('POST', `/api/bounties/${one.body.id}/accept`, {}, t2);
    check('a second worker is refused when the task is full (409)', seat2.status === 409 && /maximum number of workers/.test(seat2.body.message), seat2.body);
    const seat1again = await api('POST', `/api/bounties/${one.body.id}/accept`, {}, t1);
    check('the worker who already holds the seat is not charged again (200)', seat1again.status === 200, seat1again.body);

    // ------------------------------------------------ 8. security gating
    const sec = await api('POST', '/api/bounties', base({ title: 'Scoped pentest for staging', job_type: 'sec-pentest-scoped', execution_mode: 'first_valid', max_workers: 2, ...SEC }), biz);
    const secId = sec.body.id;
    const anon = await api('GET', `/api/bounties/${secId}`);
    check('anonymous visitors see the NDA text but not the scope', anon.body.nda_text && anon.body.scope && anon.body.scope.restricted === true, anon.body.scope);
    const noNda = await api('POST', `/api/bounties/${secId}/accept`, {}, t1);
    check('taking a security task without the NDA is refused (400)', noNda.status === 400, noNda.body);
    const nda = await api('POST', `/api/bounties/${secId}/accept`, { nda_accepted: true }, t1);
    check('accepting the NDA takes a slot (201)', nda.status === 201 && nda.body.nda_accepted === true && nda.body.roe_accepted === false, nda.body);
    const beforeRoe = await api('POST', '/api/submissions', submission(secId), t1);
    check('a submission is refused before the rules of engagement are accepted (403)', beforeRoe.status === 403, beforeRoe.body);
    const roe = await api('POST', `/api/bounties/${secId}/accept`, { roe_accepted: true }, t1);
    check('accepting the rules of engagement is recorded (200)', roe.status === 200 && roe.body.roe_accepted === true, roe.body);
    const secSub = await api('POST', '/api/submissions', submission(secId), t1);
    check('an accepted worker can submit (201)', secSub.status === 201, secSub.body);
    const insider = await api('GET', `/api/bounties/${secId}`, null, t1);
    check('an accepted worker can read the rules of engagement', insider.body.scope && insider.body.scope.rules_of_engagement, insider.body.scope);
    const outsider = await api('GET', `/api/bounties/${secId}`, null, t2);
    check('a worker who has not accepted the NDA cannot read the scope', outsider.body.scope && outsider.body.scope.restricted === true, outsider.body.scope);
    const intruder = await api('POST', '/api/submissions', submission(secId), t3);
    check('a worker outside the task cannot submit to it (403)', intruder.status === 403, intruder.body);

    // ------------------------------------------------ 9. team execution
    const project = await api('POST', '/api/projects', {
        title: 'Shop rebuild', description: 'Three connected parts for one shop.', execution_mode: 'team',
        tasks: [
            { title: 'Catalogue API', description: 'Build the product catalogue API.', category: 'dev', difficulty: 'medium', reward_amount: 100, deadline: inDays(7), submission_type: 'github' },
            { title: 'Checkout page', description: 'Build the checkout page UI.', category: 'dev', difficulty: 'medium', reward_amount: 100, deadline: inDays(7), submission_type: 'github' },
        ],
    }, biz);
    check('a team project is created with team tasks (201)', project.status === 201 && project.body.execution_mode === 'team', project.body);
    const teamTask = await api('GET', `/api/bounties/${project.body.task_ids[0]}`);
    check('tasks in a team project are in team mode', teamTask.body.execution_mode === 'team' && teamTask.body.max_workers === 1, teamTask.body);
    const teamId = project.body.task_ids[0];
    const stranger = await api('POST', `/api/bounties/${teamId}/accept`, {}, t4);
    check('workers cannot take team components themselves (409)', stranger.status === 409 && /assigned by the business/.test(stranger.body.message), stranger.body);
    const workerProfile = (await api('GET', '/api/profile/me', null, t1)).body.id;
    const notOwner = await api('POST', `/api/bounties/${teamId}/assign`, { worker_id: workerProfile }, biz2);
    check('another business cannot assign a team task (403)', notOwner.status === 403, notOwner.body);
    const assignSingle = await api('POST', `/api/bounties/${one.body.id}/assign`, { worker_id: '00000000-0000-4000-8000-000000000000' }, biz);
    check('only team tasks can be assigned (409)', assignSingle.status === 409, assignSingle.body);
    const profileId = workerProfile;
    const assigned = await api('POST', `/api/bounties/${teamId}/assign`, { worker_id: profileId }, biz);
    check('the business assigns a worker to a team component (201)', assigned.status === 201 && assigned.body.status === 'assigned', assigned.body);
    const assignedAccept = await api('POST', `/api/bounties/${teamId}/accept`, {}, t1);
    check('the assigned worker confirms and becomes active (200)', assignedAccept.status === 200 && assignedAccept.body.status === 'active', assignedAccept.body);
    const teamSubOther = await api('POST', '/api/submissions', submission(teamId), t2);
    check('an unassigned worker cannot submit to a team component (403)', teamSubOther.status === 403, teamSubOther.body);
    const teamSub = await api('POST', '/api/submissions', submission(teamId), t1);
    check('the assigned worker can submit to it (201)', teamSub.status === 201, teamSub.body);
    const roster = await api('GET', `/api/bounties/${teamId}/participants`, null, biz);
    check('the business sees the team roster', roster.status === 200 && roster.body.some((p) => p.worker_id === profileId), roster.body);

    // ------------------------------------------------ 10. cancellation
    const canc = await api('POST', '/api/bounties', base({ title: 'Cancelled task', job_type: 'sw-feature-build', execution_mode: 'competitive', max_workers: 3 }), biz);
    await api('POST', `/api/bounties/${canc.body.id}/accept`, {}, t2);
    const cancSub = await api('POST', '/api/submissions', submission(canc.body.id), t2);
    const cancelled = await api('PATCH', `/api/bounties/${canc.body.id}/close`, null, biz);
    check('the business can cancel an open task (200)', cancelled.status === 200 && cancelled.body.closure_reason === 'cancelled_by_business', cancelled.body);
    const cancMine = await api('GET', '/api/submissions/mine', null, t2);
    const cancRow = (cancMine.body || []).find((s) => s.id === cancSub.body.id);
    check('the worker\'s submission is closed when the task is cancelled', cancRow && cancRow.status === 'closed', cancRow);
    const cancRoster = await api('GET', `/api/bounties/${canc.body.id}/participants`, null, biz);
    check('participants are released when the task is cancelled', cancRoster.body.every((p) => p.status === 'closed'), cancRoster.body);
    await sleep(600);
    const cancNotes = await api('GET', '/api/notifications', null, t2);
    check('the worker is told the task was cancelled', cancNotes.body.some((n) => /closed "Cancelled task"/.test(n.message)), cancNotes.body.map((n) => n.message));

    // ------------------------------------------------ 11. expiry
    const short = await api('POST', '/api/bounties', base({ title: 'Short deadline task', deadline: new Date(Date.now() + 2500).toISOString(), execution_mode: 'competitive' }), biz);
    await api('POST', `/api/bounties/${short.body.id}/accept`, {}, t3);
    await sleep(3000);
    const expired = await api('GET', `/api/bounties/${short.body.id}`, null, t3);
    check('a task past its deadline is expired with the reason', expired.body.status === 'expired' && expired.body.closure_reason === 'deadline_passed', expired.body);
    const expiredPublic = await api('GET', `/api/bounties/${short.body.id}`, null, null);
    check('an expired task is hidden from the public', expiredPublic.status === 404, expiredPublic.body);
    const expiredList = await api('GET', '/api/bounties?status=expired&limit=50', null, null);
    check('an expired task is not in the public list', !(expiredList.body.bounties || []).some((x) => x.id === short.body.id), expiredList.body);
    const expiredOwner = await api('GET', `/api/bounties/${short.body.id}`, null, biz);
    check('the business that posted it still sees the expired task', expiredOwner.status === 200 && expiredOwner.body.status === 'expired', expiredOwner.body);
    await sleep(600);
    const expNotes = await api('GET', '/api/notifications', null, t3);
    check('the worker is told the task reached its deadline', expNotes.body.some((n) => /reached its deadline/.test(n.message)), expNotes.body.map((n) => n.message));

    // ------------------------------------------------ 12. unauthorized access
    const fvSubmission = (await api('GET', `/api/submissions/bounty/${fvId}`, null, biz)).body[0];
    const otherBiz = await api('POST', `/api/submissions/${fvSubmission.id}/approve`, null, biz2);
    check('a different business cannot approve the work (403)', otherBiz.status === 403, otherBiz.body);
    const workerApprove = await api('POST', `/api/submissions/${fvSubmission.id}/approve`, null, t1);
    check('a worker cannot approve anything (403)', workerApprove.status === 403, workerApprove.body);
    const anonApprove = await api('POST', `/api/submissions/${fvSubmission.id}/approve`, null);
    check('approval requires a signed-in user (401)', anonApprove.status === 401, anonApprove.body);
    const otherParticipants = await api('GET', `/api/bounties/${fvId}/participants`, null, biz2);
    check('another business cannot read the participant list (403)', otherParticipants.status === 403, otherParticipants.body);
    const otherHistory = await api('GET', `/api/bounties/${fvId}/history`, null, biz2);
    check('another business cannot read the audit trail (403)', otherHistory.status === 403, otherHistory.body);
    const workerAssign = await api('POST', `/api/bounties/${teamId}/assign`, { worker_id: profileId }, t1);
    check('a worker cannot assign team work (403)', workerAssign.status === 403, workerAssign.body);

    // ------------------------------------------------ 13. audit trail
    const history = await api('GET', `/api/bounties/${fvId}/history`, null, biz);
    const events = (history.body || []).map((e) => e.event);
    check('the audit trail records creation, submissions, approval and closure',
        ['bounty_created', 'submission_received', 'submission_approved', 'bounty_closed'].every((e) => events.includes(e)), events);

    console.log(`\nAll ${passed} checks passed.`);
    process.exit(0);
})().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
