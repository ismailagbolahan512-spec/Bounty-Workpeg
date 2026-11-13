// routes/peg.js — the Workpeg integration surface. Every route here takes an integration token
// (Bearer, bnt_wp_...) and checks its scope and the owner's current role on every request.
// Design: docs/workpeg-identity-design.md. Nothing here approves work, changes roles, or touches money.
//   GET  /api/peg/me                      the token's owner and scopes
//   GET  /api/peg/bounties                open, public, non-regional tasks (bounties:read)
//   POST /api/peg/confirmations           ask the user to approve a sensitive action

const express = require('express');
const { pool } = require('../db');
const { authenticateIntegration, requireScope, httpError } = require('../middleware/auth');
const { logAudit } = require('../services/protection');
const tokens = require('../services/integration-tokens');

const router = express.Router();

router.use(authenticateIntegration);

router.get('/me', (req, res) => {
    res.json({
        user: { name: req.user.name, role: req.user.role },
        scopes: req.integration.scopes,
    });
});

// Only tasks that are open, public, not confidential and not limited to a region. Region-limited
// and confidential tasks stay out until the Peg can check the user's region and NDA (rules section 3).
router.get('/bounties', requireScope('bounties:read'), async(req, res, next) => {
    try {
        const parsed = parseInt(req.query.limit, 10);
        const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 20) : 10;
        const category = typeof req.query.category === 'string' && req.query.category.length > 0 && req.query.category.length <= 100
            ? req.query.category : null;
        const { rows } = await pool.query(
            `SELECT id, title, category, difficulty, reward_amount, deadline, submission_type, status
             FROM bounties
             WHERE status = 'open' AND confidential = FALSE AND cardinality(regions) = 0
               AND deadline > NOW() AND ($1::text IS NULL OR category = $1)
             ORDER BY created_at DESC LIMIT $2`,
            [category, limit]
        );
        res.json({ bounties: rows.map((r) => ({ ...r, reward_amount: Number(r.reward_amount) })) });
    } catch (err) { next(err); }
});

// Asks for the user's approval of one sensitive action. The action itself does not run here:
// it runs only after approval, and only with the exact payload approved (design section 3.4).
router.post('/confirmations', async(req, res, next) => {
    try {
        const body = req.body || {};
        const action = body.action;
        if (!tokens.SENSITIVE_SCOPES.includes(action)) {
            throw httpError(400, 'This action does not need approval, or is not supported');
        }
        if (!req.integration.scopes.includes(action)) {
            throw httpError(403, `This token does not allow ${action}`);
        }
        if (!tokens.roleAllows(req.user.role, action)) {
            throw httpError(403, `Your role cannot use ${action}`);
        }
        const payload = body.payload;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            throw httpError(400, 'Send the action details as an object in payload');
        }
        const conf = await tokens.requestConfirmation({ tokenId: req.integration.tokenId, action, payload });
        await logAudit(pool.query.bind(pool), req.user.id, 'integration.confirmation_requested', 'integration_confirmation', conf.id, {
            action,
        });
        res.status(201).json({
            id: conf.id, action: conf.action, expires_at: conf.expires_at, status: 'awaiting_user_approval',
        });
    } catch (err) { next(err); }
});

module.exports = router;
