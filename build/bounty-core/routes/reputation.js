// routes/reputation.js — public, per-industry proof-of-work indicators for a worker.
//
// GET /api/reputation/:workerId   (public)
// Returns aggregates only: no client names, no submission content, no account details.

const express = require('express');
const { pool } = require('../db');
const { httpError } = require('../middleware/auth');
const { summarise } = require('../services/reputation');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reputation for many workers at once. Returns a Map of worker id -> summary.
async function workersReputation(workerIds) {
    const result = new Map();
    if (workerIds.length === 0) return result;
    const { rows } = await pool.query(
        `SELECT s.worker_id, COALESCE(b.industry, b.category) AS industry, b.business_id, b.reward_amount AS reward,
                s.submitted_at, b.deadline,
                (s.revision_requested_at IS NOT NULL) AS revised,
                (SELECT r.rating FROM reviews r
                  WHERE r.bounty_id = b.id AND r.reviewee_id = s.worker_id AND r.reviewer_id = b.business_id
                  LIMIT 1) AS rating
         FROM submissions s
         JOIN bounties b ON b.id = s.bounty_id
         WHERE s.worker_id = ANY($1::uuid[]) AND s.status = 'approved'`, [workerIds]
    );
    const { rows: disputeRows } = await pool.query(
        `SELECT respondent_id AS worker_id, decision_outcome, status
         FROM disputes
         WHERE respondent_id = ANY($1::uuid[])`, [workerIds]
    );
    const grouped = new Map();
    for (const r of rows) {
        if (!grouped.has(r.worker_id)) grouped.set(r.worker_id, []);
        grouped.get(r.worker_id).push({ ...r, submitted_at: new Date(r.submitted_at) });
    }
    const disputesBy = new Map();
    for (const d of disputeRows) {
        if (!disputesBy.has(d.worker_id)) disputesBy.set(d.worker_id, []);
        disputesBy.get(d.worker_id).push(d);
    }
    for (const id of workerIds) result.set(id, summarise(grouped.get(id) || [], disputesBy.get(id) || []));
    return result;
}

async function workerReputation(workerId) {
    return (await workersReputation([workerId])).get(workerId);
}

router.get('/:workerId', async(req, res, next) => {
    try {
        if (!UUID_RE.test(req.params.workerId)) throw httpError(400, 'Invalid worker id');
        const { rows } = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'worker'", [req.params.workerId]);
        if (rows.length === 0) throw httpError(404, 'Worker not found');
        res.json(await workerReputation(req.params.workerId));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
module.exports.workerReputation = workerReputation;
module.exports.workersReputation = workersReputation;
