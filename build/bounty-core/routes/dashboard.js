const express = require('express');
const { pool } = require('../db');
const { authenticate, httpError } = require('../middleware/auth');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/dashboard/:userId  (only the signed-in user can load their own dashboard)
router.get('/:userId', authenticate, async(req, res, next) => {
    try {
        const userId = req.params.userId;
        if (!UUID_RE.test(userId)) throw httpError(400, 'Invalid user id');
        if (String(req.user.id) !== userId) throw httpError(403, 'You can only view your own dashboard');

        if (req.user.role === 'business') {
            const stats = await pool.query(
                `SELECT
                   (SELECT COUNT(*)::int FROM bounties WHERE business_id = $1 AND status = 'open') AS active_bounties,
                   (SELECT COUNT(*)::int FROM bounties WHERE business_id = $1 AND status = 'completed') AS completed_bounties,
                   (SELECT COUNT(*)::int FROM submissions s JOIN bounties b ON b.id = s.bounty_id
                      WHERE b.business_id = $1 AND s.status = 'pending') AS pending_submissions,
                   (SELECT COALESCE(SUM(amount), 0)::float FROM payments WHERE business_id = $1) AS total_spent`, [userId]
            );
            const bounties = await pool.query(
                `SELECT id, title, status, deadline, reward_amount, created_at
                 FROM bounties
                 WHERE business_id = $1
                 ORDER BY created_at DESC
                 LIMIT 10`, [userId]
            );
            return res.json({
                stats: stats.rows[0],
                active_bounties: bounties.rows,
                recent_submissions: []
            });
        }

        // Worker
        const stats = await pool.query(
            `SELECT
               (SELECT COUNT(*)::int FROM submissions WHERE worker_id = $1 AND status = 'pending') AS active_bounties,
               (SELECT COUNT(*)::int FROM submissions WHERE worker_id = $1 AND status = 'approved') AS completed_bounties,
               (SELECT COALESCE(total_earned, 0)::float FROM users WHERE id = $1) AS total_earned`, [userId]
        );
        const submissions = await pool.query(
            `SELECT s.id, s.title, s.status, s.rejection_reason, s.submitted_at, s.submitted_at AS created_at,
                    b.id AS bounty_id, b.title AS bounty_title
             FROM submissions s
             JOIN bounties b ON b.id = s.bounty_id
             WHERE s.worker_id = $1
             ORDER BY s.submitted_at DESC
             LIMIT 10`, [userId]
        );
        return res.json({
            stats: stats.rows[0],
            active_bounties: [],
            recent_submissions: submissions.rows
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;