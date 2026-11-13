// routes/protection.js — Creator Protection, task NDAs, misuse reports and enforcement.
//
// Agreements
//   GET  /api/protection/agreements                 current texts and hashes (public)
//   GET  /api/protection/agreements/mine            which current agreements you have accepted
//   POST /api/protection/agreements/accept          { kind, bounty_id? }
//
// Task confidentiality
//   GET  /api/protection/business/nda-records?bounty_id=   owner: who accepted, when
//   POST /api/protection/bounties/:id/revoke-access        owner: { worker_id } removes access
//
// Misuse and incident reports
//   POST /api/protection/reports                    { kind, bounty_id, submission_id?, description, evidence? }
//   GET  /api/protection/reports/mine               your reports and their status
//
// Admin (requireAdmin)
//   GET  /api/protection/admin/reports              ?status=
//   GET  /api/protection/admin/reports/:id          report, accused history, audit trail
//   PATCH /api/protection/admin/reports/:id         { status, findings? }
//   POST /api/protection/admin/enforcement          { user_id, action, reason, report_id? }
//   POST /api/protection/admin/enforcement/:id/reverse   { reason }
//   GET  /api/protection/admin/enforcement?user_id=
//   GET  /api/protection/admin/appeals?status=open
//   GET  /api/protection/business/confidential-tasks  your confidential tasks
//   POST /api/protection/admin/appeals/:id/decide   { decision: 'upheld' | 'overturned', note }
//   POST /api/protection/enforcement/:id/appeal     { statement }   (the affected user)
//   GET  /api/protection/enforcement/mine           your enforcement history and appeal status

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, requireAdmin, httpError } = require('../middleware/auth');
const {
    agreementCatalogue, AGREEMENTS, KINDS, recordAcceptance, logAudit,
} = require('../services/protection');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (sql, params) => pool.query(sql, params);
const REPORT_KINDS = ['copyright_misuse', 'confidentiality_incident'];
const MAX_OPEN_REPORTS_PER_USER = 5;
const TEXT_LIMITS = { description: 2000, evidence: 2000, reason: 1000, statement: 2000, findings: 4000 };

function requireUuid(value, field) {
    if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
        throw httpError(400, `${field} must be a valid UUID`);
    }
    return value.trim();
}

function requireText(value, field, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw httpError(400, `${field} is required`);
    if (text.length > max) throw httpError(400, `${field} must be at most ${max} characters`);
    return text;
}

// ------------------------------------------------------------ agreements
router.get('/agreements', (req, res) => {
    res.json({ agreements: agreementCatalogue() });
});

router.get('/agreements/mine', authenticate, async(req, res, next) => {
    try {
        const { rows } = await q(
            `SELECT kind, version, body_sha256, accepted_at, bounty_id
             FROM agreement_acceptances
             WHERE user_id = $1 AND version = ANY($2::text[])
             ORDER BY accepted_at DESC`,
            [req.user.id, Object.values(AGREEMENTS).map((a) => a.version)]
        );
        res.json({ accepted: rows });
    } catch (err) { next(err); }
});

router.post('/agreements/accept', authenticate, async(req, res, next) => {
    try {
        const { kind, bounty_id } = req.body || {};
        if (!KINDS.includes(kind)) throw httpError(400, 'kind must be a known agreement');

        if (kind === 'creator_protection_business') {
            if (req.user.role !== 'business') throw httpError(403, 'Only businesses accept the Creator Protection Agreement');
            await recordAcceptance(q, req.user.id, kind);
            await logAudit(q, req.user.id, 'agreement.accepted', 'user', req.user.id, { kind, version: AGREEMENTS[kind].version });
            return res.json({ ok: true, kind, version: AGREEMENTS[kind].version });
        }

        if (kind === 'worker_submission_ip') {
            if (req.user.role !== 'worker') throw httpError(403, 'Only workers accept the Worker Submission Agreement');
            await recordAcceptance(q, req.user.id, kind);
            await logAudit(q, req.user.id, 'agreement.accepted', 'user', req.user.id, { kind, version: AGREEMENTS[kind].version });
            return res.json({ ok: true, kind, version: AGREEMENTS[kind].version });
        }

        // task_nda: per task, by a worker, only for tasks the business marked confidential.
        if (req.user.role !== 'worker') throw httpError(403, 'Only workers accept a task NDA');
        const bountyId = requireUuid(bounty_id, 'bounty_id');
        const { rows } = await q('SELECT id, confidential FROM bounties WHERE id = $1', [bountyId]);
        if (!rows[0]) throw httpError(404, 'Task not found');
        if (!rows[0].confidential) throw httpError(400, 'This task is not marked confidential');
        await recordAcceptance(q, req.user.id, kind, bountyId);
        await logAudit(q, req.user.id, 'nda.accepted', 'bounty', bountyId, { kind, version: AGREEMENTS[kind].version });
        res.json({ ok: true, kind, version: AGREEMENTS[kind].version, bounty_id: bountyId });
    } catch (err) { next(err); }
});

