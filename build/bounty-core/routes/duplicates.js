// routes/duplicates.js — duplicate submission review for the business that owns the bounty.
//
// GET   /api/duplicates/bounty/:bountyId  (owner or admin) flags with both submissions summarised
// POST  /api/duplicates/bounty/:bountyId/scan (owner) re-compares every pair in the bounty
// PATCH /api/duplicates/:id              (owner) record a decision: duplicate, independent or dismissed
// Flags are never deleted. Each decision is written to the bounty's audit trail.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { scanBounty } = require('../services/duplicates');
const { logEvent } = require('../services/execution');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = { duplicate: 'duplicate', independent: 'independent', dismissed: 'dismissed' };

function checkId(id, label) {
    if (!UUID_RE.test(id)) throw httpError(400, `Invalid ${label} id`);
}

async function ownBounty(bountyId, user) {
    const { rows } = await pool.query('SELECT id, business_id, requires_authorization FROM bounties WHERE id = $1', [bountyId]);
    if (rows.length === 0) throw httpError(404, 'Bounty not found');
    if (rows[0].business_id !== user.id && user.is_admin !== true) throw httpError(403, 'You do not own this bounty');
    return rows[0];
}

// ------------------------------------------------ GET /api/duplicates/bounty/:bountyId
router.get('/bounty/:bountyId', authenticate, async(req, res, next) => {
    try {
        checkId(req.params.bountyId, 'bounty');
        await ownBounty(req.params.bountyId, req.user);
        const { rows } = await pool.query(
            `SELECT o.id, o.score, o.signals, o.security, o.status, o.review_note, o.reviewed_at, o.created_at,
                    a.id AS a_id, a.title AS a_title, a.status AS a_status, a.submitted_at AS a_submitted,
                    ua.name AS a_worker,
                    b.id AS b_id, b.title AS b_title, b.status AS b_status, b.submitted_at AS b_submitted,
                    ub.name AS b_worker
             FROM submission_overlaps o
             JOIN submissions a ON a.id = o.submission_id
             JOIN submissions b ON b.id = o.related_submission_id
             JOIN users ua ON ua.id = a.worker_id
             JOIN users ub ON ub.id = b.worker_id
             WHERE o.bounty_id = $1
             ORDER BY o.status = 'open' DESC, o.score DESC, o.created_at DESC`, [req.params.bountyId]
        );
        res.json(rows.map((r) => {
            const { explanation = [], ...signals } = r.signals || {};
            return {
                id: r.id,
                score: Number(r.score),
                status: r.status,
                security: r.security,
                explanation,
                signals,
                review_note: r.review_note,
                reviewed_at: r.reviewed_at,
                created_at: r.created_at,
                submissions: [
                    { id: r.a_id, title: r.a_title, status: r.a_status, submitted_at: r.a_submitted, worker_name: r.a_worker },
                    { id: r.b_id, title: r.b_title, status: r.b_status, submitted_at: r.b_submitted, worker_name: r.b_worker },
                ],
            };
        }));
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/duplicates/bounty/:bountyId/scan
router.post('/bounty/:bountyId/scan', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        checkId(req.params.bountyId, 'bounty');
        const bounty = await ownBounty(req.params.bountyId, req.user);
        const created = await scanBounty(pool, bounty.id, { security: Boolean(bounty.requires_authorization) });
        res.json({ created });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ PATCH /api/duplicates/:id
router.patch('/:id', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        checkId(req.params.id, 'flag');
        const decision = DECISIONS[(req.body || {}).decision];
        if (!decision) throw httpError(400, 'Decision must be duplicate, independent or dismissed');
        const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
        if (note.length > 500) throw httpError(400, 'Note must be 500 characters at most');

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT o.id, o.bounty_id, o.status, b.business_id FROM submission_overlaps o
             JOIN bounties b ON b.id = o.bounty_id WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id]
        );
        if (rows.length === 0) throw httpError(404, 'Flag not found');
        if (rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own this bounty');

        const { rows: updated } = await client.query(
            `UPDATE submission_overlaps SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW()
             WHERE id = $1 RETURNING id, status, review_note, reviewed_at`,
            [req.params.id, decision, note || null, req.user.id]
        );
        await logEvent(client, rows[0].bounty_id, req.user.id, 'overlap_reviewed', { flag: req.params.id, decision });
        await client.query('COMMIT');
        res.json(updated[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

module.exports = router;
