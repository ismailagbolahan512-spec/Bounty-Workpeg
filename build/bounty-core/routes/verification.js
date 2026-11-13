// routes/verification.js — advisory verification reports for submissions.
//
// POST /api/verification/submissions/:id   (business owner) creates a report and stores it.
// GET  /api/verification/submissions/:id   (business owner) lists reports, newest first.
// A report never changes a submission's status.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { runSubmissionCheck, loadFileText } = require('../services/checker');
const { buildVerification } = require('../services/verification');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOwnedSubmission(submissionId, businessId) {
    const { rows } = await pool.query(
        `SELECT s.id, s.title, s.description, s.github_link, s.notes_to_reviewer,
                b.id AS bounty_id, b.business_id, b.title AS bounty_title, b.description AS bounty_description,
                b.acceptance_criteria, b.execution_mode, b.requires_authorization
         FROM submissions s JOIN bounties b ON b.id = s.bounty_id
         WHERE s.id = $1`, [submissionId]
    );
    if (rows.length === 0) throw httpError(404, 'Submission not found');
    if (rows[0].business_id !== businessId) throw httpError(403, 'You do not own the bounty this submission belongs to');
    return rows[0];
}

// ------------------------------------------------ POST /api/verification/submissions/:id
router.post('/submissions/:id', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        if (!UUID_RE.test(req.params.id)) throw httpError(400, 'Invalid submission id');
        const row = await loadOwnedSubmission(req.params.id, req.user.id);

        const bounty = {
            title: row.bounty_title,
            description: row.bounty_description,
            requires_authorization: row.requires_authorization,
        };
        const files = await loadFileText(pool, row.id);
        const check = await runSubmissionCheck(req.user.id, row, row.acceptance_criteria || [], files);
        const report = buildVerification({
            submission: row, bounty, check, executionMode: row.execution_mode,
        });

        const { rows } = await pool.query(
            `INSERT INTO submission_verifications (submission_id, bounty_id, requested_by, execution_mode, outcome, report, ai_used)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, outcome, created_at`,
            [row.id, row.bounty_id, req.user.id, row.execution_mode, report.outcome, JSON.stringify(report), report.ai_used]
        );
        res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at, ...report });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ GET /api/verification/submissions/:id
router.get('/submissions/:id', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        if (!UUID_RE.test(req.params.id)) throw httpError(400, 'Invalid submission id');
        await loadOwnedSubmission(req.params.id, req.user.id);
        const { rows } = await pool.query(
            `SELECT id, outcome, report, ai_used, created_at
             FROM submission_verifications WHERE submission_id = $1
             ORDER BY created_at DESC LIMIT 20`, [req.params.id]
        );
        res.json(rows.map((r) => ({ id: r.id, created_at: r.created_at, outcome: r.outcome, ai_used: r.ai_used, ...r.report })));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