router.get('/business/confidential-tasks', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const { rows } = await q(
            `SELECT id, title, status, created_at FROM bounties
             WHERE business_id = $1 AND confidential = TRUE ORDER BY created_at DESC LIMIT 100`,
            [req.user.id]
        );
        res.json({ tasks: rows });
    } catch (err) { next(err); }
});

// ------------------------------------------------------------ NDA records for businesses
router.get('/business/nda-records', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const bountyId = requireUuid(req.query.bounty_id, 'bounty_id');
        const { rows: owned } = await q(
            'SELECT id FROM bounties WHERE id = $1 AND business_id = $2', [bountyId, req.user.id]
        );
        if (!owned[0]) throw httpError(404, 'Task not found');

        const { rows } = await q(
            `SELECT a.user_id AS worker_id, a.version, a.body_sha256, a.accepted_at,
                    u.name AS worker_name, p.status AS participation_status
             FROM agreement_acceptances a
             JOIN users u ON u.id = a.user_id
             LEFT JOIN bounty_participants p ON p.bounty_id = a.bounty_id AND p.worker_id = a.user_id
             WHERE a.bounty_id = $1 AND a.kind = 'task_nda'
             ORDER BY a.accepted_at DESC`,
            [bountyId]
        );
        res.json({ records: rows });
    } catch (err) { next(err); }
});

