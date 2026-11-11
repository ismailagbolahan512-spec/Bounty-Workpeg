// routes/budget.js — budget planning estimates for a business creating a task.
//
// POST /api/budget/estimate (business). Returns a planning estimate with its factors and
// assumptions. Nothing is saved. The business sets the final budget.

const express = require('express');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { estimateBudget, BASE_HOURS, DIFFICULTY } = require('../services/budget');

const router = express.Router();
const MODES = ['first_valid', 'competitive', 'team', 'independent'];

function intIn(value, label, min, max, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${label} must be a whole number from ${min} to ${max}`);
    return n;
}

router.post('/estimate', authenticate, requireRole('business'), (req, res, next) => {
    try {
        const b = req.body || {};
        const description = typeof b.description === 'string' ? b.description : '';
        if (description.length > 10000) throw httpError(400, 'Description is too long');
        const deliverables = typeof b.deliverables === 'string' ? b.deliverables : '';
        if (deliverables.length > 2000) throw httpError(400, 'Deliverables are too long');
        if (b.reward !== undefined && b.reward !== null && b.reward !== '') {
            const r = Number(b.reward);
            if (!Number.isFinite(r) || r < 0 || r > 1000000) throw httpError(400, 'Reward must be between 0 and 1,000,000');
        }
        let deadlineDays = null;
        if (b.deadline) {
            const d = new Date(b.deadline);
            if (Number.isNaN(d.getTime())) throw httpError(400, 'Deadline is not a valid date');
            deadlineDays = Math.ceil((d.getTime() - Date.now()) / 86400000);
        }
        if (b.execution_mode !== undefined && !MODES.includes(b.execution_mode)) throw httpError(400, 'Unknown execution mode');
        const result = estimateBudget({
            category: typeof b.category === 'string' && BASE_HOURS[b.category] ? b.category : 'other',
            difficulty: typeof b.difficulty === 'string' && DIFFICULTY[b.difficulty] ? b.difficulty : 'medium',
            description,
            deliverables,
            criteria_count: intIn(b.criteria_count, 'Acceptance criteria count', 0, 20, 0),
            revision_rounds: intIn(b.revision_rounds, 'Revision rounds', 0, 5, 0),
            workers: intIn(b.workers, 'Workers', 1, 50, 1),
            requires_authorization: b.requires_authorization === true,
            execution_mode: b.execution_mode || 'competitive',
            deadline_days: deadlineDays,
            reward: b.reward,
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
