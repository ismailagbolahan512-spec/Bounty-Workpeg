// scripts/phase4-test.js — Phase 4: private talent pool (lists, notes, invitations with consent) and
// global opportunity access (declared country, region limits, honest currency and payout information).
// API checks, access control, validation and concurrency.
//
// Usage: BASE=http://localhost:3100 LOG_FILE=/path/server.log DATABASE_URL=... node scripts/phase4-test.js
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
const WORK = 'I built the checkout flow, wrote unit tests for each payment step, and documented the failure handling.';
const NOTE = 'Reliable on payment work and quick to respond in review.';
const PITCH = 'We have a checkout task that matches your payment work. Would you like to take a look?';

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
    const s = await api('POST', '/api/auth/signin', { email, password: 'password123' });
    return { token: s.body.token, id: s.body.id };
}

(async() => {
    const biz1 = await signupVerified(`p4-biz1+${stamp}@test.com`, 'business', 'Phase Four Biz One');
    const biz2 = await signupVerified(`p4-biz2+${stamp}@test.com`, 'business', 'Phase Four Biz Two');
    const w1 = await signupVerified(`p4-w1+${stamp}@test.com`, 'worker', 'Worker Nigeria');
    const w2 = await signupVerified(`p4-w2+${stamp}@test.com`, 'worker', 'Worker Britain');
    const w3 = await signupVerified(`p4-w3+${stamp}@test.com`, 'worker', 'Worker America');
    const w4 = await signupVerified(`p4-w4+${stamp}@test.com`, 'worker', 'Worker Undeclared');

    await db.query(`UPDATE users SET onboarding_done = true WHERE id = ANY($1::uuid[])`, [[biz1.id, biz2.id, w1.id, w2.id, w3.id, w4.id]]);
    await db.query(`UPDATE users SET discoverable = true, categories = ARRAY['dev'] WHERE id = ANY($1::uuid[])`, [[w1.id, w3.id]]);
    await db.query(`UPDATE users SET discoverable = false WHERE id = $1`, [w2.id]);
    await db.query(`UPDATE users SET discoverable = true WHERE id = $1`, [w4.id]);

    // ---------------------------------------------------------------- regions catalogue and profile country
    const regions = await api('GET', '/api/global/regions');
    check('the region catalogue is public', regions.status === 200 && regions.body.regions.some((r) => r.code === 'NG'));
    check('the platform states naira is the only supported currency', regions.body.supported_currency === 'NGN'
        && regions.body.currencies.filter((c) => c.status === 'supported').map((c) => c.code).join() === 'NGN', regions.body.currencies);
    check('the payout note never claims a payment method exists', /not confirmed/i.test(regions.body.payout_note) && !/supported payment|we pay|pay via/i.test(regions.body.payout_note));
    check('an unknown country is refused on the profile (400)', (await api('PATCH', '/api/profile/me', { country: 'XX' }, w1.token)).status === 400);
    const setC = await api('PATCH', '/api/profile/me', { country: 'ng' }, w1.token);
    check('a declared country is saved in upper case', setC.status === 200 && setC.body.country === 'NG', setC.body);
    await api('PATCH', '/api/profile/me', { country: 'GB' }, w2.token);
    await api('PATCH', '/api/profile/me', { country: 'US' }, w3.token);

    // ---------------------------------------------------------------- tasks and region limits
    const project = await api('POST', '/api/projects', {
        title: 'Phase four project', description: 'A project for the Phase 4 checks.',
        tasks: [
            { title: 'Open checkout task', description: SHOP, category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(10), submission_type: 'github', acceptance_criteria: [] },
            { title: 'Nigeria only task', description: SHOP, category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(10), submission_type: 'github', acceptance_criteria: [] },
            { title: 'Closing task', description: SHOP, category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(10), submission_type: 'github', acceptance_criteria: [] },
        ],
    }, biz1.token);
    check('a project with three tasks is created', project.status === 201, project.body);
    const [openTask, limitedTask, closingTask] = project.body.task_ids;
    const other = await api('POST', '/api/projects', {
        title: 'Other business project', description: 'A project owned by the second business.',
        tasks: [{ title: 'Other business task', description: SHOP, category: 'dev', difficulty: 'easy', reward_amount: 120, deadline: inDays(10), submission_type: 'github', acceptance_criteria: [] }],
    }, biz2.token);
    const otherTask = other.body.task_ids[0];

    check('a business cannot limit another business\'s task (403)', (await api('PATCH', `/api/global/tasks/${openTask}/regions`, { regions: ['NG'] }, biz2.token)).status === 403);
    check('an unknown region is refused (400)', (await api('PATCH', `/api/global/tasks/${limitedTask}/regions`, { regions: ['ZZ'] }, biz1.token)).status === 400);
    const tooMany = ['NG', 'GH', 'KE', 'ZA', 'GB', 'IE', 'US', 'CA', 'DE', 'FR', 'IN'];
    check('more than 10 regions is refused (400)', (await api('PATCH', `/api/global/tasks/${limitedTask}/regions`, { regions: tooMany }, biz1.token)).status === 400);
    const limit = await api('PATCH', `/api/global/tasks/${limitedTask}/regions`, { regions: ['ng', 'NG', 'GH'] }, biz1.token);
    check('the business limits a task to regions, with duplicates removed', limit.status === 200 && JSON.stringify(limit.body.regions) === JSON.stringify(['NG', 'GH']), limit.body);

    // Visibility in the public listing and on the detail page
    const anonList = await api('GET', '/api/bounties?limit=100');
    const anonIds = (anonList.body.bounties || []).map((b) => b.id);
    check('an anonymous visitor does not see a region-limited task in listings', !anonIds.includes(limitedTask));
    check('an unrestricted open task is open to anonymous visitors', (await api('GET', `/api/bounties/${openTask}`)).status === 200);
    const w1List = await api('GET', '/api/bounties?limit=100', null, w1.token);
    const w1Ids = (w1List.body.bounties || []).map((b) => b.id);
    check('a worker in a listed region can open the limited task', (await api('GET', `/api/bounties/${limitedTask}`, null, w1.token)).status === 200);
    const w3List = await api('GET', '/api/bounties?limit=100', null, w3.token);
    const w3Ids = (w3List.body.bounties || []).map((b) => b.id);
    check('a worker outside the listed regions does not see it in listings', !w3Ids.includes(limitedTask));
    const ownerList = await api('GET', '/api/bounties?limit=100', null, biz1.token);
    const ownerDetail = await api('GET', `/api/bounties/${limitedTask}`, null, biz1.token);
    check('the owning business can open its limited task', ownerDetail.status === 200 && ownerList.status === 200, { detail: ownerDetail.status, body: ownerDetail.body, list: ownerList.status });
    check('a limited task is hidden from anonymous detail (404)', (await api('GET', `/api/bounties/${limitedTask}`)).status === 404);
    check('a limited task is hidden from an outside worker (404)', (await api('GET', `/api/bounties/${limitedTask}`, null, w3.token)).status === 404);
    check('a limited task is shown to a worker in a listed region', (await api('GET', `/api/bounties/${limitedTask}`, null, w1.token)).status === 200);
    check('a limited task is shown to its business', (await api('GET', `/api/bounties/${limitedTask}`, null, biz1.token)).status === 200);

    // Opportunities: region information and honest eligibility
    const opp1 = await api('GET', '/api/global/opportunities', null, w1.token);
    check('the Nigerian worker gets opportunities', opp1.status === 200 && opp1.body.results.length > 0, opp1.body);
    const nigerianIds = opp1.body.results.map((r) => r.bounty_id);
    const nigerianRows = (await db.query('SELECT id, regions FROM bounties WHERE id = ANY($1::uuid[])', [nigerianIds])).rows;
    check('every opportunity for the Nigerian worker is open to Nigeria', nigerianRows.length === nigerianIds.length && nigerianRows.every((r) => r.regions.length === 0 || r.regions.includes('NG')));
    check('the eligibility block names the region and says payout is not confirmed', opp1.body.eligibility.region_name === 'Nigeria' && opp1.body.eligibility.payout_status === 'not_confirmed', opp1.body.eligibility);
    const opp3 = await api('GET', '/api/global/opportunities', null, w3.token);
    const usRows = (await db.query('SELECT id, regions FROM bounties WHERE id = ANY($1::uuid[])', [opp3.body.results.map((r) => r.bounty_id)])).rows;
    check('every opportunity for the American worker is open to the United States', usRows.every((r) => r.regions.length === 0 || r.regions.includes('US')));
    check('the American worker gets a region name and no limited tasks from other regions', opp3.body.eligibility.region_name === 'United States' && !opp3.body.results.some((r) => r.bounty_id === limitedTask));
    const opp4 = await api('GET', '/api/global/opportunities', null, w4.token);
    check('a worker with no declared country is asked to set one', opp4.body.eligibility.country === null && /Set your country/.test(opp4.body.eligibility.message));
    check('the worker matching list also applies region limits', !((await api('GET', '/api/matching/tasks', null, w3.token)).body.results.some((r) => r.bounty_id === limitedTask)));
    check('a business cannot use the opportunities feed (403)', (await api('GET', '/api/global/opportunities', null, biz1.token)).status === 403);

    // ---------------------------------------------------------------- talent lists
    check('a list name that is too short is refused (400)', (await api('POST', '/api/talent/lists', { name: 'A' }, biz1.token)).status === 400);
    const list = await api('POST', '/api/talent/lists', { name: 'Checkout specialists' }, biz1.token);
    check('a business creates a private list (201)', list.status === 201 && list.body.id, list.body);
    check('a duplicate list name is refused (409)', (await api('POST', '/api/talent/lists', { name: 'Checkout specialists' }, biz1.token)).status === 409);
    const made = [list.body.id];
    for (let i = 0; i < 9; i++) made.push((await api('POST', '/api/talent/lists', { name: `Extra list ${i}` }, biz1.token)).body.id);
    check('a business can keep up to 10 lists; the eleventh is refused (409)', (await api('POST', '/api/talent/lists', { name: 'One too many' }, biz1.token)).status === 409);
    const listId = list.body.id;

    check('a worker who has not opted in and has not worked with the business cannot be saved (409)', (await api('POST', `/api/talent/lists/${listId}/members`, { worker_id: w2.id }, biz1.token)).status === 409);
    check('an unknown worker cannot be saved (404)', (await api('POST', `/api/talent/lists/${listId}/members`, { worker_id: biz2.id }, biz1.token)).status === 404);
    check('a discoverable worker can be saved (201)', (await api('POST', `/api/talent/lists/${listId}/members`, { worker_id: w1.id }, biz1.token)).status === 201);
    const sub = await api('POST', '/api/submissions', { bounty_id: openTask, title: 'Checkout', description: WORK, github_link: 'https://github.com/example/checkout' }, w2.token);
    check('a worker who is not discoverable submits to the business', sub.status === 201, sub.body);
    check('a worker who has worked with the business can now be saved, even if not discoverable (201)', (await api('POST', `/api/talent/lists/${listId}/members`, { worker_id: w2.id }, biz1.token)).status === 201);

    const view = await api('GET', `/api/talent/lists/${listId}`, null, biz1.token);
    check('the list shows its members', view.status === 200 && view.body.members.length === 2, view.body);
    check('the list does not expose email addresses', !JSON.stringify(view.body).includes('@test.com'));
    check('another business cannot see this list (404)', (await api('GET', `/api/talent/lists/${listId}`, null, biz2.token)).status === 404);
    check('another business cannot change its members (404)', (await api('DELETE', `/api/talent/lists/${listId}/members/${w1.id}`, null, biz2.token)).status === 404);
    check('a worker cannot see business lists (403)', (await api('GET', '/api/talent/lists', null, w1.token)).status === 403);

    // ---------------------------------------------------------------- notes (private)
    check('a note that is too short is refused (400)', (await api('POST', `/api/talent/workers/${w1.id}/notes`, { body: 'ok' }, biz1.token)).status === 400);
    const note = await api('POST', `/api/talent/workers/${w1.id}/notes`, { body: NOTE }, biz1.token);
    check('the business adds a private note (201)', note.status === 201, note.body);
    check('the note is visible to the business that wrote it', ((await api('GET', `/api/talent/workers/${w1.id}/notes`, null, biz1.token)).body || []).length === 1);
    check('another business does not see the note', ((await api('GET', `/api/talent/workers/${w1.id}/notes`, null, biz2.token)).body || []).length === 0);
    check('the worker cannot read the business\'s notes (403)', (await api('GET', `/api/talent/workers/${w1.id}/notes`, null, w1.token)).status === 403);
    check('a business cannot delete another business\'s note (404)', (await api('DELETE', `/api/talent/notes/${note.body.id}`, null, biz2.token)).status === 404);

    // Race for the last note slot: start at 49, two simultaneous adds, exactly one succeeds.
    await db.query(`INSERT INTO talent_notes (business_id, worker_id, body) SELECT $1, $2, 'Bulk note for the limit check.' FROM generate_series(1, 49)`, [biz1.id, w3.id]);
    const notesRace = await Promise.all([
        api('POST', `/api/talent/workers/${w3.id}/notes`, { body: 'First note in the race.' }, biz1.token),
        api('POST', `/api/talent/workers/${w3.id}/notes`, { body: 'Second note in the race.' }, biz1.token),
    ]);
    check('two notes added at the limit: exactly one is kept', notesRace.filter((r) => r.status === 201).length === 1, notesRace.map((r) => r.status));
    check('the note limit per worker is enforced (409)', notesRace.some((r) => r.status === 409));

    // ---------------------------------------------------------------- invitations with consent
    check('a worker who has not opted in cannot be invited (409)', (await api('POST', '/api/talent/invitations', { worker_id: w2.id, message: PITCH }, biz1.token)).status === 409);
    check('an invitation message that is too short is refused (400)', (await api('POST', '/api/talent/invitations', { worker_id: w1.id, message: 'Hi there' }, biz1.token)).status === 400);
    check('a business cannot invite to another business\'s task (404)', (await api('POST', '/api/talent/invitations', { worker_id: w1.id, bounty_id: otherTask, message: PITCH }, biz1.token)).status === 404);
    const inv = await api('POST', '/api/talent/invitations', { worker_id: w1.id, bounty_id: openTask, message: PITCH }, biz1.token);
    check('a business invites a discoverable worker to an open task (201)', inv.status === 201 && inv.body.status === 'pending', inv.body);
    check('a second pending invitation for the same worker and task is refused (409)', (await api('POST', '/api/talent/invitations', { worker_id: w1.id, bounty_id: openTask, message: PITCH }, biz1.token)).status === 409);
    await db.query(`UPDATE bounties SET status = 'closed' WHERE id = $1`, [closingTask]);
    check('an invitation to a closed task is refused (409)', (await api('POST', '/api/talent/invitations', { worker_id: w1.id, bounty_id: closingTask, message: PITCH }, biz1.token)).status === 409);

    const racing = await Promise.all([
        api('POST', '/api/talent/invitations', { worker_id: w3.id, message: PITCH }, biz1.token),
        api('POST', '/api/talent/invitations', { worker_id: w3.id, message: PITCH }, biz1.token),
    ]);
    check('two simultaneous invitations to the same worker: exactly one is pending', racing.filter((r) => r.status === 201).length === 1, racing.map((r) => r.status));
    const w3Invite = racing.find((r) => r.status === 201).body.id;

    const general = await api('POST', '/api/talent/invitations', { worker_id: w4.id, message: PITCH }, biz1.token);
    check('a general invitation (no task) is allowed', general.status === 201 && general.body.bounty_id === null);

    const mine = await api('GET', '/api/talent/invitations/mine', null, w1.token);
    check('the worker sees the invitation with the business name', mine.status === 200 && mine.body.some((i) => i.business_name === 'Phase Four Biz One' && i.status === 'pending'));
    check('a response that is neither accept nor decline is refused (400)', (await api('POST', `/api/talent/invitations/${inv.body.id}/respond`, { decision: 'maybe' }, w1.token)).status === 400);
    check('another worker cannot respond to the invitation (404)', (await api('POST', `/api/talent/invitations/${inv.body.id}/respond`, { decision: 'accept' }, w2.token)).status === 404);

    const accepted = await api('POST', `/api/talent/invitations/${inv.body.id}/respond`, { decision: 'accept' }, w1.token);
    check('the worker accepts; the response says it assigns no work or payment', accepted.status === 200 && accepted.body.status === 'accepted' && /does not assign/.test(accepted.body.next_step), accepted.body);
    const participant = await db.query('SELECT 1 FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2', [openTask, w1.id]);
    check('accepting an invitation does not make the worker a participant', participant.rowCount === 0);
    check('a responded invitation cannot be answered again (409)', (await api('POST', `/api/talent/invitations/${inv.body.id}/respond`, { decision: 'decline' }, w1.token)).status === 409);

    const declined = await api('POST', `/api/talent/invitations/${general.body.id}/respond`, { decision: 'decline' }, w4.token);
    check('the worker declines a general invitation', declined.status === 200 && declined.body.status === 'declined');

    const raceRespond = await Promise.all([
        api('POST', `/api/talent/invitations/${w3Invite}/respond`, { decision: 'accept' }, w3.token),
        api('POST', `/api/talent/invitations/${w3Invite}/withdraw`, null, biz1.token),
    ]);
    check('the worker answering and the business withdrawing at once: exactly one wins', raceRespond.filter((r) => r.status === 200).length === 1, raceRespond.map((r) => r.status));

    const sent = await api('GET', '/api/talent/invitations', null, biz1.token);
    check('the business sees its invitations with their statuses', sent.status === 200 && sent.body.some((i) => i.status === 'accepted') && sent.body.some((i) => i.status === 'declined'));
    check('another business cannot withdraw this invitation (404)', (await api('POST', `/api/talent/invitations/${inv.body.id}/withdraw`, null, biz2.token)).status === 404);

    // Expiry
    const expiring = await api('POST', '/api/talent/invitations', { worker_id: w1.id, message: PITCH }, biz1.token);
    await db.query(`UPDATE talent_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [expiring.body.id]);
    const expired = (await api('GET', '/api/talent/invitations/mine', null, w1.token)).body.find((i) => i.id === expiring.body.id);
    check('an invitation past its expiry shows as expired', expired && expired.status === 'expired', expired);
    check('an expired invitation cannot be accepted (409)', (await api('POST', `/api/talent/invitations/${expiring.body.id}/respond`, { decision: 'accept' }, w1.token)).status === 409);

    // Open tasks for invitations and the save list
    check('the business gets its open tasks for invitations', (await api('GET', '/api/talent/open-tasks', null, biz1.token)).body.some((t) => t.id === openTask));
    check('the list can be renamed', (await api('PATCH', `/api/talent/lists/${listId}`, { name: 'Checkout experts' }, biz1.token)).status === 200);
    check('a removed worker leaves the list', (await api('DELETE', `/api/talent/lists/${listId}/members/${w2.id}`, null, biz1.token)).status === 200);
    check('a list can be deleted by its business', (await api('DELETE', `/api/talent/lists/${made[1]}`, null, biz1.token)).status === 200);
    check('a deleted list is gone (404)', (await api('GET', `/api/talent/lists/${made[1]}`, null, biz1.token)).status === 404);

    console.log(`\nPhase 4 API checks passed: ${passed}`);
    await db.end();
    process.exit(0);
})().catch(async(err) => {
    console.error('Phase 4 test crashed:', err);
    await db.end().catch(() => {});
    process.exit(1);
});
