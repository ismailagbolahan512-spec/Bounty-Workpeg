// routes/submissions.js - worker submissions and business approval
//
// POST /api/submissions                    (worker only)
//   Body: { "bounty_id": "<uuid>", "title": "My fix", "description": "...",
//           "github_link": "https://github.com/...", "notes_to_reviewer": "..." }
//
// POST /api/submissions/<uuid>/approve     (business owner of the bounty only)
//   Authorization: Bearer <token>
//   The submission id comes from the URL only.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { assertActiveAccount, requireAgreement, canAccessConfidential } = require('../services/protection');
const dbq = (sql, params) => pool.query(sql, params);
const { evaluateCriteria } = require('../services/criteria');
const { isExclusive, targetFor, logEvent, notifyAfterCommit } = require('../services/execution');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shared rules for a worker's submission (create and resubmit).
// Limits: title 3-200, description 30-2000, link up to 255 (the column size), notes up to 1000.
// A link is required unless the bounty takes text answers only.
function checkSubmission(fields, submissionType) {
    const { title, description, github_link, notes_to_reviewer } = fields;
    if (typeof title !== 'string' || title.trim().length < 3 || title.length > 200) {
        throw httpError(400, 'Title must be 3-200 characters');
    }
    if (typeof description !== 'string' || description.trim().length < 30) {
        throw httpError(400, 'Describe how your work meets the requirements (at least 30 characters)');
    }
    if (description.trim().length > 2000) {
        throw httpError(400, 'Description can be at most 2000 characters');
    }
    const link = typeof github_link === 'string' ? github_link.trim() : '';
    if (submissionType !== 'text' && !link) {
        throw httpError(400, 'Add a link to your work (a project, repository or hosted file)');
    }
    if (link) {
        if (link.length > 255) throw httpError(400, 'The link can be at most 255 characters');
        try {
            const u = new URL(link);
            if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        } catch {
            throw httpError(400, 'The link must be a valid http or https URL');
        }
    }
    if (notes_to_reviewer !== undefined && notes_to_reviewer !== null) {
        if (typeof notes_to_reviewer !== 'string') throw httpError(400, 'Notes must be text');
        if (notes_to_reviewer.length > 1000) throw httpError(400, 'Notes can be at most 1000 characters');
    }
}

// Bounty states in which a submission may still be approved.
// 'expired' stays approvable: the business still decides on work it received before the deadline.
const APPROVABLE_BOUNTY_STATUSES = ['open', 'in_progress', 'under_review', 'expired'];

