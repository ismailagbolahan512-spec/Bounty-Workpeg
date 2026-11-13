// routes/ai.js — AI endpoints: Task Architect and Submission Checker (business accounts),
// Proof-of-Ability drafts (worker accounts).
const express = require('express');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { pool } = require('../db');
const { providerName, aiEnabled, featureOn, dailyLimit, usageToday, generateBountyDraft } = require('../services/ai');
const { runSubmissionCheck, loadFileText } = require('../services/checker');
const { generateDraft } = require('../services/portfolio');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-minute limit per account, on top of the daily cap. In memory: resets on restart.
const recentCalls = new Map();
function perMinuteLimit(req, res, next) {
    const max = Number(process.env.AI_RATE_PER_MINUTE) || 10;
    const now = Date.now();
    const key = req.user.id;
    const calls = (recentCalls.get(key) || []).filter((t) => now - t < 60000);
    if (calls.length >= max) {
        res.set('Retry-After', String(Math.ceil((60000 - (now - calls[0])) / 1000)));
        return next(httpError(429, 'Too many AI requests. Wait a minute and try again.'));
    }
    calls.push(now);
    recentCalls.set(key, calls);
    if (recentCalls.size > 5000) recentCalls.clear();
    next();
}

// GET /api/ai/status  -> whether drafting is set up, and today's remaining allowance
router.get('/status', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const modelConnected = aiEnabled();
        const used = modelConnected ? await usageToday(req.user.id) : 0;
        res.json({
            enabled: featureOn(),
            provider: providerName(),
            model_connected: modelConnected,
            limit: dailyLimit(),
            used,
            remaining: Math.max(0, dailyLimit() - used),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/ai/bounty-draft  { prompt }  -> a draft to review in the create form (saves nothing)
router.post('/bounty-draft', authenticate, requireRole('business'), perMinuteLimit, async(req, res, next) => {
    try {
        if (!req.user.email_verified_at) {
            throw httpError(403, 'Verify your email before using AI drafting');
        }
        const prompt = typeof (req.body || {}).prompt === 'string' ? req.body.prompt.trim() : '';
        if (prompt.length < 10) throw httpError(400, 'Describe the goal in at least 10 characters');
        if (prompt.length > 4000) throw httpError(400, 'Keep the description under 4000 characters');

        const result = await generateBountyDraft(req.user.id, prompt);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// Loads a submission for the bounty owner only. Anyone else gets 403 (or 404 if it does not exist).
async function ownedSubmission(submissionId, user) {
    const { rows } = await pool.query(
        `SELECT s.id, s.title, s.description, s.github_link, s.notes_to_reviewer,
                b.id AS bounty_id, b.business_id, b.acceptance_criteria
         FROM submissions s JOIN bounties b ON b.id = s.bounty_id
         WHERE s.id = $1`, [submissionId]
    );
    if (rows.length === 0) throw httpError(404, 'Submission not found');
    if (rows[0].business_id !== user.id) throw httpError(403, 'You do not own the bounty this submission belongs to');
    return rows[0];
}

// POST /api/ai/submissions/:id/check  -> runs the checks and saves the report. Changes nothing else.
router.post('/submissions/:id/check', authenticate, requireRole('business'), perMinuteLimit, async(req, res, next) => {
    try {
        if (!req.user.email_verified_at) throw httpError(403, 'Verify your email before running checks');
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');

        const sub = await ownedSubmission(submissionId, req.user);
        const files = await loadFileText(pool, sub.id);
        const report = await runSubmissionCheck(req.user.id, sub, sub.acceptance_criteria || [], files);
        const { rows } = await pool.query(
            `INSERT INTO submission_checks (submission_id, bounty_id, requested_by, results, ai_used)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
            [sub.id, sub.bounty_id, req.user.id, JSON.stringify(report), report.ai_used]
        );
        res.status(201).json({ id: rows[0].id, submission_id: sub.id, ...report, created_at: rows[0].created_at });
    } catch (err) {
        next(err);
    }
});

// GET /api/ai/submissions/:id/check  -> the latest saved report (owner only)
router.get('/submissions/:id/check', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const submissionId = req.params.id;
        if (!UUID_RE.test(submissionId)) throw httpError(400, 'Invalid submission id');
        await ownedSubmission(submissionId, req.user);
        const { rows } = await pool.query(
            `SELECT id, results, ai_used, created_at FROM submission_checks
             WHERE submission_id = $1 ORDER BY created_at DESC LIMIT 1`, [submissionId]
        );
        if (rows.length === 0) throw httpError(404, 'No checks have been run on this submission yet');
        res.json({ id: rows[0].id, submission_id: submissionId, ...rows[0].results, ai_used: rows[0].ai_used, created_at: rows[0].created_at });
    } catch (err) {
        next(err);
    }
});

// POST /api/ai/proof-of-ability/generate  -> a draft for the worker to review and edit. Saves nothing.
router.post('/proof-of-ability/generate', authenticate, requireRole('worker'), perMinuteLimit, async(req, res, next) => {
    try {
        if (!req.user.email_verified_at) throw httpError(403, 'Verify your email before drafting a summary');
        const result = await generateDraft(req.user.id);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
