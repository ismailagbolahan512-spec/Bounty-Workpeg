// routes/disputes.js — the dispute resolution centre.
//
// Parties: the business and the worker on a task or milestone.
//   GET   /api/disputes/mine                  disputes I raised or answer
//   POST  /api/disputes                       raise a dispute on a task or milestone
//   GET   /api/disputes/:id                   one dispute with its context (parties only)
//   POST  /api/disputes/:id/messages          respond or add to the record
//   POST  /api/disputes/:id/evidence          add text or an https link
//   POST  /api/disputes/:id/escalate          ask for a second decision (once, after a decision)
// Administrators:
//   GET   /api/disputes/admin/queue           all disputes, optionally filtered by status
//   POST  /api/disputes/:id/request-evidence  ask the parties for more evidence
//   POST  /api/disputes/:id/decide            record a decision and the payment decision
//
// Every change is written to dispute_events. Payment eligibility is flagged for review while a
// dispute is open; a decision releases it or keeps it on hold.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, requireAdmin, httpError } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { CATEGORIES, STATUSES, OUTCOMES, ACTIVE, statusAfterMessage } = require('../services/disputes');
const { notifyAfterCommit } = require('../services/execution');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_KEYS = CATEGORIES.map(([key]) => key);

function checkId(id, label) {
    if (!UUID_RE.test(id)) throw httpError(400, `Invalid ${label} id`);
}

function text(value, label, min, max) {
    const t = typeof value === 'string' ? value.trim() : '';
    if (t.length < min || t.length > max) throw httpError(400, `${label} must be ${min}-${max} characters`);
    return t;
}

async function recordEvent(db, disputeId, actorId, event, detail = {}) {
    await db.query(
        'INSERT INTO dispute_events (dispute_id, actor_id, event, detail) VALUES ($1, $2, $3, $4)',
        [disputeId, actorId, event, JSON.stringify(detail)]
    );
}