// ------------------------------------------- POST /api/submissions
router.post('/', authenticate, requireRole('worker'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const { bounty_id, title, description, github_link, notes_to_reviewer } = req.body || {};

        const bountyId = typeof bounty_id === 'string' ? bounty_id.trim() : '';
        if (!UUID_RE.test(bountyId)) {
            throw httpError(400, 'bounty_id must be a valid UUID');
        }
        await assertActiveAccount(req.user.id);
        await requireAgreement(dbq, req.user.id, 'worker_submission_ip');
        await client.query('BEGIN');

        // Lock the bounty row so an approval running concurrently can't
        // let a submission slip in after completion.
        const { rows } = await client.query(
            `SELECT id, business_id, status, deadline, submission_type,
                    execution_mode, max_workers, requires_authorization, confidential
             FROM bounties
             WHERE id = $1
             FOR UPDATE`, [bountyId]
        );
        if (rows.length === 0) throw httpError(404, 'Bounty not found');

        const bounty = rows[0];
        if (bounty.confidential) {
            await requireAgreement(client.query.bind(client), req.user.id, 'task_nda', bountyId);
            if (!(await canAccessConfidential(client.query.bind(client), req.user.id, bountyId))) {
                throw httpError(403, 'You need an active place on this confidential task to submit');
            }
        }
        checkSubmission({ title, description, github_link, notes_to_reviewer }, bounty.submission_type);

        if (bounty.status !== 'open') {
            throw httpError(409, `Bounty is not accepting submissions (status: ${bounty.status})`);
        }
        if (new Date(bounty.deadline).getTime() <= Date.now()) {
            throw httpError(409, 'Bounty deadline has passed');
        }
        // Self-dealing guard (defense in depth; roles already separate this).
        if (bounty.business_id === req.user.id) {
            throw httpError(403, 'You cannot submit to your own bounty');
        }
        // Tasks in a project wait for the tasks they depend on to be completed.
        const waiting = await client.query(
            `SELECT d.title
             FROM task_dependencies td
             JOIN bounties d ON d.id = td.depends_on_id
             WHERE td.bounty_id = $1 AND d.status <> 'completed'
             ORDER BY d.created_at ASC`, [bountyId]
        );
        if (waiting.rows.length > 0) {
            const names = waiting.rows.map((r) => r.title).join(', ');
            throw httpError(409, `This task waits for other tasks to be completed first: ${names}`);
        }
        // Who may submit. Team tasks are assigned by the business. Security tasks need the NDA
        // and rules of engagement accepted first. Everything else takes a slot, up to max_workers.
        // The bounty row is locked above, so two concurrent submissions can't take the last slot.
        const found = await client.query(
            `SELECT status, nda_accepted_at, roe_accepted_at
             FROM bounty_participants
             WHERE bounty_id = $1 AND worker_id = $2
             FOR UPDATE`, [bountyId, req.user.id]
        );
        const part = found.rows[0] || null;
        if (part && (part.status === 'closed' || part.status === 'withdrawn')) {
            throw httpError(409, 'You are no longer part of this task');
        }
        if (bounty.execution_mode === 'team' && !(part && (part.status === 'assigned' || part.status === 'active'))) {
            throw httpError(403, 'Only workers assigned to this task can submit to it');
        }
        if (bounty.requires_authorization && !(part && part.nda_accepted_at && part.roe_accepted_at)) {
            throw httpError(403, 'Accept the NDA and the rules of engagement before submitting to this task');
        }
        if (!part) {
            const taken = await client.query(
                `SELECT COUNT(*)::int AS n FROM bounty_participants
                 WHERE bounty_id = $1 AND status IN ('active', 'assigned')`, [bountyId]
            );
            if (taken.rows[0].n >= bounty.max_workers) {
                throw httpError(409, 'This task already has its maximum number of workers');
            }
        }

        let submission;
        try {
            const result = await client.query(
                `INSERT INTO submissions
                   (bounty_id, worker_id, title, description, github_link, notes_to_reviewer, status, submitted_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
                 RETURNING *`, [bountyId, req.user.id, title.trim(), description.trim(),
                    github_link || null, notes_to_reviewer || null
                ]
            );
            submission = result.rows[0];
        } catch (err) {
            if (err.code === '23505') { // one_submission_per_worker_per_bounty
                throw httpError(409, 'You have already submitted to this bounty');
            }
            throw err;
        }
        await client.query(
            `INSERT INTO bounty_participants (bounty_id, worker_id, status)
             VALUES ($1, $2, 'active')
             ON CONFLICT (bounty_id, worker_id) DO UPDATE
               SET status = 'active', updated_at = NOW()
               WHERE bounty_participants.status = 'assigned'`, [bountyId, req.user.id]
        );
        await logEvent(client, bountyId, req.user.id, 'submission_received', { submission_id: submission.id });
        await client.query('COMMIT');
        createNotification(bounty.business_id, 'New submission received on one of your bounties.', '#/bounties/' + bountyId).catch(() => {});
        res.status(201).json(submission);

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------ POST /api/submissions/:id/approve
// Guarantees, per execution mode (see services/execution.js):
//   1. Only the bounty owner can approve, and only pending work.
//   2. The bounty row is locked, so approvals on one task run one at a time.
//   3. First valid and independent results must pass every automatic criterion first.
//   4. Winners are recorded in bounty_winners. Single-winner modes are guarded by a unique
//      index, so two approvals can never produce two winners.
//   5. When the target is reached, the task completes and the other participants are closed
//      and told, in the same transaction.
//   6. Payment records and earnings are written in the same transaction, as before.
const MODE_CLOSE_MESSAGE = {
    first_valid: (t) => `"${t}" was completed by another worker's verified submission. Your submission was closed.`,
    competitive: (t) => `The business selected its winners for "${t}". Your submission was not selected.`,
    independent: (t) => `The assessments for "${t}" are complete. Your submission was closed.`,
    team: (t) => `"${t}" is complete. Thank you for your part.`,
};

router.post('/:id/approve', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) {
            throw httpError(400, 'Invalid submission id');
        }

        await client.query('BEGIN');

        // Lock order is always bounty first, then submission (the same order submitting and
        // accepting use). Locking the submission first can deadlock with a concurrent approval,
        // because closing the other submissions needs their rows too.
        const pointer = await client.query(`SELECT bounty_id FROM submissions WHERE id = $1`, [submissionId]);
        if (pointer.rows.length === 0) throw httpError(404, 'Submission not found');
        await client.query(`SELECT id FROM bounties WHERE id = $1 FOR UPDATE`, [pointer.rows[0].bounty_id]);

        const { rows } = await client.query(
            `SELECT s.id, s.status AS submission_status, s.worker_id, s.description, s.github_link,
                    b.id AS bounty_id, b.business_id, b.title, b.status AS bounty_status,
                    b.reward_amount, b.execution_mode, b.winner_limit, b.independent_target,
                    b.acceptance_criteria
             FROM submissions s
             JOIN bounties b ON b.id = s.bounty_id
             WHERE s.id = $1
             FOR UPDATE OF s`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');

        const row = rows[0];

        // Ownership: the authenticated business must own the bounty.
        if (row.business_id !== req.user.id) {
            throw httpError(403, 'You do not own the bounty this submission belongs to');
        }
        if (!APPROVABLE_BOUNTY_STATUSES.includes(row.bounty_status)) {
            throw httpError(409, `Bounty cannot be resolved in status: ${row.bounty_status}`);
        }
        if (row.submission_status !== 'pending') {
            throw httpError(409, `Submission is already ${row.submission_status}`);
        }

        // Verification: first valid and independent results must pass every automatic criterion.
        if (row.execution_mode === 'first_valid' || row.execution_mode === 'independent') {
            const criteria = Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [];
            const failing = evaluateCriteria(criteria, { description: row.description, github_link: row.github_link })
                .results.filter((r) => r.result === 'fail');
            if (failing.length > 0) {
                throw httpError(409, 'This submission does not meet the requirements yet: ' + failing.map((r) => r.text).join('; '));
            }
        }

        const target = targetFor(row);
        const exclusive = isExclusive(row.execution_mode, row.winner_limit);
        const before = await client.query(
            `SELECT COUNT(*)::int AS n FROM bounty_winners WHERE bounty_id = $1`, [row.bounty_id]
        );
        if (before.rows[0].n >= target) {
            throw httpError(409, row.execution_mode === 'first_valid' ?
                'This task already has a confirmed winner' :
                'This task has already selected all of its winners');
        }

        // Conditional UPDATE: a concurrent approval cannot flip this row twice.
        const approved = await client.query(
            `UPDATE submissions
             SET status = 'approved', updated_at = NOW()
             WHERE id = $1 AND status = 'pending'
             RETURNING *`, [submissionId]
        );
        if (approved.rows.length === 0) {
            throw httpError(409, 'Submission was already resolved by a concurrent request');
        }

        try {
            await client.query(
                `INSERT INTO bounty_winners (bounty_id, submission_id, worker_id, exclusive)
                 VALUES ($1, $2, $3, $4)`, [row.bounty_id, submissionId, row.worker_id, exclusive]
            );
        } catch (err) {
            if (err.code === '23505') {
                throw httpError(409, 'A winner was already confirmed for this task');
            }
            throw err;
        }

        const winnerCount = before.rows[0].n + 1;
        const complete = winnerCount >= target;
        const notices = [];

        if (complete) {
            const reason = row.execution_mode === 'independent' ? 'target_reached' : 'winner_confirmed';
            await client.query(
                `UPDATE bounties
                 SET status = 'completed', winner_id = COALESCE(winner_id, $1), completed_at = NOW(),
                     closed_at = NOW(), closure_reason = $2, updated_at = NOW()
                 WHERE id = $3`, [row.worker_id, reason, row.bounty_id]
            );
            const others = await client.query(
                `UPDATE submissions SET status = 'closed', updated_at = NOW()
                 WHERE bounty_id = $1 AND status IN ('pending', 'revision_requested') AND id <> $2
                 RETURNING worker_id`, [row.bounty_id, submissionId]
            );
            await client.query(
                `UPDATE bounty_participants SET status = 'closed', updated_at = NOW()
                 WHERE bounty_id = $1 AND status IN ('active', 'assigned')`, [row.bounty_id]
            );
            const message = MODE_CLOSE_MESSAGE[row.execution_mode](row.title);
            for (const o of others.rows) notices.push([o.worker_id, message, '#/dashboard']);
            await logEvent(client, row.bounty_id, req.user.id, 'bounty_closed', { reason, winners: winnerCount });
        }
        await logEvent(client, row.bounty_id, req.user.id, 'submission_approved', {
            submission_id: submissionId, worker_id: row.worker_id, winners: winnerCount,
        });

        // DEMO ONLY: records a simulated payout, not a real blockchain transfer.
        const payment = await client.query(
            `INSERT INTO payments
               (submission_id, bounty_id, worker_id, business_id, amount, monad_tx_hash, status)
             VALUES ($1, $2, $3, $4, $5, NULL, 'simulated')
             RETURNING id, status, monad_tx_hash, amount`, [submissionId, row.bounty_id, row.worker_id, req.user.id, row.reward_amount]
        );

        // Keep users.total_earned consistent inside the same transaction.
        await client.query(
            `UPDATE users
             SET total_earned = COALESCE(total_earned, 0) + $1, updated_at = NOW()
             WHERE id = $2`, [row.reward_amount, row.worker_id]
        );

        await client.query('COMMIT');
        createNotification(row.worker_id, 'Your submission was approved. Payment is simulated.', '#/dashboard').catch(() => {});
        notifyAfterCommit(notices);

        res.json({
            ...approved.rows[0],
            payment: payment.rows[0],
            winners_confirmed: winnerCount,
            target,
            bounty_status: complete ? 'completed' : row.bounty_status,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------- GET /api/submissions/bounty/:bountyId (bounty owner only)
router.get('/bounty/:bountyId', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const bountyId = req.params.bountyId;
        if (!UUID_RE.test(bountyId)) throw httpError(400, 'Invalid bounty id');

        const owned = await pool.query(
            'SELECT id FROM bounties WHERE id = $1 AND business_id = $2', [bountyId, req.user.id]
        );
        if (owned.rows.length === 0) throw httpError(404, 'Bounty not found');

        const { rows } = await pool.query(
            `SELECT s.id, s.title, s.description, s.github_link, s.notes_to_reviewer,
                    s.status, s.submitted_at, u.name AS worker_name
             FROM submissions s
             JOIN users u ON u.id = s.worker_id
             WHERE s.bounty_id = $1
             ORDER BY s.submitted_at ASC`, [bountyId]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------- POST /api/submissions/:id/reject (bounty owner only)
// ------------------------- POST /api/submissions/:id/reject (bounty owner only)
router.post('/:id/reject', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');
        const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '';
        if (reason.length < 10 || reason.length > 500) {
            throw httpError(400, 'Give the worker a clear reason (10-500 characters)');
        }

        const { rows } = await pool.query(
            `SELECT s.id, s.status, s.worker_id, b.id AS bounty_id, b.business_id
             FROM submissions s
             JOIN bounties b ON b.id = s.bounty_id
             WHERE s.id = $1`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        if (rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own the bounty this submission belongs to');
        if (!['pending', 'revision_requested'].includes(rows[0].status)) {
            throw httpError(409, `Submission is already ${rows[0].status}`);
        }

        const updated = await pool.query(
            `UPDATE submissions SET status = 'rejected', rejection_reason = $2, updated_at = NOW()
             WHERE id = $1 AND status IN ('pending', 'revision_requested')
             RETURNING *`, [submissionId, reason]
        );
        if (updated.rows.length === 0) throw httpError(409, 'Submission was already resolved');

        createNotification(rows[0].worker_id, 'Your submission was rejected: ' + reason.slice(0, 160), '#/dashboard').catch(() => {});
        res.json(updated.rows[0]);
    } catch (err) {
        next(err);
    }
});
// ------------------------- GET /api/submissions/mine (worker: own submissions, with revision notes)
router.get('/mine', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT s.id, s.bounty_id, s.title, s.description, s.github_link, s.status,
                    s.revision_notes, s.revision_requested_at, s.proposed_deadline, s.rejection_reason, s.submitted_at, b.title AS bounty_title
             FROM submissions s
             JOIN bounties b ON b.id = s.bounty_id
             WHERE s.worker_id = $1
             ORDER BY s.submitted_at DESC`, [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------- GET /api/submissions/:id/checks (bounty owner only)
// Deterministic criteria results. Nothing is rejected by this endpoint.
router.get('/:id/checks', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');

        const { rows } = await pool.query(
            `SELECT s.id, s.description, s.github_link, b.business_id, b.acceptance_criteria
             FROM submissions s JOIN bounties b ON b.id = s.bounty_id
             WHERE s.id = $1`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        if (rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own the bounty this submission belongs to');

        const evaluation = evaluateCriteria(rows[0].acceptance_criteria || [], rows[0]);
        res.json({ submission_id: submissionId, ...evaluation });
    } catch (err) {
        next(err);
    }
});

// ------------------------- POST /api/submissions/:id/request-revision (bounty owner only)
// Moves a pending submission to revision_requested. The worker resubmits the same row.
router.post('/:id/request-revision', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');

        const notes = typeof (req.body || {}).notes === 'string' ? req.body.notes.trim() : '';
        if (notes.length < 5 || notes.length > 1000) {
            throw httpError(400, 'Explain what needs to change (5-1000 characters)');
        }
        // Optional: a proposed new deadline. The worker must accept it before the task deadline changes.
        let proposedDeadline = null;
        const rawProposal = (req.body || {}).proposed_deadline;
        if (rawProposal !== undefined && rawProposal !== null && rawProposal !== '') {
            const when = new Date(rawProposal);
            if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
                throw httpError(400, 'Proposed deadline must be a valid future date');
            }
            proposedDeadline = when.toISOString();
        }

        const { rows } = await pool.query(
            `SELECT s.id, s.status, s.worker_id, b.id AS bounty_id, b.business_id, b.status AS bounty_status
             FROM submissions s JOIN bounties b ON b.id = s.bounty_id
             WHERE s.id = $1`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        if (rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own the bounty this submission belongs to');
        if (!APPROVABLE_BOUNTY_STATUSES.includes(rows[0].bounty_status)) {
            throw httpError(409, `Bounty cannot take revisions in status: ${rows[0].bounty_status}`);
        }
        if (rows[0].status !== 'pending') throw httpError(409, `Only pending submissions can be sent back (status: ${rows[0].status})`);

        const updated = await pool.query(
            `UPDATE submissions
             SET status = 'revision_requested', revision_notes = $2, revision_requested_at = NOW(),
                 proposed_deadline = $3, updated_at = NOW()
             WHERE id = $1 AND status = 'pending'
             RETURNING *`, [submissionId, notes, proposedDeadline]
        );
        if (updated.rows.length === 0) throw httpError(409, 'Submission was already resolved');

        createNotification(rows[0].worker_id, 'The business asked for changes to your submission.', '#/dashboard').catch(() => {});
        res.json(updated.rows[0]);
    } catch (err) {
        next(err);
    }
});

// ------------------------- POST /api/submissions/:id/resubmit (worker who owns the submission)
router.post('/:id/resubmit', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');

        const { title, description, github_link, notes_to_reviewer } = req.body || {};
        const { rows } = await pool.query(
            `SELECT s.id, s.worker_id, s.status, b.id AS bounty_id, b.business_id, b.status AS bounty_status, b.deadline, b.submission_type
             FROM submissions s JOIN bounties b ON b.id = s.bounty_id
             WHERE s.id = $1`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        if (rows[0].worker_id !== req.user.id) throw httpError(403, 'This is not your submission');
        checkSubmission({ title, description, github_link, notes_to_reviewer }, rows[0].submission_type);
        if (rows[0].status !== 'revision_requested') {
            throw httpError(409, `Only submissions with requested changes can be resubmitted (status: ${rows[0].status})`);
        }
        if (rows[0].bounty_status !== 'open' || new Date(rows[0].deadline).getTime() <= Date.now()) {
            throw httpError(409, 'The bounty is no longer accepting work');
        }

        const updated = await pool.query(
            `UPDATE submissions
             SET status = 'pending', title = $2, description = $3, github_link = $4,
                 notes_to_reviewer = $5, submitted_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND status = 'revision_requested'
             RETURNING *`, [submissionId, title.trim(), description.trim(), github_link || null, notes_to_reviewer || null]
        );
        if (updated.rows.length === 0) throw httpError(409, 'Submission was already changed');

        createNotification(rows[0].business_id, 'A worker resubmitted after your requested changes.', '#/bounties/' + rows[0].bounty_id).catch(() => {});
        res.json(updated.rows[0]);
    } catch (err) {
        next(err);
    }
});

// ------------------------- POST /api/submissions/:id/accept-deadline (worker who owns the submission)
// The task deadline changes only when the worker accepts the proposal.
router.post('/:id/accept-deadline', authenticate, requireRole('worker'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT s.id, s.worker_id, s.status, s.proposed_deadline, b.id AS bounty_id, b.business_id, b.status AS bounty_status
             FROM submissions s JOIN bounties b ON b.id = s.bounty_id
             WHERE s.id = $1 FOR UPDATE OF s, b`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        const row = rows[0];
        if (row.worker_id !== req.user.id) throw httpError(403, 'This is not your submission');
        if (row.status !== 'revision_requested' || !row.proposed_deadline) {
            throw httpError(409, 'There is no proposed deadline to accept');
        }
        if (!APPROVABLE_BOUNTY_STATUSES.includes(row.bounty_status)) {
            throw httpError(409, `Bounty deadline cannot change in status: ${row.bounty_status}`);
        }

        const updated = await client.query(
            `UPDATE submissions SET proposed_deadline = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [submissionId]
        );
        await client.query(
            `UPDATE bounties SET deadline = $1, updated_at = NOW() WHERE id = $2`, [row.proposed_deadline, row.bounty_id]
        );
        await client.query('COMMIT');

        createNotification(row.business_id, 'The worker accepted the new deadline.', '#/bounties/' + row.bounty_id).catch(() => {});
        res.json(updated.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------- POST /api/submissions/:id/decline-deadline (worker who owns the submission)
router.post('/:id/decline-deadline', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');

        const { rows } = await pool.query(
            `SELECT s.id, s.worker_id, s.status, s.proposed_deadline, b.business_id, b.id AS bounty_id
             FROM submissions s JOIN bounties b ON b.id = s.bounty_id WHERE s.id = $1`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        if (rows[0].worker_id !== req.user.id) throw httpError(403, 'This is not your submission');
        if (rows[0].status !== 'revision_requested' || !rows[0].proposed_deadline) {
            throw httpError(409, 'There is no proposed deadline to decline');
        }

        const updated = await pool.query(
            `UPDATE submissions SET proposed_deadline = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [submissionId]
        );
        createNotification(rows[0].business_id, 'The worker declined the proposed deadline.', '#/bounties/' + rows[0].bounty_id).catch(() => {});
        res.json(updated.rows[0]);
    } catch (err) {
        next(err);
    }
});

module.exports = router;