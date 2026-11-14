// scripts/creator-protection-test.js — Creator Protection, task NDA, reports and enforcement.
// Usage: BASE=http://localhost:3100 DATABASE_URL=... node scripts/creator-protection-test.js
// Accounts are verified and promoted directly in the test database (fixtures only).

const BASE = process.env.BASE || 'http://localhost:3100';
const { pool } = require('../db');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
    if (condition) { passed++; console.log('  ✓', label); }
    else { failed++; console.log('  ✗', label, detail === undefined ? '' : JSON.stringify(detail)); }
}

async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const stamp = Date.now();
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const GOOD = 'Creator protection test submission: implemented the requested change and tested it locally before review.';
const SECRET = `SECRET-${stamp}-do-not-leak`;

async function account(role, name, { admin = false } = {}) {
    const email = `cp-${role}-${name.replace(/\W/g, '').toLowerCase()}-${stamp}@example.com`;
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name, role });
    if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
    await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [r.body.id]);
    if (admin) await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [r.body.id]);
    return { id: r.body.id, token: r.body.token, role };
}

async function run() {
    console.log('\n=== Agreement catalogue ===');
    const cat = await api('GET', '/api/protection/agreements');
    const kinds = (cat.body && cat.body.agreements || []).map((a) => a.kind).sort();
    check('the three agreements are published', JSON.stringify(kinds) === JSON.stringify(['creator_protection_business', 'task_nda', 'worker_submission_ip']), kinds);
    check('every agreement carries a SHA-256 of its text', (cat.body.agreements || []).every((a) => /^[0-9a-f]{64}$/.test(a.body_sha256)));
    check('agreements are marked as drafts pending legal review', (cat.body.agreements || []).every((a) => /DRAFT/.test(a.body)));

    const biz = await account('business', 'Cp Biz');
    const other = await account('business', 'Cp Other Biz');
    const w1 = await account('worker', 'Cp Worker One');
    const w2 = await account('worker', 'Cp Worker Two');
    const admin = await account('worker', 'Cp Admin', { admin: true });

    console.log('\n=== Publishing requires the Creator Protection Agreement ===');
    const blocked = await api('POST', '/api/bounties', {
        title: 'CP gated task', description: 'Should be refused until the agreement is accepted.',
        category: 'dev', difficulty: 'easy', reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    check('a business that has not accepted is refused with 428', blocked.status === 428, blocked.body);
    check('the refusal names the agreement and carries its text', blocked.body && blocked.body.code === 'agreement_required' && blocked.body.kind === 'creator_protection_business' && /Viewing a submission/.test(blocked.body.body || ''), blocked.body);

    const wrongRole = await api('POST', '/api/protection/agreements/accept', { kind: 'creator_protection_business' }, w1.token);
    check('a worker cannot accept the business agreement (403)', wrongRole.status === 403, wrongRole.body);

    const accept1 = await api('POST', '/api/protection/agreements/accept', { kind: 'creator_protection_business' }, biz.token);
    const accept2 = await api('POST', '/api/protection/agreements/accept', { kind: 'creator_protection_business' }, biz.token);
    check('the business accepts the agreement', accept1.status === 200 && accept2.status === 200, accept1.body);
    const { rows: acceptRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM agreement_acceptances WHERE user_id = $1 AND kind = 'creator_protection_business'`, [biz.id]);
    check('repeat acceptance is recorded once', acceptRows[0].n === 1, acceptRows[0]);

    const published = await api('POST', '/api/bounties', {
        title: 'CP open task', description: 'A normal task after acceptance.',
        category: 'dev', difficulty: 'easy', reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    check('after acceptance the business publishes (201)', published.status === 201, published.body);
    const openId = published.body.id;

    console.log('\n=== Submitting requires the Worker Submission Agreement ===');
    const noAgreement = await api('POST', '/api/submissions', { bounty_id: openId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/work' }, w1.token);
    check('a worker who has not accepted is refused with 428', noAgreement.status === 428 && noAgreement.body.kind === 'worker_submission_ip', noAgreement.body);
    const wAccept = await api('POST', '/api/protection/agreements/accept', { kind: 'worker_submission_ip' }, w1.token);
    check('the worker accepts the submission agreement', wAccept.status === 200, wAccept.body);
    await api('POST', '/api/protection/agreements/accept', { kind: 'worker_submission_ip' }, w2.token);

    const sub1 = await api('POST', '/api/submissions', { bounty_id: openId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/work-one' }, w1.token);
    check('worker one submits after acceptance (201)', sub1.status === 201, sub1.body);
    const sub2 = await api('POST', '/api/submissions', { bounty_id: openId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/work-two' }, w2.token);
    check('worker two submits after acceptance (201)', sub2.status === 201, sub2.body);

    console.log('\n=== Confidential tasks: NDA gating ===');
    const conf = await api('POST', '/api/bounties', {
        title: 'CP confidential task', description: SECRET, category: 'dev', difficulty: 'easy',
        reward_amount: 150, deadline: inDays(5), submission_type: 'github', confidential: true,
    }, biz.token);
    check('the business publishes a confidential task (201)', conf.status === 201, conf.body);
    const confId = conf.body.id;

    const asOther = await api('GET', `/api/bounties/${confId}`, null, w2.token);
    check('a worker outside the task sees no restricted text', asOther.status === 200 && !JSON.stringify(asOther.body).includes(SECRET), asOther.status);
    check('the detail marks the material restricted and NDA-required', asOther.body.restricted === true && asOther.body.nda_required === true && asOther.body.description === null, asOther.body);

    const anon = await api('GET', `/api/bounties/${confId}`);
    check('an anonymous visitor sees no restricted text', anon.status === 200 && !JSON.stringify(anon.body).includes(SECRET), anon.status);

    const takeNoNda = await api('POST', `/api/bounties/${confId}/accept`, {}, w2.token);
    check('taking a confidential task without the NDA is refused with 428', takeNoNda.status === 428 && takeNoNda.body.code === 'nda_required' && takeNoNda.body.bounty_id === confId, takeNoNda.body);

    const ndaOpen = await api('POST', '/api/protection/agreements/accept', { kind: 'task_nda', bounty_id: confId }, w2.token);
    check('the worker accepts the task NDA', ndaOpen.status === 200, ndaOpen.body);
    const stillOutside = await api('GET', `/api/bounties/${confId}`, null, w2.token);
    check('an NDA alone does not open the material without a place on the task', !JSON.stringify(stillOutside.body).includes(SECRET), stillOutside.status);

    const subNoPlace = await api('POST', '/api/submissions', { bounty_id: confId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/conf-work' }, w2.token);
    check('submitting to a confidential task without a place is refused (403)', subNoPlace.status === 403, subNoPlace.body);

    const takeWithNda = await api('POST', `/api/bounties/${confId}/accept`, {}, w2.token);
    check('with the NDA accepted the worker takes the task', takeWithNda.status === 200 || takeWithNda.status === 201, takeWithNda.body);
    const inside = await api('GET', `/api/bounties/${confId}`, null, w2.token);
    check('the participant sees the task material', JSON.stringify(inside.body).includes(SECRET), inside.status);

    const sub3 = await api('POST', '/api/submissions', { bounty_id: confId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/conf-work-2' }, w2.token);
    check('the participant can submit to the confidential task (201)', sub3.status === 201, sub3.body);

    const records = await api('GET', `/api/protection/business/nda-records?bounty_id=${confId}`, null, biz.token);
    check('the owning business sees its NDA acceptance records', records.status === 200 && records.body.records.length === 1, records.body);
    const recordsOther = await api('GET', `/api/protection/business/nda-records?bounty_id=${confId}`, null, other.token);
    check('another business cannot see those records (404)', recordsOther.status === 404, recordsOther.body);
    const recordsWorker = await api('GET', `/api/protection/business/nda-records?bounty_id=${confId}`, null, w2.token);
    check('a worker cannot see NDA records (403)', recordsWorker.status === 403, recordsWorker.body);

    console.log('\n=== Revocation ===');
    const revoke = await api('POST', `/api/protection/bounties/${confId}/revoke-access`, { worker_id: w2.id }, biz.token);
    check('the owner revokes the worker from the task', revoke.status === 200, revoke.body);
    const afterRevoke = await api('GET', `/api/bounties/${confId}`, null, w2.token);
    check('after revocation the material is hidden again', !JSON.stringify(afterRevoke.body).includes(SECRET) && afterRevoke.body.restricted === true, afterRevoke.status);
    const subAfter = await api('POST', '/api/submissions', { bounty_id: confId, title: 'Work', description: GOOD, github_link: 'https://github.com/example/after-revoke' }, w2.token);
    check('after revocation the worker cannot submit (403)', subAfter.status === 403, subAfter.body);
    const recordsKept = await api('GET', `/api/protection/business/nda-records?bounty_id=${confId}`, null, biz.token);
    check('the NDA acceptance stays on record after revocation', recordsKept.body.records.length === 1, recordsKept.body);
    const revokeOther = await api('POST', `/api/protection/bounties/${confId}/revoke-access`, { worker_id: w1.id }, other.token);
    check('a business cannot revoke access on someone else\'s task (404)', revokeOther.status === 404, revokeOther.body);

    console.log('\n=== Reports ===');
    const rep = await api('POST', '/api/protection/reports', {
        kind: 'copyright_misuse', bounty_id: openId, submission_id: sub1.body.id,
        description: 'The business used my submission in a published advert without a licence.',
        evidence: 'https://example.com/advert-screenshot',
    }, w1.token);
    check('a worker reports misuse of their own submission (201)', rep.status === 201, rep.body);
    const reportId = rep.body && rep.body.report && rep.body.report.id;

    const repOther = await api('POST', '/api/protection/reports', {
        kind: 'copyright_misuse', bounty_id: openId, submission_id: sub2.body.id,
        description: 'Trying to report someone else\'s work.',
    }, w1.token);
    check('a worker cannot report misuse of another worker\'s submission (403)', repOther.status === 403, repOther.body);

    const repBiz = await api('POST', '/api/protection/reports', {
        kind: 'copyright_misuse', bounty_id: openId, description: 'Business filing a copyright report.',
    }, biz.token);
    check('a copyright report needs the worker\'s own submission (400)', repBiz.status === 400, repBiz.body);

    const incident = await api('POST', '/api/protection/reports', {
        kind: 'confidentiality_incident', bounty_id: confId, description: 'I pasted a link to the task brief into a public forum by mistake.',
    }, w2.token);
    check('a worker who was on the task reports a confidentiality incident (201)', incident.status === 201, incident.body);
    const incidentOutsider = await api('POST', '/api/protection/reports', {
        kind: 'confidentiality_incident', bounty_id: confId, description: 'I was not on this task.',
    }, w1.token);
    check('a worker not on the task cannot file an incident for it (403)', incidentOutsider.status === 403, incidentOutsider.body);

    const mine = await api('GET', '/api/protection/reports/mine', null, w1.token);
    check('the reporter sees their own report status', mine.status === 200 && mine.body.reports.some((r) => r.id === reportId), mine.body);
    check('the reporter does not see internal findings', !JSON.stringify(mine.body).includes('findings'));

    console.log('\n=== Admin access and report review ===');
    check('a worker cannot list reports (403)', (await api('GET', '/api/protection/admin/reports', null, w1.token)).status === 403);
    check('an anonymous visitor cannot list reports (401)', (await api('GET', '/api/protection/admin/reports')).status === 401);

    const list = await api('GET', '/api/protection/admin/reports?status=submitted', null, admin.token);
    check('the admin lists submitted reports', list.status === 200 && list.body.reports.some((r) => r.id === reportId), list.body);

    const detail = await api('GET', `/api/protection/admin/reports/${reportId}`, null, admin.token);
    check('the admin sees the report with its audit trail', detail.status === 200 && detail.body.audit.some((a) => a.action === 'report.submitted'), detail.body);

    const skip = await api('PATCH', `/api/protection/admin/reports/${reportId}`, { status: 'resolved', findings: 'x' }, admin.token);
    check('a report cannot jump straight to resolved (400)', skip.status === 400, skip.body);
    const toReview = await api('PATCH', `/api/protection/admin/reports/${reportId}`, { status: 'under_review' }, admin.token);
    check('the admin moves the report to under review', toReview.status === 200, toReview.body);
    const noFindings = await api('PATCH', `/api/protection/admin/reports/${reportId}`, { status: 'resolved' }, admin.token);
    check('closing a report needs recorded findings (400)', noFindings.status === 400, noFindings.body);

    console.log('\n=== Enforcement, reversal and appeals ===');
    const restrict = await api('POST', '/api/protection/admin/enforcement', {
        user_id: biz.id, action: 'restrict_publishing', reason: 'Under review: alleged unlicensed use.', report_id: reportId,
    }, admin.token);
    check('the admin restricts the accused business (201)', restrict.status === 201, restrict.body);
    const restrictedPost = await api('POST', '/api/bounties', {
        title: 'Should be blocked', description: 'Restricted account.', category: 'dev', difficulty: 'easy',
        reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    check('a restricted business cannot publish (403)', restrictedPost.status === 403, restrictedPost.body);

    const selfEnforce = await api('POST', '/api/protection/admin/enforcement', {
        user_id: admin.id, action: 'warning', reason: 'Testing self enforcement.',
    }, admin.token);
    check('an admin cannot enforce against their own account (400)', selfEnforce.status === 400, selfEnforce.body);
    const noReason = await api('POST', '/api/protection/admin/enforcement', { user_id: biz.id, action: 'warning', reason: '' }, admin.token);
    check('enforcement needs a reason (400)', noReason.status === 400, noReason.body);

    const history = await api('GET', `/api/protection/admin/enforcement?user_id=${biz.id}`, null, admin.token);
    const restrictAction = history.body.actions && history.body.actions.find((a) => a.action === 'restrict_publishing');
    check('the enforcement is recorded in the log', !!restrictAction, history.body);

    const reverse = await api('POST', `/api/protection/admin/enforcement/${restrictAction.id}/reverse`, { reason: 'Review found the use was licensed.' }, admin.token);
    check('the admin reverses the restriction', reverse.status === 200, reverse.body);
    const reverseAgain = await api('POST', `/api/protection/admin/enforcement/${restrictAction.id}/reverse`, { reason: 'Again.' }, admin.token);
    check('the same action cannot be reversed twice (409)', reverseAgain.status === 409, reverseAgain.body);
    const postAfterReverse = await api('POST', '/api/bounties', {
        title: 'CP after reversal', description: 'Allowed again.', category: 'dev', difficulty: 'easy',
        reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    check('after reversal the business can publish again (201)', postAfterReverse.status === 201, postAfterReverse.body);

    const suspend = await api('POST', '/api/protection/admin/enforcement', {
        user_id: biz.id, action: 'suspend', reason: 'Confirmed unlicensed use in a second report.',
    }, admin.token);
    check('the admin suspends the business (201)', suspend.status === 201, suspend.body);
    const suspendedPost = await api('POST', '/api/bounties', {
        title: 'Should be blocked too', description: 'Suspended.', category: 'dev', difficulty: 'easy',
        reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    check('a suspended business cannot publish (403)', suspendedPost.status === 403, suspendedPost.body);

    const suspendAction = (await api('GET', `/api/protection/admin/enforcement?user_id=${biz.id}`, null, admin.token)).body.actions.find((a) => a.action === 'suspend');
    const appeal = await api('POST', `/api/protection/enforcement/${suspendAction.id}/appeal`, { statement: 'The use was licensed; I can provide the licence.' }, biz.token);
    check('the suspended business can appeal (201)', appeal.status === 201, appeal.body);
    const appeal2 = await api('POST', `/api/protection/enforcement/${suspendAction.id}/appeal`, { statement: 'Second appeal.' }, biz.token);
    check('a second appeal for the same action is refused (409)', appeal2.status === 409, appeal2.body);
    const otherAppeal = await api('POST', `/api/protection/enforcement/${suspendAction.id}/appeal`, { statement: 'Not my action.' }, other.token);
    check('another user cannot appeal this action (404)', otherAppeal.status === 404, otherAppeal.body);

    const decide = await api('POST', `/api/protection/admin/appeals/${appeal.body.appeal.id}/decide`, { decision: 'upheld', note: 'Licence not provided in time.' }, admin.token);
    check('the admin upholds the appeal', decide.status === 200, decide.body);
    const decideAgain = await api('POST', `/api/protection/admin/appeals/${appeal.body.appeal.id}/decide`, { decision: 'overturned', note: 'Changed mind.' }, admin.token);
    check('a decided appeal cannot be decided again (409)', decideAgain.status === 409, decideAgain.body);

    const reAppeal = await api('POST', `/api/protection/enforcement/${suspendAction.id}/appeal`, { statement: 'New evidence.' }, biz.token);
    check('an upheld appeal cannot be re-filed on the same action (409)', reAppeal.status === 409, reAppeal.body);

    const { rows: stillSuspended } = await pool.query('SELECT account_status FROM users WHERE id = $1', [biz.id]);
    check('the suspension is still in force after an upheld appeal', stillSuspended[0].account_status === 'suspended', stillSuspended[0]);

    const adminReverse = await api('POST', `/api/protection/admin/enforcement/${suspendAction.id}/reverse`, { reason: 'Reversed by admin after review.' }, admin.token);
    check('the admin can reverse the suspension', adminReverse.status === 200, adminReverse.body);
    const { rows: afterReverse } = await pool.query('SELECT account_status FROM users WHERE id = $1', [biz.id]);
    check('the account returns to active after reversal', afterReverse[0].account_status === 'active', afterReverse[0]);

    const ownEnforcement = await api('GET', '/api/protection/enforcement/mine', null, biz.token);
    check('the business can list its own enforcement (200)', ownEnforcement.status === 200, ownEnforcement.body);
    check('its list includes the suspension action', JSON.stringify(ownEnforcement.body).includes(suspendAction.id), ownEnforcement.body);
    const otherEnforcement = await api('GET', '/api/protection/enforcement/mine', null, other.token);
    check('another user\'s enforcement list does not include this action', !JSON.stringify(otherEnforcement.body).includes(suspendAction.id), otherEnforcement.body);

    const adminAppeals = await api('GET', '/api/protection/admin/appeals?status=upheld', null, admin.token);
    check('the admin appeals queue lists the decided appeal', adminAppeals.status === 200 && JSON.stringify(adminAppeals.body).includes(appeal.body.appeal.id), adminAppeals.body);
    const appealsAsBiz = await api('GET', '/api/protection/admin/appeals', null, biz.token);
    check('a business cannot read the admin appeals queue (403)', appealsAsBiz.status === 403, appealsAsBiz.body);

    const confTasks = await api('GET', '/api/protection/business/confidential-tasks', null, biz.token);
    check('a business can list its confidential tasks (200)', confTasks.status === 200, confTasks.body);
    const confTasksWorker = await api('GET', '/api/protection/business/confidential-tasks', null, w1.token);
    check('a worker cannot list business confidential tasks (403)', confTasksWorker.status === 403, confTasksWorker.body);

    const toClosed = await api('PATCH', `/api/protection/admin/reports/${reportId}`, { status: 'resolved', findings: 'Use was licensed; enforcement reversed. Recorded for the file.' }, admin.token);
    check('the admin resolves the report with findings', toClosed.status === 200, toClosed.body);
    const reopen = await api('PATCH', `/api/protection/admin/reports/${reportId}`, { status: 'under_review' }, admin.token);
    check('a resolved report cannot be reopened (400)', reopen.status === 400, reopen.body);

    console.log('\n=== Workspace on confidential tasks ===');
    const msgBiz = await api('POST', `/api/bounties/${confId}/messages`, { body: 'Brief attached in the task.' }, biz.token);
    check('the owning business can post in the task workspace (201)', msgBiz.status === 201, msgBiz.body);
    const msgsBiz = await api('GET', `/api/bounties/${confId}/messages`, null, biz.token);
    check('the owning business can read the task workspace (200)', msgsBiz.status === 200, msgsBiz.body);
    const msgsRevoked = await api('GET', `/api/bounties/${confId}/messages`, null, w2.token);
    check('a revoked worker who still has a submission cannot read messages (403)', msgsRevoked.status === 403, msgsRevoked.body);
    const postRevoked = await api('POST', `/api/bounties/${confId}/messages`, { body: 'Still here?' }, w2.token);
    check('a revoked worker cannot post messages (403)', postRevoked.status === 403, postRevoked.body);
    const wsRevoked = await api('GET', `/api/workspace/${confId}`, null, w2.token);
    check('a revoked worker cannot open the workspace endpoint (403)', wsRevoked.status === 403, wsRevoked.body);
    const wsBiz = await api('GET', `/api/workspace/${confId}`, null, biz.token);
    check('the owning business can open the workspace endpoint', wsBiz.status === 200, wsBiz.status);
    const msgsOpen = await api('GET', `/api/bounties/${openId}/messages`, null, w1.token);
    check('a worker on an ordinary (non-confidential) task still reads messages (200)', msgsOpen.status === 200, msgsOpen.body);

    console.log('\n=== Termination (permanent, legal-review gated) ===');
    const termNoLegal = await api('POST', '/api/protection/admin/enforcement', {
        user_id: biz.id, action: 'terminate', reason: 'Repeated unlicensed use.', report_id: reportId,
    }, admin.token);
    check('termination without legal review confirmation is refused (400)', termNoLegal.status === 400, termNoLegal.body);
    const termWrongAccount = await api('POST', '/api/protection/admin/enforcement', {
        user_id: other.id, action: 'terminate', reason: 'Wrong account.', report_id: reportId, legal_review_confirmed: true,
    }, admin.token);
    check('termination needs a report about this account (400)', termWrongAccount.status === 400, termWrongAccount.body);
    const termNoReport = await api('POST', '/api/protection/admin/enforcement', {
        user_id: other.id, action: 'terminate', reason: 'No report.', legal_review_confirmed: true,
    }, admin.token);
    check('termination needs a supporting report (400)', termNoReport.status === 400, termNoReport.body);
    const term = await api('POST', '/api/protection/admin/enforcement', {
        user_id: biz.id, action: 'terminate', reason: 'Confirmed repeated unlicensed use after legal review.',
        report_id: reportId, legal_review_confirmed: true,
    }, admin.token);
    check('the admin terminates the account after legal review (201)', term.status === 201, term.body);
    const { rows: termRow } = await pool.query('SELECT account_status FROM users WHERE id = $1', [biz.id]);
    check('the account is marked terminated', termRow[0].account_status === 'terminated', termRow[0]);
    const termPost = await api('POST', '/api/bounties', {
        title: 'After termination', description: 'Should be refused.', category: 'dev', difficulty: 'easy',
        reward_amount: 100, deadline: inDays(5), submission_type: 'github',
    }, biz.token);
    check('a terminated business cannot publish (403)', termPost.status === 403, termPost.body);
    const termReverse = await api('POST', `/api/protection/admin/enforcement/${term.body.id}/reverse`, { reason: 'Try to undo.' }, admin.token);
    check('termination cannot be reversed through the API (403)', termReverse.status === 403, termReverse.body);
    const termAppeal = await api('POST', `/api/protection/enforcement/${term.body.id}/appeal`, { statement: 'Appeal.' }, biz.token);
    check('termination is not appealable through the form (403)', termAppeal.status === 403, termAppeal.body);
    const { rows: stillTerm } = await pool.query('SELECT account_status FROM users WHERE id = $1', [biz.id]);
    check('the termination holds after the reversal attempt', stillTerm[0].account_status === 'terminated', stillTerm[0]);

    console.log('\n=== Append-only evidence ===');
    const { rows: probe } = await pool.query(`INSERT INTO audit_events (action, entity_type) VALUES ('test.probe', 'test') RETURNING id`);
    let updateBlocked = false;
    try { await pool.query(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [probe[0].id]); } catch (e) { updateBlocked = /append-only/.test(e.message); }
    check('the audit trail cannot be updated, even by the application', updateBlocked);
    let deleteBlocked = false;
    try { await pool.query(`DELETE FROM audit_events WHERE id = $1`, [probe[0].id]); } catch (e) { deleteBlocked = /append-only/.test(e.message); }
    check('the audit trail cannot be deleted, even by the application', deleteBlocked);

    const { rows: acceptedRows } = await pool.query(`SELECT id FROM agreement_acceptances WHERE user_id = $1 LIMIT 1`, [biz.id]);
    let acceptanceUpdateBlocked = false;
    try { await pool.query(`UPDATE agreement_acceptances SET version = 'changed' WHERE id = $1`, [acceptedRows[0].id]); } catch (e) { acceptanceUpdateBlocked = /append-only/.test(e.message); }
    check('a business cannot rewrite an agreement it accepted', acceptanceUpdateBlocked);

    const { rows: auditRows } = await pool.query(
        `SELECT action FROM audit_events WHERE actor_id = ANY($1::uuid[])`, [[biz.id, w1.id, w2.id, admin.id]]);
    const actions = new Set(auditRows.map((r) => r.action));
    check('the audit trail records the key events',
        ['agreement.accepted', 'nda.accepted', 'access.revoked', 'report.submitted', 'report.status_changed',
            'enforcement.restrict_publishing', 'enforcement.suspend', 'enforcement.reversed', 'appeal.submitted',
            'appeal.upheld', 'enforcement.terminate'].every((a) => actions.has(a)), [...actions]);

    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exit(failed ? 1 : 0);
}

run().catch(async (err) => {
    console.error('  ✗ unexpected error:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
});
