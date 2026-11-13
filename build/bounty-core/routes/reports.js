// routes/reports.js — report a bounty (disputes, unpaid rewards, abuse)
//
// POST /api/reports                     (authenticated; business owner or a worker who submitted)
//   Body: { "bounty_id": "<uuid>",
//           "reason": "unpaid" | "unfair_rejection" | "spam" | "abusive" | "other",
//           "details": "optional, max 1000" }
//
// Reports are stored with status 'open'. Admins review them at #/admin
// (see routes/admin.js). Set ADMIN_NOTIFY_EMAIL to get an email for each new report.

const express = require('express');
const { pool } = require('../db');
const { authenticate, httpError } = require('../middleware/auth');
const { sendEmail, appUrl } = require('../services/email');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['unpaid', 'unfair_rejection', 'spam', 'abusive', 'other'];

// ------------------------------------------------ POST /api/reports
router.post('/', authenticate, async(req, res, next) => {
    try {
        if (!req.user.email_verified_at) {
            throw httpError(403, 'Verify your email before reporting a bounty');
        }
        const { bounty_id, reason, details } = req.body || {};

        const bountyId = typeof bounty_id === 'string' ? bounty_id.trim() : '';
        if (!UUID_RE.test(bountyId)) throw httpError(400, 'bounty_id must be a valid UUID');
        if (!REASONS.includes(reason)) {
            throw httpError(400, `reason must be one of: ${REASONS.join(', ')}`);
        }
        if (details !== undefined && details !== null &&
            (typeof details !== 'string' || details.length > 1000)) {
            throw httpError(400, 'Details must be text, 1000 characters at most');
        }

        const { rows } = await pool.query('SELECT id, business_id FROM bounties WHERE id = $1', [bountyId]);
        if (rows.length === 0) throw httpError(404, 'Bounty not found');

        // Only people involved in the bounty can report it.
        const isOwner = rows[0].business_id === req.user.id;
        let isWorker = false;
        if (!isOwner) {
            const sub = await pool.query(
                'SELECT 1 FROM submissions WHERE bounty_id = $1 AND worker_id = $2 LIMIT 1',
                [bountyId, req.user.id]
            );
            isWorker = sub.rows.length > 0;
        }
        if (!isOwner && !isWorker) {
            throw httpError(403, 'Only the business or a worker who submitted can report this bounty');
        }

        let report;
        try {
            const result = await pool.query(
                `INSERT INTO reports (bounty_id, reporter_id, reason, details)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, bounty_id, reason, status, created_at`,
                [bountyId, req.user.id, reason, details ? details.trim() : null]
            );
            report = result.rows[0];
        } catch (err) {
            if (err.code === '23505') throw httpError(409, 'You have already reported this bounty');
            throw err;
        }

        // Tell the admin team about the new report (optional: set ADMIN_NOTIFY_EMAIL).
        if (process.env.ADMIN_NOTIFY_EMAIL) {
            sendEmail({
                to: process.env.ADMIN_NOTIFY_EMAIL,
                subject: 'New report on Bounty',
                text: `A new report was filed.\n\nReason: ${reason}\nBounty ID: ${bountyId}\n\nReview it: ${appUrl()}/#/admin`,
            }).catch((err) => console.error('✗ Admin alert email failed:', err.message));
        }

        res.status(201).json(report);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
