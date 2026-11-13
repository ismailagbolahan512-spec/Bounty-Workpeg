// routes/portfolio.js — Proof-of-Ability: a worker chooses what to show and saves their own summary.
const express = require('express');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { pool } = require('../db');
const { allApproved, selfReported, saveSummary } = require('../services/portfolio');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/portfolio/me  -> the worker's approved work (with what is shown), their summary, self-reported details
router.get('/me', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT portfolio_summary FROM users WHERE id = $1', [req.user.id]);
        const approved = await allApproved(req.user.id);
        const self = await selfReported(req.user.id);
        res.json({
            summary: rows[0] && rows[0].portfolio_summary ? rows[0].portfolio_summary : '',
            approved,
            self_reported: self,
        });
    } catch (err) { next(err); }
});

// PUT /api/portfolio/me/summary  { summary }  -> saves the worker's own edited summary
router.put('/me/summary', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const text = (req.body || {}).summary;
        if (typeof text !== 'string') throw httpError(400, 'Summary must be text');
        const summary = await saveSummary(req.user.id, text);
        res.json({ summary });
    } catch (err) { next(err); }
});

// PATCH /api/portfolio/submissions/:id  { visible }  -> show or hide one approved submission
router.patch('/submissions/:id', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id)) throw httpError(400, 'Invalid submission id');
        const visible = (req.body || {}).visible;
        if (typeof visible !== 'boolean') throw httpError(400, 'Say whether to show this work (true or false)');

        const { rows } = await pool.query('SELECT worker_id, status FROM submissions WHERE id = $1', [id]);
        if (rows.length === 0) throw httpError(404, 'Submission not found');
        if (rows[0].worker_id !== req.user.id) throw httpError(403, 'This is not your submission');
        if (rows[0].status !== 'approved') throw httpError(409, 'Only approved work can be shown on your profile');

        const updated = await pool.query(
            'UPDATE submissions SET portfolio_visible = $1, updated_at = NOW() WHERE id = $2 RETURNING id, portfolio_visible',
            [visible, id]
        );
        res.json({ id: updated.rows[0].id, portfolio_visible: updated.rows[0].portfolio_visible === true });
    } catch (err) { next(err); }
});

module.exports = router;
