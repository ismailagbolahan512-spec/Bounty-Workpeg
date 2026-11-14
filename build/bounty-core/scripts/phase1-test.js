// scripts/phase1-test.js — Phase 1: smart verification reports, proof-of-work reputation,
// and milestone-based projects. Covers the pure rules, the API, access control, and
// concurrency (simultaneous starts, approvals and dependency edits).
//
// Usage:
//   BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase1-test.js
// Exits with code 1 on the first failed check.

const fs = require('fs');
const { Pool } = require('pg');
const { buildVerification } = require('../services/verification');
const { summarise, SAME_CLIENT_CAP, bandFor, BANDS } = require('../services/reputation');
const { parseMilestone, wouldCreateCycle, assertWithinProjectBudget } = require('../services/milestones');
const { summariseDisputes } = require('../services/reputation');

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
const GOOD = 'Execution test task completed: implemented the requested change and tested it locally before review.';
const SHORT = 'Done quickly.';

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

(async() => {
    // ------------------------------------------------ pure rules (no server needed)
    const task = { title: 'Execution test task', description: 'Checks the execution rules for the test.', requires_authorization: false };
    const ok = buildVerification({
        submission: { title: 'Work', description: GOOD }, bounty: task,
        check: { results: [], ai_used: false, ai_error: null, notes: [] }, executionMode: 'competitive',
    });
    check('a documented, on-topic submission with no failed checks is a pass', ok.outcome === 'pass', ok.outcome);
    check('the pass report says a human still decides', /final decision/.test(ok.summary));

    const thin = buildVerification({
        submission: { title: 'Work', description: SHORT }, bounty: task,
        check: { results: [], ai_used: false, ai_error: null, notes: [] }, executionMode: 'competitive',
    });
    check('a submission with too little description fails the documentation check', thin.outcome === 'fail', thin.outcome);

    const failed = buildVerification({
        submission: { title: 'Work', description: GOOD }, bounty: task,
        check: { results: [{ id: 'c1', status: 'confirmed_fail', text: 'Link', reason: 'No link' }], ai_used: false, ai_error: null, notes: [] },
        executionMode: 'competitive',
    });
    check('a confirmed criterion failure gives a fail report', failed.outcome === 'fail', failed.outcome);

    const security = buildVerification({
        submission: { title: 'Work', description: GOOD }, bounty: { ...task, requires_authorization: true },
        check: { results: [], ai_used: false, ai_error: null, notes: [] }, executionMode: 'first_valid',
    });
    check('security work is never auto-passed, even when every check passes', security.outcome === 'needs_review', security.outcome);
    check('security reports name the qualified reviewer', security.checks.some((c) => c.id === 'security_review' && c.status === 'not_checked'));
    check('first valid reports carry the mode note', /Only a verified submission can win/.test(security.mode_note));

    const offTopic = buildVerification({
        submission: { title: 'Work', description: 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.' },
        bounty: task, check: { results: [], ai_used: false, ai_error: null, notes: [] }, executionMode: 'competitive',
    });
    check('a submission sharing no task terms is sent to review, not passed', offTopic.outcome === 'needs_review', offTopic.outcome);

    const now = Date.now();
    const sameClient = Array.from({ length: SAME_CLIENT_CAP + 2 }, (_, i) => ({
        industry: 'dev', business_id: 'biz-1', reward: 1000, submitted_at: new Date(now - i * 1000), deadline: new Date(now + 86400000), revised: false, rating: 5,
    }));
    const capped = summarise(sameClient);
    check('reputation counts at most the same-client cap for one client', capped.industries[0].verified_completed === SAME_CLIENT_CAP,
        capped.industries[0]);
    check('reputation is reported per industry', capped.industries.length === 1 && capped.industries[0].industry === 'dev');
    check('one client alone cannot reach the trusted band', capped.industries[0].band !== 'trusted');
    const disputeOnWorker = summariseDisputes([
        { status: 'resolved', decision_outcome: 'upheld_raiser' },
        { status: 'resolved', decision_outcome: 'upheld_respondent' },
        { status: 'resolved', decision_outcome: 'partial' },
        { status: 'open', decision_outcome: null },
    ]);
    check('dispute history counts each decided outcome against the worker',
        disputeOnWorker.decided === 3 && disputeOnWorker.upheld_against === 1 && disputeOnWorker.upheld_for === 1 && disputeOnWorker.partial === 1 && disputeOnWorker.open === 1,
        disputeOnWorker);
    check('an open dispute is shown as open, not as a finding', summariseDisputes([{ status: 'open', decision_outcome: 'upheld_raiser' }]).upheld_against === 0);
    const strongRecord = Array.from({ length: BANDS.trusted.min_verified }, (_, i) => ({
        industry: 'dev', business_id: `biz-${i % 6}`, reward: 1000, submitted_at: new Date(now - i * 1000), deadline: new Date(now + 86400000), revised: false, rating: 5,
    }));
    check('a strong record reaches trusted with no upheld complaint', summarise(strongRecord).industries[0].band === 'trusted');
    check('an upheld complaint against the worker blocks the trusted band',
        summarise(strongRecord, [{ status: 'resolved', decision_outcome: 'upheld_raiser' }]).industries[0].band === 'established');
    check('dispute history does not change the verified count', summarise(strongRecord, [{ status: 'resolved', decision_outcome: 'upheld_raiser' }]).total_verified === BANDS.trusted.min_verified);
    check('the dispute history note is shown and the old placeholder is gone',
        summarise([], []).notes.some((n) => /respondent/.test(n)) && !summarise([], []).notes.some((n) => /not included yet/.test(n)));
    check('reward weight is capped', summarise([{ industry: 'x', business_id: 'b', reward: 1e9, submitted_at: new Date(), deadline: null, revised: false, rating: null }]).industries[0].weighted_score === 2);
    check('a band needs enough verified work', bandFor({ verified: 4, onTime: 1, avgRating: 5, ratings: 5 }) === 'emerging');
    check('an established band needs on-time work', bandFor({ verified: 6, onTime: 0.5, avgRating: null, ratings: 0 }) === 'emerging');

    const parsed = parseMilestone({ title: 'Research and planning', deliverables: 'A written plan', acceptance_criteria: 'Plan agreed by the owner', budget: 500 });
    check('milestone parsing accepts a complete milestone', parsed.budget === 500 && parsed.title === 'Research and planning');
    let rejected = false;
    try { parseMilestone({ title: 'X', deliverables: 'a', acceptance_criteria: 'b', budget: -1 }); } catch (e) { rejected = e.status === 400; }
    check('a negative budget is rejected', rejected);
    let overCap = false;
    try { assertWithinProjectBudget({ totalBudget: 500, allocatedElsewhere: 300, budget: 250 }); } catch (e) { overCap = e.status === 400; }
    check("a milestone that takes the total over the project budget is rejected (400)", overCap);
    check('a milestone that lands exactly on the project budget is allowed',
        (() => { try { assertWithinProjectBudget({ totalBudget: 500, allocatedElsewhere: 300, budget: 200 }); return true; } catch (e) { return false; } })());
    check('with no project budget set there is no cap',
        (() => { try { assertWithinProjectBudget({ totalBudget: null, allocatedElsewhere: 1e9, budget: 1e9 }); return true; } catch (e) { return false; } })());
    const edges = new Map([['b', ['c']], ['c', []]]);
    check('a dependency loop is detected', wouldCreateCycle('a', ['b'], new Map([['b', ['a']]])) === true);
    check('a dependency chain without a loop is allowed', wouldCreateCycle('a', ['b'], edges) === false);

    // ------------------------------------------------ API
    const biz = await signupVerified(`p1-biz+${stamp}@test.com`, 'business', 'Phase One Biz');
    const other = await signupVerified(`p1-other+${stamp}@test.com`, 'business', 'Other Biz');
    const w1 = await signupVerified(`p1-w1+${stamp}@test.com`, 'worker', 'Worker One');
    const w2 = await signupVerified(`p1-w2+${stamp}@test.com`, 'worker', 'Worker Two');
    const w1Id = (await api('GET', '/api/profile/me', null, w1)).body.id;
    const w2Id = (await api('GET', '/api/profile/me', null, w2)).body.id;
    const bizId = (await api('GET', '/api/profile/me', null, biz)).body.id;

    // A project with one task, used for the verification and reputation checks.
    const project = await api('POST', '/api/projects', {
        title: 'Phase one project', description: 'A project for the phase one checks.',
        tasks: [{ title: 'Execution test task', description: 'Checks the execution rules for the test.', category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz);
    check('a project with one task is created', project.status === 201, project.body);
    const taskId = project.body.task_ids[0];

    const sub = await api('POST', '/api/submissions', { bounty_id: taskId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/work' }, w1);
    check('worker one submits to the task', sub.status === 201, sub.body);
    const subId = sub.body.id;

    // Verification reports
    const v = await api('POST', `/api/verification/submissions/${subId}`, null, biz);
    check('the owner gets a verification report', v.status === 201 && ['pass', 'fail', 'needs_review'].includes(v.body.outcome), v.body);
    const after = await api('GET', '/api/submissions/mine', null, w1);
    check('a report does not change the submission status', after.body.find((s) => s.id === subId).status === 'pending');
    check('a report explains its checks', Array.isArray(v.body.checks) && v.body.checks.length >= 2);
    check('the report says it is advisory', v.body.notes.some((n) => /advisory/.test(n)));
    const history = await api('GET', `/api/verification/submissions/${subId}`, null, biz);
    check('the owner can list reports for the submission', history.status === 200 && history.body.length === 1, history.body);
    check('another business cannot request a report (403)', (await api('POST', `/api/verification/submissions/${subId}`, null, other)).status === 403);
    check('another business cannot read reports (403)', (await api('GET', `/api/verification/submissions/${subId}`, null, other)).status === 403);
    check('a worker cannot request a report (403)', (await api('POST', `/api/verification/submissions/${subId}`, null, w1)).status === 403);
    check('an invalid submission id is rejected (400)', (await api('POST', '/api/verification/submissions/not-a-uuid', null, biz)).status === 400);

    // Approve the submission, so reputation has verified work to count.
    const approved = await api('POST', `/api/submissions/${subId}/approve`, null, biz);
    check('the owner approves the submission', approved.status === 200, approved.body);

    const rep = await api('GET', `/api/reputation/${w1Id}`);
    check('reputation is public and lists the approved industry', rep.status === 200 && rep.body.industries.some((i) => i.industry === 'dev' && i.verified_completed >= 1), rep.body);
    check('reputation shows on-time completion', rep.body.industries.find((i) => i.industry === 'dev').on_time_rate === 1, rep.body);
    check('reputation exposes no client names or contact details', !/@|biz|other/i.test(JSON.stringify(rep.body)));
    check('reputation for a non-worker is not found (404)', (await api('GET', `/api/reputation/${bizId}`)).status === 404);
    const profile = await api('GET', `/api/profile/worker/${w1Id}`);
    check('the public worker profile includes reputation', profile.status === 200 && Array.isArray(profile.body.reputation?.industries), profile.body);
    const noRep = await api('GET', `/api/reputation/${w2Id}`);
    check('a worker with no approved work gets an empty reputation', noRep.status === 200 && noRep.body.industries.length === 0);

    // Milestones
    const proj = await api('POST', '/api/projects', {
        title: 'Storefront build', description: 'A milestone-based storefront build for the test.',
        tasks: [{ title: 'Storefront placeholder', description: 'Placeholder task for the milestone project.', category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz);
    const projectId = proj.body.id;
    const milestoneBody = (extra) => ({ title: 'Research and planning', deliverables: 'A written plan', acceptance_criteria: 'Owner agrees the plan', budget: 300, ...extra });

    const m1 = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Research and planning', worker_id: w1Id }), biz);
    check('the owner creates milestone one with a worker', m1.status === 201 && m1.body.worker_id === w1Id, m1.body);
    const m2 = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Backend build', worker_id: w1Id, depends_on: [m1.body.id] }), biz);
    check('milestone two depends on milestone one', m2.status === 201 && m2.body.depends_on.length === 1, m2.body);
    const m3 = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Testing and delivery', worker_id: w2Id }), biz);
    check('milestone three is created', m3.status === 201, m3.body);

    // Planned milestones reserved for the dependency-loop checks.
    const loopA = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Loop A' }), biz);
    const loopB = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Loop B', depends_on: [loopA.body.id] }), biz);
    const raceA = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Race A' }), biz);
    const raceB = await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ title: 'Race B' }), biz);
    check('loop and race milestones are created', [loopA, loopB, raceA, raceB].every((r) => r.status === 201));

    // Project budget cap, on a fresh project so the milestones above do not count against it.
    const capProj = await api('POST', '/api/projects', {
        title: 'Budget cap project', description: 'A project used to check the project budget cap.',
        tasks: [{ title: 'Cap placeholder task', description: 'Placeholder task for the budget cap checks.', category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz);
    const capId = capProj.body.id;
    const setCap = (value, token = biz) => api('PATCH', `/api/milestones/project/${capId}/budget`, { total_budget: value }, token);
    const setCapRes = await setCap(500);
    check('the owner sets a project budget (200)', setCapRes.status === 200 && setCapRes.body.total === 500 && setCapRes.body.remaining === 500, setCapRes.body);
    check('a budget must be a number or null (400)', (await api('PATCH', `/api/milestones/project/${capId}/budget`, { total_budget: 'lots' }, biz)).status === 400);
    check('a budget is required in the request (400)', (await api('PATCH', `/api/milestones/project/${capId}/budget`, {}, biz)).status === 400);
    check('a negative budget is refused (400)', (await setCap(-5)).status === 400);
    check('another business cannot set the budget (403)', (await setCap(900, other)).status === 403);
    const capA = await api('POST', `/api/milestones/project/${capId}`, milestoneBody({ title: 'Capped stage one', budget: 300 }), biz);
    check('a milestone within the budget is created', capA.status === 201, capA.body);
    const over = await api('POST', `/api/milestones/project/${capId}`, milestoneBody({ title: 'Capped stage two', budget: 250 }), biz);
    check('a milestone over the remaining budget is refused (400)', over.status === 400 && /above the project budget/.test(over.body.message || ''), over.body);
    const capB = await api('POST', `/api/milestones/project/${capId}`, milestoneBody({ title: 'Capped stage three', budget: 200 }), biz);
    check('a milestone that lands exactly on the budget is created', capB.status === 201, capB.body);
    check('the budget cannot be lowered below what milestones allocate (409)', (await setCap(400)).status === 409);
    const edgeOver = await api('PATCH', `/api/milestones/${capB.body.id}`, { budget: 260 }, biz);
    check('editing a milestone past the budget is refused (400)', edgeOver.status === 400, edgeOver.body);
    const edgeOk = await api('PATCH', `/api/milestones/${capB.body.id}`, { budget: 200 }, biz);
    check('editing a milestone within the budget is allowed', edgeOk.status === 200, edgeOk.body);
    const capList = await api('GET', `/api/milestones/project/${capId}`, null, biz);
    check('the owner sees the budget summary', capList.status === 200 && capList.body.project_budget.total === 500 && capList.body.project_budget.allocated === 500 && capList.body.project_budget.remaining === 0, capList.body.project_budget);
    const workerView = await api('GET', `/api/milestones/project/${capId}`, null, w1);
    check('workers do not see the project budget summary', workerView.status === 200 && workerView.body.project_budget === undefined);
    const cleared = await setCap(null);
    check('the cap can be cleared with null (200)', cleared.status === 200 && cleared.body.total === null, cleared.body);
    check('with the cap cleared a milestone over the old budget is allowed',
        (await api('POST', `/api/milestones/project/${capId}`, milestoneBody({ title: 'Uncapped stage', budget: 900 }), biz)).status === 201);

    // Two simultaneous milestones that each fit alone but not together: exactly one succeeds.
    const raceProj = await api('POST', '/api/projects', {
        title: 'Budget race project', description: 'A project used to check concurrent budget allocation.',
        tasks: [{ title: 'Race placeholder task', description: 'Placeholder task for the budget race check.', category: 'dev', difficulty: 'easy', reward_amount: 75, deadline: inDays(5), submission_type: 'github', acceptance_criteria: [] }],
    }, biz);
    await api('PATCH', `/api/milestones/project/${raceProj.body.id}/budget`, { total_budget: 300 }, biz);
    const raced = await Promise.all([1, 2].map((i) => api('POST', `/api/milestones/project/${raceProj.body.id}`, milestoneBody({ title: `Race stage ${i}`, budget: 200 }), biz)));
    const raceCodes = raced.map((r) => r.status).sort();
    check('two simultaneous milestones that exceed the budget together give exactly one success', JSON.stringify(raceCodes) === JSON.stringify([201, 400]), raceCodes);

    check('a worker cannot create milestones (403)', (await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({}), w1)).status === 403);
    check('another business cannot create milestones (403)', (await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({}), other)).status === 403);
    check('a dependency from another project is rejected (400)', (await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ depends_on: [subId] }), biz)).status === 400);
    check('a non-worker cannot be assigned (400)', (await api('POST', `/api/milestones/project/${projectId}`, milestoneBody({ worker_id: bizId }), biz)).status === 400);

    const ownerView = await api('GET', `/api/milestones/project/${projectId}`, null, biz);
    check('the owner sees every milestone in the project', ownerView.body.milestones.length === 7, ownerView.body);
    const w1View = await api('GET', `/api/milestones/project/${projectId}`, null, w1);
    check('a worker sees only their own milestones', w1View.body.milestones.length === 2 && w1View.body.role === 'worker', w1View.body);
    const w2NotAssigned = await api('GET', `/api/milestones/project/${projectId}`, null, w2);
    check('a worker sees only the milestone assigned to them', w2NotAssigned.body.milestones.length === 1, w2NotAssigned.body);
    check('another business cannot read the project (403)', (await api('GET', `/api/milestones/project/${projectId}`, null, other)).status === 403);

    const id1 = m1.body.id;
    const id2 = m2.body.id;
    const id3 = m3.body.id;
    const blocked = await api('POST', `/api/milestones/${id2}/start`, null, w1);
    check('a dependent milestone cannot start before its dependency is approved (409)', blocked.status === 409, blocked.body);
    check('the blocked start names what it waits for', /Research and planning/.test(blocked.body.error || blocked.body.message || JSON.stringify(blocked.body)));
    check('a worker cannot start a milestone assigned to someone else (403)', (await api('POST', `/api/milestones/${id1}/start`, null, w2)).status === 403);

    // Two simultaneous starts: exactly one may win.
    const starts = await Promise.all([1, 2].map(() => api('POST', `/api/milestones/${id1}/start`, null, w1)));
    const startCodes = starts.map((r) => r.status).sort();
    check('two simultaneous starts give exactly one success', JSON.stringify(startCodes) === JSON.stringify([200, 409]), startCodes);

    const shortSub = await api('POST', `/api/milestones/${id1}/submit`, { submission_text: 'too short' }, w1);
    check('a very short milestone submission is rejected (400)', shortSub.status === 400);
    const badLink = await api('POST', `/api/milestones/${id1}/submit`, { submission_text: 'A written plan covering the research scope and the timetable.', submission_link: 'http://insecure.example' }, w1);
    check('a milestone link must be https (400)', badLink.status === 400);
    const sub1 = await api('POST', `/api/milestones/${id1}/submit`, { submission_text: 'A written plan covering the research scope and the agreed timetable for the build.', submission_link: 'https://docs.example.com/plan' }, w1);
    check('the worker submits milestone one', sub1.status === 200 && sub1.body.status === 'submitted', sub1.body);
    const sub1Again = await api('POST', `/api/milestones/${id1}/submit`, { submission_text: 'A written plan covering the research scope and the agreed timetable for the build.' }, w1);
    check('a second submit while submitted is rejected (409)', sub1Again.status === 409);

    const badRevision = await api('POST', `/api/milestones/${id1}/request-revision`, { notes: 'no' }, biz);
    check('a revision request needs an explanation (400)', badRevision.status === 400);
    const rev = await api('POST', `/api/milestones/${id1}/request-revision`, { notes: 'Add the risks section and the budget breakdown.' }, biz);
    check('the owner requests a revision', rev.status === 200 && rev.body.status === 'revision_requested', rev.body);
    const sub1b = await api('POST', `/api/milestones/${id1}/submit`, { submission_text: 'A revised plan with the risks section and the budget breakdown added as requested.' }, w1);
    check('the worker resubmits after a revision request', sub1b.status === 200 && sub1b.body.status === 'submitted', sub1b.body);

    check('a worker cannot approve (403)', (await api('POST', `/api/milestones/${id1}/approve`, null, w1)).status === 403);
    check('another business cannot approve (403)', (await api('POST', `/api/milestones/${id1}/approve`, null, other)).status === 403);

    // Two simultaneous approvals: exactly one approval and one eligibility record.
    const approvals = await Promise.all([1, 2].map(() => api('POST', `/api/milestones/${id1}/approve`, null, biz)));
    const approveCodes = approvals.map((r) => r.status).sort();
    check('two simultaneous approvals give exactly one success', JSON.stringify(approveCodes) === JSON.stringify([200, 409]), approveCodes);
    const elig = await db.query("SELECT COUNT(*)::int AS n, MAX(amount)::float AS amount FROM payment_eligibilities WHERE source_type = 'milestone' AND source_id = $1", [id1]);
    check('exactly one payment eligibility record exists for the approved milestone', elig.rows[0].n === 1, elig.rows[0]);
    check('the eligibility record carries the milestone budget', elig.rows[0].amount === 300, elig.rows[0]);
    check('the approval reports payment as eligible, not paid', approvals.some((r) => r.body && r.body.payment_status === 'eligible'));

    const started2 = await api('POST', `/api/milestones/${id2}/start`, null, w1);
    check('the dependent milestone starts once its dependency is approved', started2.status === 200 && started2.body.status === 'in_progress', started2.body);

    // Dependency edits: cycles and self-dependency are rejected.
    check('a self-dependency is rejected (400)', (await api('PATCH', `/api/milestones/${id3}`, { depends_on: [id3] }, biz)).status === 400);
    const loop = await api('PATCH', `/api/milestones/${loopA.body.id}`, { depends_on: [loopB.body.id] }, biz);
    check('a dependency loop is rejected (400)', loop.status === 400, loop.body);
    check('an approved milestone cannot be edited (409)', (await api('PATCH', `/api/milestones/${id1}`, { title: 'Changed' }, biz)).status === 409);
    check('a worker cannot edit a milestone (403)', (await api('PATCH', `/api/milestones/${id3}`, { title: 'Hacked' }, w2)).status === 403);

    // Two simultaneous dependency edits that would form a loop: exactly one may succeed.
    const edits = await Promise.all([
        api('PATCH', `/api/milestones/${raceA.body.id}`, { depends_on: [raceB.body.id] }, biz),
        api('PATCH', `/api/milestones/${raceB.body.id}`, { depends_on: [raceA.body.id] }, biz),
    ]);
    const editCodes = edits.map((r) => r.status).sort();
    check('two simultaneous edits that form a loop: one succeeds, one is rejected', JSON.stringify(editCodes) === JSON.stringify([200, 400]), editCodes);
    const loopRows = await db.query(`SELECT COUNT(*)::int AS n FROM milestone_dependencies WHERE (milestone_id = $1 AND depends_on_id = $2) OR (milestone_id = $2 AND depends_on_id = $1)`, [raceA.body.id, raceB.body.id]);
    check('the database holds no loop after the race', loopRows.rows[0].n <= 1, loopRows.rows[0]);

    const events = await api('GET', `/api/milestones/${id1}/events`, null, biz);
    check('the owner can read the milestone audit trail', events.status === 200 && events.body.some((e) => e.event === 'approved'), events.body);
    check('the assigned worker can read the audit trail', (await api('GET', `/api/milestones/${id1}/events`, null, w1)).status === 200);
    check('another worker cannot read the audit trail (403)', (await api('GET', `/api/milestones/${id1}/events`, null, w2)).status === 403);
    check('another business cannot read the audit trail (403)', (await api('GET', `/api/milestones/${id1}/events`, null, other)).status === 403);

    await db.end();
    console.log(`\nAll ${passed} phase 1 checks passed.`);
    process.exit(0);
})().catch(async(err) => {
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
});
