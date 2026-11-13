// routes/reviews.js — ratings after a bounty is completed
//
// POST /api/reviews                     (authenticated; business or winning worker)
//   Body: { "bounty_id": "<uuid>", "rating": 1-5, "comment": "optional, max 500" }
//   The business reviews the winner; the winner reviews the business.
//
// GET  /api/reviews/user/:userId        (public)
//   Returns { average, count, reviews: [...] } for reviews received by that user.

const express = require('express');
const { pool } = require('../db');
const { authenticate, httpError } = require('../middleware/auth');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------ POST /api/reviews
router.post('/', authenticate, async(req, res, next) => {
    const client = await pool.connect();
    try {
        if (!req.user.email_verified_at) {
            throw httpError(403, 'Verify your email before leaving a review');
        }
        const { bounty_id, rating, comment } = req.body || {};

        const bountyId = typeof bounty_id === 'string' ? bounty_id.trim() : '';
        if (!UUID_RE.test(bountyId)) throw httpError(400, 'bounty_id must be a valid UUID');
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            throw httpError(400, 'Rating must be a whole number from 1 to 5');
        }
        if (comment !== undefined && comment !== null &&
            (typeof comment !== 'string' || comment.length > 500)) {
            throw httpError(400, 'Comment must be text, 500 characters at most');
        }

        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT id, business_id, winner_id, status FROM bounties WHERE id = $1', [bountyId]
        );
        if (rows.length === 0) throw httpError(404, 'Bounty not found');

        const bounty = rows[0];
        if (bounty.status !== 'completed' || !bounty.winner_id) {
            throw httpError(409, 'You can only review a completed bounty');
        }

        let revieweeId;
        if (req.user.id === bounty.business_id) {
            revieweeId = bounty.winner_id;
        } else if (req.user.id === bounty.winner_id) {
            revieweeId = bounty.business_id;
        } else {
            throw httpError(403, 'Only the business or the winning worker can review this bounty');
        }

        let review;
        try {
            const result = await client.query(
                `INSERT INTO reviews (bounty_id, reviewer_id, reviewee_id, rating, comment)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, bounty_id, reviewer_id, reviewee_id, rating, comment, created_at`,
                [bountyId, req.user.id, revieweeId, rating, comment ? comment.trim() : null]
            );
            review = result.rows[0];
        } catch (err) {
            if (err.code === '23505') throw httpError(409, 'You have already reviewed this bounty');
            throw err;
        }

        // Reputation = average of all ratings the reviewee has received (1.0–5.0).
        await client.query(
            `UPDATE users
             SET reputation_score = (
                   SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE reviewee_id = $1
                 ),
                 updated_at = NOW()
             WHERE id = $1`, [revieweeId]
        );

        await client.query('COMMIT');
        res.status(201).json(review);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------ GET /api/reviews/user/:userId
router.get('/user/:userId', async(req, res, next) => {
    try {
        const userId = req.params.userId;
        if (!UUID_RE.test(userId)) throw httpError(400, 'Invalid user id');

        const summary = await pool.query(
            `SELECT COUNT(*)::int AS count,
                    COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS average
             FROM reviews WHERE reviewee_id = $1`, [userId]
        );
        const reviews = await pool.query(
            `SELECT r.rating, r.comment, r.created_at,
                    u.name AS reviewer_name, b.title AS bounty_title
             FROM reviews r
             JOIN users u ON u.id = r.reviewer_id
             JOIN bounties b ON b.id = r.bounty_id
             WHERE r.reviewee_id = $1
             ORDER BY r.created_at DESC
             LIMIT 50`, [userId]
        );

        res.json({
            count: summary.rows[0].count,
            average: summary.rows[0].average,
            reviews: reviews.rows
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