// Sets payment eligibility on the dispute's milestone or submission. Holds apply while any
// active dispute targets the same item, so one resolved dispute cannot release another's hold.
async function applyPaymentHold(db, dispute) {
    const sources = [];
    if (dispute.milestone_id) sources.push(['milestone', dispute.milestone_id]);
    if (dispute.submission_id) sources.push(['submission', dispute.submission_id]);
    for (const [type, id] of sources) {
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS n FROM disputes
             WHERE status <> 'resolved' AND id <> $1
               AND ((milestone_id = $2 AND $3 = 'milestone') OR (submission_id = $2 AND $3 = 'submission'))`,
            [dispute.id, id, type]
        );
        const stillDisputed = rows[0].n > 0;
        if (!stillDisputed && dispute.payment_decision !== 'withhold' && dispute.status === 'resolved') {
            await db.query(
                `UPDATE payment_eligibilities SET status = 'eligible'
                 WHERE source_type = $1 AND source_id = $2 AND status = 'under_review'`, [type, id]
            );
        } else {
            await db.query(
                `UPDATE payment_eligibilities SET status = 'under_review'
                 WHERE source_type = $1 AND source_id = $2 AND status = 'eligible'`, [type, id]
            );
        }
    }
}

// Loads a dispute and the party role of the caller. Locks the row when asked.
async function loadDispute(db, id, user, lock) {
    const { rows } = await db.query(
        `SELECT d.*, b.business_id AS bounty_business, p.business_id AS milestone_business
         FROM disputes d
         LEFT JOIN bounties b ON b.id = d.bounty_id
         LEFT JOIN milestones m ON m.id = d.milestone_id
         LEFT JOIN projects p ON p.id = m.project_id
         WHERE d.id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`, [id]
    );
    if (rows.length === 0) throw httpError(404, 'Dispute not found');
    const d = rows[0];
    const isParty = d.raised_by === user.id || d.respondent_id === user.id;
    if (!isParty && user.is_admin !== true) throw httpError(403, 'You are not a party to this dispute');
    return { dispute: d, isParty, isAdmin: user.is_admin === true };
}

// ------------------------------------------------ GET /api/disputes/categories (public list for the form)
router.get('/categories', (req, res) => {
    res.json(CATEGORIES.map(([key, label]) => ({ key, label })));
});

// ------------------------------------------------ GET /api/disputes/mine
router.get('/mine', authenticate, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT d.id, d.title, d.category, d.status, d.created_at, d.updated_at,
                    d.raised_by, d.respondent_id, d.bounty_id, d.milestone_id,
                    COALESCE(b.title, m.title) AS target_title
             FROM disputes d
             LEFT JOIN bounties b ON b.id = d.bounty_id
             LEFT JOIN milestones m ON m.id = d.milestone_id
             WHERE d.raised_by = $1 OR d.respondent_id = $1
             ORDER BY d.updated_at DESC LIMIT 100`, [req.user.id]
        );
        res.json(rows.map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            category_label: (CATEGORIES.find(([k]) => k === r.category) || [])[1] || r.category,
            status: r.status,
            status_label: STATUSES[r.status] || r.status,
            role: r.raised_by === req.user.id ? 'raised' : 'respondent',
            target_title: r.target_title,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })));
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ GET /api/disputes/admin/queue
router.get('/admin/queue', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const status = req.query.status;
        if (status !== undefined && !STATUSES[status]) throw httpError(400, 'Unknown status');
        const { rows } = await pool.query(
            `SELECT d.id, d.title, d.category, d.status, d.escalation_count, d.created_at, d.updated_at,
                    COALESCE(b.title, m.title) AS target_title,
                    ur.name AS raised_by_name, ures.name AS respondent_name
             FROM disputes d
             LEFT JOIN bounties b ON b.id = d.bounty_id
             LEFT JOIN milestones m ON m.id = d.milestone_id
             JOIN users ur ON ur.id = d.raised_by
             JOIN users ures ON ures.id = d.respondent_id
             WHERE ($1::text IS NULL OR d.status = $1)
             ORDER BY (d.status = 'escalated') DESC, d.updated_at ASC LIMIT 200`, [status || null]
        );
        res.json(rows.map((r) => ({ ...r, status_label: STATUSES[r.status] })));
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/disputes
router.post('/', authenticate, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        const b = req.body || {};
        const category = typeof b.category === 'string' ? b.category : '';
        if (!CATEGORY_KEYS.includes(category)) throw httpError(400, 'Choose a dispute category from the list');
        const title = text(b.title, 'Title', 3, 160);
        const description = text(b.description, 'Description', 20, 3000);
        const hasBounty = Boolean(b.bounty_id);
        const hasMilestone = Boolean(b.milestone_id);
        if (hasBounty === hasMilestone) throw httpError(400, 'Name the task or the milestone this dispute is about');
        if (hasBounty) checkId(b.bounty_id, 'bounty');
        if (hasMilestone) checkId(b.milestone_id, 'milestone');
        if (b.submission_id) checkId(b.submission_id, 'submission');

        await client.query('BEGIN');
        let raisedBy = req.user.id;
        let respondentId;
        let submissionId = b.submission_id || null;
        let target;

        if (hasBounty) {
            const { rows } = await client.query('SELECT id, title, business_id FROM bounties WHERE id = $1', [b.bounty_id]);
            if (rows.length === 0) throw httpError(404, 'Task not found');
            target = { bounty_id: rows[0].id, title: rows[0].title };
            if (req.user.id === rows[0].business_id) {
                if (req.user.role !== 'business') throw httpError(403, 'Only the business can raise this dispute');
                if (!submissionId) throw httpError(400, 'Choose the submission this dispute is about');
                const sub = await client.query('SELECT worker_id FROM submissions WHERE id = $1 AND bounty_id = $2', [submissionId, rows[0].id]);
                if (sub.rows.length === 0) throw httpError(400, 'That submission does not belong to this task');
                respondentId = sub.rows[0].worker_id;
            } else {
                const taken = await client.query(
                    `SELECT 1 FROM submissions WHERE bounty_id = $1 AND worker_id = $2
                     UNION SELECT 1 FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2`, [rows[0].id, req.user.id]
                );
                if (taken.rows.length === 0) throw httpError(403, 'Only the business or a worker on this task can raise a dispute');
                if (submissionId) {
                    const own = await client.query('SELECT 1 FROM submissions WHERE id = $1 AND worker_id = $2', [submissionId, req.user.id]);
                    if (own.rows.length === 0) throw httpError(403, 'You can only raise a dispute about your own submission');
                }
                respondentId = rows[0].business_id;
            }
        } else {
            const { rows } = await client.query(
                `SELECT m.id, m.title, m.worker_id, p.business_id FROM milestones m
                 JOIN projects p ON p.id = m.project_id WHERE m.id = $1`, [b.milestone_id]
            );
            if (rows.length === 0) throw httpError(404, 'Milestone not found');
            const m = rows[0];
            target = { milestone_id: m.id, title: m.title };
            if (req.user.id === m.business_id) {
                if (!m.worker_id) throw httpError(409, 'This milestone has no worker to dispute with');
                respondentId = m.worker_id;
            } else if (req.user.id === m.worker_id) {
                respondentId = m.business_id;
            } else {
                throw httpError(403, 'Only the business or the assigned worker can raise this dispute');
            }
        }
        if (respondentId === raisedBy) throw httpError(400, 'You cannot raise a dispute against yourself');

        let inserted;
        try {
            inserted = await client.query(
                `INSERT INTO disputes (bounty_id, milestone_id, submission_id, raised_by, respondent_id, category, title, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [target.bounty_id || null, target.milestone_id || null, submissionId, raisedBy, respondentId, category, title, description]
            );
        } catch (err) {
            if (err.code === '23505') throw httpError(409, 'You already have an open dispute on this. Add to it instead.');
            throw err;
        }
        const dispute = inserted.rows[0];
        await applyPaymentHold(client, dispute);
        await recordEvent(client, dispute.id, req.user.id, 'opened', { category });
        await client.query('COMMIT');

        notices.push([respondentId, `A dispute was raised on "${target.title}". Please respond.`, `#/disputes/${dispute.id}`]);
        notifyAfterCommit(notices);
        res.status(201).json({ id: dispute.id, status: dispute.status });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ GET /api/disputes/:id
router.get('/:id', authenticate, async(req, res, next) => {
    try {
        checkId(req.params.id, 'dispute');
        const { dispute: d, isParty, isAdmin } = await loadDispute(pool, req.params.id, req.user, false);
        const seesBusinessView = isAdmin || d.raised_by === req.user.id && req.user.role === 'business' || d.respondent_id === req.user.id && req.user.role === 'business';

        const people = await pool.query(
            'SELECT id, name, role FROM users WHERE id = ANY($1::uuid[])', [[d.raised_by, d.respondent_id]]
        );
        const byId = Object.fromEntries(people.rows.map((p) => [p.id, { id: p.id, name: p.name, role: p.role }]));

        let target;
        if (d.bounty_id) {
            const { rows } = await pool.query('SELECT title, description, acceptance_criteria, deadline, status FROM bounties WHERE id = $1', [d.bounty_id]);
            target = { type: 'task', id: d.bounty_id, title: rows[0].title, instructions: rows[0].description, criteria: rows[0].acceptance_criteria || [], deadline: rows[0].deadline, status: rows[0].status };
        } else {
            const { rows } = await pool.query('SELECT title, description, deliverables, acceptance_criteria, deadline, status FROM milestones WHERE id = $1', [d.milestone_id]);
            target = { type: 'milestone', id: d.milestone_id, title: rows[0].title, instructions: rows[0].deliverables, criteria: [rows[0].acceptance_criteria], deadline: rows[0].deadline, status: rows[0].status };
        }

        // Only the disputing workers' submissions are shown, so other workers' work stays private.
        const workerIds = [d.raised_by, d.respondent_id].filter((id) => byId[id] && byId[id].role === 'worker');
        let submissions = [];
        if (d.bounty_id && workerIds.length) {
            const { rows } = await pool.query(
                `SELECT s.id, s.title, s.description, s.github_link, s.status, s.submitted_at, s.revision_notes, s.worker_id
                 FROM submissions s WHERE s.bounty_id = $1 AND s.worker_id = ANY($2::uuid[])
                 ORDER BY s.submitted_at`, [d.bounty_id, workerIds]
            );
            submissions = rows.map((r) => ({ ...r, worker_name: (byId[r.worker_id] || {}).name }));
        }

        // Verification reports and overlap flags are business tools. They are shown to the business and admins.
        let verification = null;
        let overlapCount = 0;
        if ((isAdmin || seesBusinessView) && d.submission_id) {
            const v = await pool.query(
                'SELECT outcome, report, created_at FROM submission_verifications WHERE submission_id = $1 ORDER BY created_at DESC LIMIT 1',
                [d.submission_id]
            );
            if (v.rows.length) verification = { outcome: v.rows[0].outcome, summary: v.rows[0].report.summary, created_at: v.rows[0].created_at };
            const o = await pool.query("SELECT COUNT(*)::int AS n FROM submission_overlaps WHERE status = 'open' AND (submission_id = $1 OR related_submission_id = $1)", [d.submission_id]);
            overlapCount = o.rows[0].n;
        }

        const messages = await pool.query(
            'SELECT m.id, m.body, m.created_at, m.author_id, u.name AS author_name FROM dispute_messages m JOIN users u ON u.id = m.author_id WHERE m.dispute_id = $1 ORDER BY m.created_at', [d.id]
        );
        const evidence = await pool.query(
            'SELECT e.id, e.kind, e.body, e.created_at, e.added_by, u.name AS added_by_name FROM dispute_evidence e JOIN users u ON u.id = e.added_by WHERE e.dispute_id = $1 ORDER BY e.created_at', [d.id]
        );
        const events = await pool.query(
            `SELECT e.event, e.detail, e.created_at, u.name AS actor FROM dispute_events e
             LEFT JOIN users u ON u.id = e.actor_id WHERE e.dispute_id = $1 ORDER BY e.created_at, e.id`, [d.id]
        );

        res.json({
            id: d.id,
            title: d.title,
            category: d.category,
            category_label: (CATEGORIES.find(([k]) => k === d.category) || [])[1],
            description: d.description,
            status: d.status,
            status_label: STATUSES[d.status],
            raised_by: byId[d.raised_by],
            respondent: byId[d.respondent_id],
            viewer_role: isAdmin && !isParty ? 'administrator' : (d.raised_by === req.user.id ? 'raised' : 'respondent'),
            target,
            submissions,
            verification,
            overlap_flags_open: overlapCount,
            decision: d.decision_outcome ? {
                outcome: d.decision_outcome,
                outcome_label: OUTCOMES[d.decision_outcome],
                text: d.decision_text,
                payment: d.payment_decision,
                decided_at: d.decided_at,
            } : null,
            escalation_count: d.escalation_count,
            can_respond: isParty && d.status !== 'resolved',
            can_escalate: isParty && d.status === 'resolved' && d.escalation_count === 0,
            messages: messages.rows,
            evidence: evidence.rows,
            events: events.rows,
            created_at: d.created_at,
            updated_at: d.updated_at,
        });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/disputes/:id/messages
router.post('/:id/messages', authenticate, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'dispute');
        const body = text((req.body || {}).body, 'Message', 5, 3000);
        await client.query('BEGIN');
        const { dispute: d, isParty } = await loadDispute(client, req.params.id, req.user, true);
        if (!isParty) throw httpError(403, 'Only the parties can add messages');
        if (d.status === 'resolved') throw httpError(409, 'This dispute is resolved. Escalate it if you disagree.');

        const actorIsRespondent = d.respondent_id === req.user.id;
        const next = statusAfterMessage(d.status, actorIsRespondent);
        await client.query('INSERT INTO dispute_messages (dispute_id, author_id, body) VALUES ($1, $2, $3)', [d.id, req.user.id, body]);
        await client.query('UPDATE disputes SET status = $2, updated_at = NOW() WHERE id = $1', [d.id, next]);
        await recordEvent(client, d.id, req.user.id, 'message', { status: next });
        await client.query('COMMIT');

        const other = actorIsRespondent ? d.raised_by : d.respondent_id;
        notices.push([other, `New message on the dispute "${d.title}".`, `#/disputes/${d.id}`]);
        notifyAfterCommit(notices);
        res.status(201).json({ status: next });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/disputes/:id/evidence
router.post('/:id/evidence', authenticate, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'dispute');
        const kind = (req.body || {}).kind;
        if (kind !== 'text' && kind !== 'link') throw httpError(400, 'Evidence must be text or a link');
        const body = kind === 'link' ?
            text((req.body || {}).body, 'Link', 10, 500) :
            text((req.body || {}).body, 'Evidence', 5, 3000);
        if (kind === 'link' && !/^https:\/\//i.test(body)) throw httpError(400, 'Evidence links must start with https://');

        await client.query('BEGIN');
        const { dispute: d, isParty } = await loadDispute(client, req.params.id, req.user, true);
        if (!isParty) throw httpError(403, 'Only the parties can add evidence');
        if (d.status === 'resolved') throw httpError(409, 'This dispute is resolved');

        await client.query('INSERT INTO dispute_evidence (dispute_id, added_by, kind, body) VALUES ($1, $2, $3, $4)', [d.id, req.user.id, kind, body]);
        const next = d.status === 'awaiting_evidence' ? 'under_review' : d.status;
        if (next !== d.status) await client.query('UPDATE disputes SET status = $2, updated_at = NOW() WHERE id = $1', [d.id, next]);
        else await client.query('UPDATE disputes SET updated_at = NOW() WHERE id = $1', [d.id]);
        await recordEvent(client, d.id, req.user.id, 'evidence_added', { kind });
        await client.query('COMMIT');

        const other = d.raised_by === req.user.id ? d.respondent_id : d.raised_by;
        notices.push([other, `New evidence was added to the dispute "${d.title}".`, `#/disputes/${d.id}`]);
        notifyAfterCommit(notices);
        res.status(201).json({ status: next });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/disputes/:id/escalate (party, once)
router.post('/:id/escalate', authenticate, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'dispute');
        const reason = text((req.body || {}).reason, 'Reason', 20, 1000);
        await client.query('BEGIN');
        const { dispute: d, isParty } = await loadDispute(client, req.params.id, req.user, true);
        if (!isParty) throw httpError(403, 'Only the parties can escalate a dispute');
        if (d.status !== 'resolved') throw httpError(409, 'Only a decided dispute can be escalated');
        if (d.escalation_count >= 1) throw httpError(409, 'This decision has already been escalated once');

        const { rows } = await client.query(
            `UPDATE disputes SET status = 'escalated', escalation_count = escalation_count + 1, updated_at = NOW()
             WHERE id = $1 RETURNING *`, [d.id]
        );
        await client.query('INSERT INTO dispute_messages (dispute_id, author_id, body) VALUES ($1, $2, $3)', [d.id, req.user.id, `Escalated for a second decision: ${reason}`]);
        await applyPaymentHold(client, rows[0]);
        await recordEvent(client, d.id, req.user.id, 'escalated', {});
        await client.query('COMMIT');

        const other = d.raised_by === req.user.id ? d.respondent_id : d.raised_by;
        notices.push([other, `The decision on "${d.title}" was escalated for a second review.`, `#/disputes/${d.id}`]);
        notifyAfterCommit(notices);
        res.json({ status: 'escalated' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/disputes/:id/request-evidence (admin)
router.post('/:id/request-evidence', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'dispute');
        const note = text((req.body || {}).note, 'Request', 10, 1000);
        await client.query('BEGIN');
        const { dispute: d } = await loadDispute(client, req.params.id, req.user, true);
        if (!ACTIVE.includes(d.status)) throw httpError(409, 'This dispute is not open for more evidence');
        await client.query("UPDATE disputes SET status = 'awaiting_evidence', updated_at = NOW() WHERE id = $1", [d.id]);
        await recordEvent(client, d.id, req.user.id, 'evidence_requested', { note });
        await client.query('INSERT INTO dispute_messages (dispute_id, author_id, body) VALUES ($1, $2, $3)', [d.id, req.user.id, `Reviewer: ${note}`]);
        await client.query('COMMIT');
        notices.push([d.raised_by, `More evidence is needed for "${d.title}".`, `#/disputes/${d.id}`]);
        notices.push([d.respondent_id, `More evidence is needed for "${d.title}".`, `#/disputes/${d.id}`]);
        notifyAfterCommit(notices);
        res.json({ status: 'awaiting_evidence' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/disputes/:id/decide (admin)
router.post('/:id/decide', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'dispute');
        const b = req.body || {};
        if (!OUTCOMES[b.outcome]) throw httpError(400, 'Choose an outcome from the list');
        const decision = text(b.decision, 'Decision explanation', 20, 3000);
        const payment = b.payment === undefined || b.payment === null ? null : b.payment;
        if (payment !== null && payment !== 'release' && payment !== 'withhold') throw httpError(400, 'Payment decision must be release or withhold');

        await client.query('BEGIN');
        const { dispute: d } = await loadDispute(client, req.params.id, req.user, true);
        if (!ACTIVE.includes(d.status)) throw httpError(409, 'This dispute has already been decided');
        const { rows } = await client.query(
            `UPDATE disputes SET status = 'resolved', decision_outcome = $2, decision_text = $3,
                    payment_decision = $4, decided_by = $5, decided_at = NOW(), updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [d.id, b.outcome, decision, payment, req.user.id]
        );
        await applyPaymentHold(client, rows[0]);
        await recordEvent(client, d.id, req.user.id, 'decided', { outcome: b.outcome, payment });
        await client.query('COMMIT');

        const msg = `A decision was recorded on "${d.title}". Open the dispute to read it.`;
        notices.push([d.raised_by, msg, `#/disputes/${d.id}`]);
        notices.push([d.respondent_id, msg, `#/disputes/${d.id}`]);
        notifyAfterCommit(notices);
        res.json({ status: 'resolved', outcome: b.outcome, payment: payment });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

module.exports = router;