// Revoke a worker's access to confidential material. Their NDA acceptance stays on record.
router.post('/bounties/:id/revoke-access', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const bountyId = requireUuid(req.params.id, 'id');
        const workerId = requireUuid((req.body || {}).worker_id, 'worker_id');
        await client.query('BEGIN');
        const { rows: owned } = await client.query(
            'SELECT id, confidential FROM bounties WHERE id = $1 AND business_id = $2 FOR UPDATE',
            [bountyId, req.user.id]
        );
        if (!owned[0]) throw httpError(404, 'Task not found');
        const { rowCount } = await client.query(
            `UPDATE bounty_participants SET status = 'withdrawn', updated_at = NOW()
             WHERE bounty_id = $1 AND worker_id = $2 AND status IN ('active', 'assigned')`,
            [bountyId, workerId]
        );
        if (rowCount === 0) throw httpError(404, 'No active participation for that worker');
        await logAudit(client.query.bind(client), req.user.id, 'access.revoked', 'bounty', bountyId,
            { worker_id: workerId });
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------ reports (workers and businesses)
router.post('/reports', authenticate, async(req, res, next) => {
    try {
        const body = req.body || {};
        if (!REPORT_KINDS.includes(body.kind)) throw httpError(400, 'kind must be copyright_misuse or confidentiality_incident');
        const bountyId = requireUuid(body.bounty_id, 'bounty_id');
        const description = requireText(body.description, 'description', TEXT_LIMITS.description);
        const evidence = typeof body.evidence === 'string' && body.evidence.trim()
            ? body.evidence.trim().slice(0, TEXT_LIMITS.evidence) : null;

        const { rows: bountyRows } = await q('SELECT id, business_id FROM bounties WHERE id = $1', [bountyId]);
        if (!bountyRows[0]) throw httpError(404, 'Task not found');
        const bounty = bountyRows[0];

        const { rows: open } = await q(
            `SELECT COUNT(*)::int AS n FROM misuse_reports
             WHERE reporter_id = $1 AND status IN ('submitted', 'under_review', 'additional_information_required')`,
            [req.user.id]
        );
        if (open[0].n >= MAX_OPEN_REPORTS_PER_USER) {
            throw httpError(429, 'You already have several open reports. Wait for them to be reviewed.');
        }

        let submissionId = null;
        let accused = null;

        if (body.kind === 'copyright_misuse') {
            // Only a worker can report misuse of their own submission.
            submissionId = requireUuid(body.submission_id, 'submission_id');
            const { rows } = await q(
                'SELECT id FROM submissions WHERE id = $1 AND bounty_id = $2 AND worker_id = $3',
                [submissionId, bountyId, req.user.id]
            );
            if (!rows[0]) throw httpError(403, 'You can only report misuse of your own submission');
            accused = bounty.business_id;
        } else {
            // Confidentiality incidents: the worker on the task, or the business that owns it.
            const isOwner = bounty.business_id === req.user.id;
            if (!isOwner) {
                const { rows } = await q(
                    'SELECT 1 FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2',
                    [bountyId, req.user.id]
                );
                if (!rows[0]) throw httpError(403, 'Only people involved in this task can report a confidentiality incident');
            }
        }

        const { rows } = await q(
            `INSERT INTO misuse_reports
               (kind, reporter_id, accused_business_id, bounty_id, submission_id, description, evidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, kind, status, created_at`,
            [body.kind, req.user.id, accused, bountyId, submissionId, description, evidence]
        );
        await logAudit(q, req.user.id, 'report.submitted', 'misuse_report', rows[0].id,
            { kind: body.kind, bounty_id: bountyId, submission_id: submissionId });
        res.status(201).json({ report: rows[0] });
    } catch (err) { next(err); }
});

router.get('/reports/mine', authenticate, async(req, res, next) => {
    try {
        // Reporters see status and their own text. Internal findings and reviewer identity stay private.
        const { rows } = await q(
            `SELECT id, kind, bounty_id, submission_id, status, created_at, updated_at
             FROM misuse_reports WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [req.user.id]
        );
        res.json({ reports: rows });
    } catch (err) { next(err); }
});

// ------------------------------------------------------------ admin: report review
const REPORT_TRANSITIONS = {
    submitted: ['under_review', 'rejected'],
    under_review: ['additional_information_required', 'resolved', 'rejected'],
    additional_information_required: ['under_review', 'resolved', 'rejected'],
    resolved: [],
    rejected: [],
};

router.get('/admin/reports', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const status = req.query.status;
        const params = [];
        let where = '';
        if (status) {
            if (!Object.keys(REPORT_TRANSITIONS).includes(status)) throw httpError(400, 'Unknown status');
            params.push(status);
            where = 'WHERE m.status = $1';
        }
        const { rows } = await q(
            `SELECT m.id, m.kind, m.status, m.created_at, m.updated_at, m.bounty_id, m.submission_id,
                    rep.name AS reporter_name, acc.name AS accused_name
             FROM misuse_reports m
             JOIN users rep ON rep.id = m.reporter_id
             LEFT JOIN users acc ON acc.id = m.accused_business_id
             ${where}
             ORDER BY m.created_at DESC LIMIT 200`,
            params
        );
        res.json({ reports: rows });
    } catch (err) { next(err); }
});

router.get('/admin/reports/:id', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const id = requireUuid(req.params.id, 'id');
        const { rows } = await q(
            `SELECT m.*, rep.name AS reporter_name, acc.name AS accused_name,
                    b.title AS bounty_title, s.github_link AS submission_link
             FROM misuse_reports m
             JOIN users rep ON rep.id = m.reporter_id
             LEFT JOIN users acc ON acc.id = m.accused_business_id
             LEFT JOIN bounties b ON b.id = m.bounty_id
             LEFT JOIN submissions s ON s.id = m.submission_id
             WHERE m.id = $1`, [id]
        );
        if (!rows[0]) throw httpError(404, 'Report not found');
        const report = rows[0];

        const { rows: history } = report.accused_business_id ? await q(
            `SELECT id, action, reverses_action_id, report_id, reason, created_at
             FROM enforcement_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [report.accused_business_id]
        ) : { rows: [] };

        const { rows: audit } = await q(
            `SELECT action, actor_id, details, created_at FROM audit_events
             WHERE entity_type = 'misuse_report' AND entity_id = $1 ORDER BY created_at ASC`, [id]
        );
        res.json({ report, accused_enforcement_history: history, audit });
    } catch (err) { next(err); }
});

router.patch('/admin/reports/:id', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    try {
        const id = requireUuid(req.params.id, 'id');
        const { status, findings } = req.body || {};
        if (typeof status !== 'string') throw httpError(400, 'status is required');
        const findingsText = typeof findings === 'string' ? findings.trim().slice(0, TEXT_LIMITS.findings) : null;

        await client.query('BEGIN');
        const { rows } = await client.query('SELECT status FROM misuse_reports WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw httpError(404, 'Report not found');
        const from = rows[0].status;
        if (!(REPORT_TRANSITIONS[from] || []).includes(status)) {
            throw httpError(400, `A report cannot move from ${from} to ${status}`);
        }
        if ((status === 'resolved' || status === 'rejected') && !findingsText) {
            throw httpError(400, 'Record the investigation findings before closing a report');
        }
        await client.query(
            `UPDATE misuse_reports
             SET status = $2, findings = COALESCE($3, findings), reviewed_by = $4, updated_at = NOW()
             WHERE id = $1`,
            [id, status, findingsText, req.user.id]
        );
        await logAudit(client.query.bind(client), req.user.id, 'report.status_changed', 'misuse_report', id,
            { from, to: status });
        await client.query('COMMIT');
        res.json({ ok: true, status });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------ admin: enforcement
// Current state of an account, derived from the append-only log.
async function derivedStatus(db, userId) {
    const { rows } = await db.query(
        `SELECT action FROM enforcement_actions a
         WHERE a.user_id = $1 AND a.action IN ('restrict_publishing', 'suspend', 'terminate')
           AND NOT EXISTS (
             SELECT 1 FROM enforcement_actions r
             WHERE r.reverses_action_id = a.id
           )`,
        [userId]
    );
    // Termination is permanent: it is never reversed, so it always wins.
    if (rows.some((r) => r.action === 'terminate')) return 'terminated';
    if (rows.some((r) => r.action === 'suspend')) return 'suspended';
    if (rows.some((r) => r.action === 'restrict_publishing')) return 'restricted';
    return 'active';
}

const ENFORCE_ACTIONS = { warning: null, restrict_publishing: 'restricted', suspend: 'suspended', terminate: 'terminated' };

async function applyEnforcement(client, { userId, action, reason, reportId, actorId }) {
    await client.query('BEGIN');
    try {
        const { rows } = await client.query(
            `INSERT INTO enforcement_actions (user_id, action, report_id, reason, created_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [userId, action, reportId || null, reason, actorId]
        );
        const status = await derivedStatus(client, userId);
        await client.query('UPDATE users SET account_status = $2 WHERE id = $1', [userId, status]);
        await logAudit(client.query.bind(client), actorId, `enforcement.${action}`, 'user', userId,
            { enforcement_id: rows[0].id, report_id: reportId || null, account_status: status });
        await client.query('COMMIT');
        return rows[0].id;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    }
}

router.post('/admin/enforcement', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    try {
        const body = req.body || {};
        const userId = requireUuid(body.user_id, 'user_id');
        if (userId === req.user.id) throw httpError(400, 'Admins cannot enforce against their own account');
        if (!Object.prototype.hasOwnProperty.call(ENFORCE_ACTIONS, body.action) || body.action === 'reverse') {
            throw httpError(400, 'action must be warning, restrict_publishing, suspend or terminate');
        }
        const reason = requireText(body.reason, 'reason', TEXT_LIMITS.reason);
        const reportId = body.report_id ? requireUuid(body.report_id, 'report_id') : null;
        const { rows } = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
        if (!rows[0]) throw httpError(404, 'User not found');

        if (body.action === 'terminate') {
            // Termination is permanent. It needs a resolved report about this account and an
            // explicit legal-review confirmation, and it is never reversed through this API.
            if (body.legal_review_confirmed !== true) {
                throw httpError(400, 'Termination requires legal review. Set legal_review_confirmed after that review.');
            }
            if (!reportId) throw httpError(400, 'Termination needs the resolved report that supports it');
            const { rows: rep } = await client.query(
                'SELECT status, accused_business_id FROM misuse_reports WHERE id = $1', [reportId]
            );
            if (!rep[0]) throw httpError(404, 'Report not found');
            if (rep[0].status !== 'resolved') throw httpError(400, 'Termination needs a resolved report');
            if (rep[0].accused_business_id !== userId) throw httpError(400, 'That report does not concern this account');
        }

        const id = await applyEnforcement(client, { userId, action: body.action, reason, reportId, actorId: req.user.id });
        res.status(201).json({ ok: true, id });
    } catch (err) { next(err); } finally { client.release(); }
});

async function reverseAction(client, { actionId, reason, actorId }) {
    await client.query('BEGIN');
    try {
        const { rows } = await client.query('SELECT id, user_id, action, reverses_action_id FROM enforcement_actions WHERE id = $1', [actionId]);
        const target = rows[0];
        if (!target) throw httpError(404, 'Enforcement action not found');
        if (target.action === 'reverse') throw httpError(400, 'A reversal cannot itself be reversed');
        if (target.action === 'terminate') {
            throw httpError(403, 'Termination cannot be reversed through this route. It requires legal review.');
        }
        const { rows: already } = await client.query(
            'SELECT 1 FROM enforcement_actions WHERE reverses_action_id = $1', [actionId]
        );
        if (already[0]) throw httpError(409, 'This action has already been reversed');

        const { rows: inserted } = await client.query(
            `INSERT INTO enforcement_actions (user_id, action, reverses_action_id, reason, created_by)
             VALUES ($1, 'reverse', $2, $3, $4) RETURNING id`,
            [target.user_id, actionId, reason, actorId]
        );
        const status = await derivedStatus(client, target.user_id);
        await client.query('UPDATE users SET account_status = $2 WHERE id = $1', [target.user_id, status]);
        await logAudit(client.query.bind(client), actorId, 'enforcement.reversed', 'user', target.user_id,
            { reversed_action_id: actionId, reversal_id: inserted[0].id, account_status: status });
        await client.query('COMMIT');
        return inserted[0].id;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    }
}

router.post('/admin/enforcement/:id/reverse', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    try {
        const actionId = requireUuid(req.params.id, 'id');
        const reason = requireText((req.body || {}).reason, 'reason', TEXT_LIMITS.reason);
        const id = await reverseAction(client, { actionId, reason, actorId: req.user.id });
        res.json({ ok: true, reversal_id: id });
    } catch (err) { next(err); } finally { client.release(); }
});

// The account's own enforcement history and appeal status (no internal investigation detail).
router.get('/enforcement/mine', authenticate, async(req, res, next) => {
    try {
        const { rows } = await q(
            `SELECT a.id, a.action, a.reason, a.created_at,
                    EXISTS (SELECT 1 FROM enforcement_actions r WHERE r.reverses_action_id = a.id) AS reversed,
                    ap.status AS appeal_status, ap.decision_note, ap.decided_at
             FROM enforcement_actions a
             LEFT JOIN enforcement_appeals ap ON ap.enforcement_action_id = a.id
             WHERE a.user_id = $1 AND a.action <> 'reverse'
             ORDER BY a.created_at DESC LIMIT 100`,
            [req.user.id]
        );
        res.json({ actions: rows });
    } catch (err) { next(err); }
});

router.get('/admin/appeals', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const status = req.query.status || 'open';
        if (!['open', 'upheld', 'overturned'].includes(status)) throw httpError(400, 'Unknown status');
        const { rows } = await q(
            `SELECT ap.id, ap.status, ap.statement, ap.created_at, ap.decided_at,
                    ap.enforcement_action_id, u.name AS user_name, a.action
             FROM enforcement_appeals ap
             JOIN enforcement_actions a ON a.id = ap.enforcement_action_id
             JOIN users u ON u.id = ap.user_id
             WHERE ap.status = $1 ORDER BY ap.created_at ASC LIMIT 200`, [status]
        );
        res.json({ appeals: rows });
    } catch (err) { next(err); }
});

router.get('/admin/enforcement', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const userId = requireUuid(req.query.user_id, 'user_id');
        const { rows } = await q(
            `SELECT id, action, reverses_action_id, report_id, reason, created_at
             FROM enforcement_actions WHERE user_id = $1 ORDER BY created_at DESC`, [userId]
        );
        res.json({ actions: rows });
    } catch (err) { next(err); }
});

// ------------------------------------------------------------ appeals
router.post('/enforcement/:id/appeal', authenticate, async(req, res, next) => {
    try {
        const actionId = requireUuid(req.params.id, 'id');
        const statement = requireText((req.body || {}).statement, 'statement', TEXT_LIMITS.statement);
        const { rows } = await q(
            `SELECT id, user_id, action FROM enforcement_actions
             WHERE id = $1 AND action IN ('restrict_publishing', 'suspend', 'terminate')`, [actionId]
        );
        if (!rows[0] || rows[0].user_id !== req.user.id) throw httpError(404, 'Enforcement action not found');
        if (rows[0].action === 'terminate') {
            throw httpError(403, 'Termination appeals are handled through legal review, not this form');
        }
        const { rows: reversed } = await q(
            'SELECT 1 FROM enforcement_actions WHERE reverses_action_id = $1', [actionId]
        );
        if (reversed[0]) throw httpError(400, 'This action has already been reversed');

        const { rows: created } = await q(
            `INSERT INTO enforcement_appeals (enforcement_action_id, user_id, statement)
             VALUES ($1, $2, $3) RETURNING id, status, created_at`,
            [actionId, req.user.id, statement]
        ).catch((err) => {
            if (err.code === '23505') throw httpError(409, 'An appeal has already been filed for this action; each action can be appealed once');
            throw err;
        });
        await logAudit(q, req.user.id, 'appeal.submitted', 'enforcement_action', actionId, { appeal_id: created[0].id });
        res.status(201).json({ appeal: created[0] });
    } catch (err) { next(err); }
});

router.post('/admin/appeals/:id/decide', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    try {
        const appealId = requireUuid(req.params.id, 'id');
        const { decision, note } = req.body || {};
        if (decision !== 'upheld' && decision !== 'overturned') throw httpError(400, 'decision must be upheld or overturned');
        const decisionNote = requireText(note, 'note', TEXT_LIMITS.findings);

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, enforcement_action_id, status FROM enforcement_appeals WHERE id = $1 FOR UPDATE`, [appealId]
        );
        if (!rows[0]) throw httpError(404, 'Appeal not found');
        if (rows[0].status !== 'open') throw httpError(409, 'This appeal has already been decided');
        await client.query(
            `UPDATE enforcement_appeals SET status = $2, decision_note = $3, decided_by = $4, decided_at = NOW()
             WHERE id = $1`,
            [appealId, decision, decisionNote, req.user.id]
        );
        await client.query('COMMIT');
        // Overturning reverses the enforcement in its own transaction, so the log stays consistent.
        if (decision === 'overturned') {
            await reverseAction(client, { actionId: rows[0].enforcement_action_id,
                reason: `Appeal overturned: ${decisionNote}`, actorId: req.user.id });
        }
        await logAudit(q, req.user.id, `appeal.${decision}`, 'enforcement_appeal', appealId, {});
        res.json({ ok: true, status: decision });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

module.exports = router;
