// routes/admin.js — review reports on bounties. Admins only.
//
// GET   /api/admin/reports?status=open|resolved|dismissed|all   (default: open)
// PATCH /api/admin/reports/:id   Body: { "status": "resolved" | "dismissed", "admin_note": "optional, max 1000" }
//
// Admins are set in the database: UPDATE users SET is_admin = TRUE WHERE email = '...';

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, httpError } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { syncShowcase } = require('../services/showcase/sync');
const { createShowcasePublisher } = require('../services/showcase/publish');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_STATUSES = ['open', 'resolved', 'dismissed', 'all'];
const DECISIONS = ['resolved', 'dismissed'];

router.use(authenticate, requireAdmin);

// ------------------------------------------------ POST /showcase/sync
// Pushes stale showcase rows to Workpeg. Run by hand; Workpeg has no scheduler.
// No Workpeg client is configured yet, so rows stay stale and the response says so.
router.post('/showcase/sync', async(req, res, next) => {
    try {
        const requested = req.body && req.body.limit !== undefined ? Number(req.body.limit) : 50;
        if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
            throw httpError(400, 'limit must be a whole number from 1 to 200');
        }
        const publisher = createShowcasePublisher();
        const report = await syncShowcase(pool, publisher, { limit: requested });
        res.json({ ...report, workpeg_configured: false });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ GET /reports
router.get('/reports', async(req, res, next) => {
    try {
        const status = req.query.status || 'open';
        if (!LIST_STATUSES.includes(status)) {
            throw httpError(400, 'status must be open, resolved, dismissed, or all');
        }

        const params = [];
        let where = '';
        if (status !== 'all') {
            params.push(status);
            where = 'WHERE r.status = $1';
        }

        const { rows } = await pool.query(
            `SELECT r.id, r.reason, r.details, r.status, r.admin_note, r.created_at, r.resolved_at,
                    b.id AS bounty_id, b.title AS bounty_title, b.status AS bounty_status,
                    rep.name AS reporter_name, rep.role AS reporter_role,
                    biz.name AS business_name, w.name AS winner_name
             FROM reports r
             JOIN bounties b ON b.id = r.bounty_id
             JOIN users rep ON rep.id = r.reporter_id
             JOIN users biz ON biz.id = b.business_id
             LEFT JOIN users w ON w.id = b.winner_id
             ${where}
             ORDER BY r.created_at DESC
             LIMIT 200`, params
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ PATCH /reports/:id
router.patch('/reports/:id', async(req, res, next) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id)) throw httpError(400, 'Invalid report id');

        const { status, admin_note } = req.body || {};
        if (!DECISIONS.includes(status)) throw httpError(400, 'status must be resolved or dismissed');
        if (admin_note !== undefined && admin_note !== null &&
            (typeof admin_note !== 'string' || admin_note.length > 1000)) {
            throw httpError(400, 'admin_note must be text, 1000 characters at most');
        }

        await client.query('BEGIN');

        // Lock the row so two admins cannot resolve the same report.
        const { rows } = await client.query(
            `SELECT r.id, r.status, r.reporter_id, r.bounty_id, b.title AS bounty_title
             FROM reports r JOIN bounties b ON b.id = r.bounty_id
             WHERE r.id = $1 FOR UPDATE OF r`, [id]
        );
        if (rows.length === 0) throw httpError(404, 'Report not found');
        if (rows[0].status !== 'open') throw httpError(409, `Report is already ${rows[0].status}`);

        const updated = await client.query(
            `UPDATE reports
             SET status = $1, admin_note = $2, resolved_at = NOW(), resolved_by = $3
             WHERE id = $4 AND status = 'open'
             RETURNING id, status, admin_note, resolved_at`,
            [status, admin_note ? admin_note.trim() : null, req.user.id, id]
        );

        await client.query('COMMIT');

        // Tell the person who reported it. Sent after the commit.
        createNotification(
            rows[0].reporter_id,
            `Your report on "${rows[0].bounty_title}" was ${status}.`,
            '#/bounties/' + rows[0].bounty_id
        ).catch(() => {});

        res.json(updated.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

module.exports = router;
