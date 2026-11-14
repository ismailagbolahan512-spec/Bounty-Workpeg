// routes/assessments.js — optional practical skill assessments.
//
// Catalogue (administrators):
//   GET   /api/assessments                 active assessments (any signed-in user); a worker also sees their status
//   POST  /api/assessments                 create an assessment with a scoring rubric
//   PATCH /api/assessments/:id             activate or deactivate
// Worker:
//   POST  /api/assessments/:id/start       begin an attempt (one open attempt at a time; cooldown after a non-verified result)
//   POST  /api/assessments/attempts/:id/submit  submit the work (https link optional)
//   GET   /api/assessments/mine            own attempts, including the reviewer's notes
// Reviewer (administrators):
//   GET   /api/assessments/review          submitted attempts awaiting a decision, with the advisory pre-check
//   POST  /api/assessments/attempts/:id/review  verified or not_verified, a score and notes
// Public:
//   GET   /api/assessments/verified/:workerId   verified assessments only (no scores, no submissions)
//
// The AI pre-check is advisory and is visible to reviewers only. Only a human decision verifies.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, requireAdmin, httpError } = require('../middleware/auth');
const { INDUSTRIES } = require('../services/classification');
const { validateAssessment, validateSubmission, prescore, COOLDOWN_DAYS } = require('../services/assessments');
const { notifyAfterCommit } = require('../services/execution');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_KEYS = [...new Set(['dev', 'design', 'content', 'marketing', 'other', ...INDUSTRIES.map((i) => i.id)])];

function checkId(id, label) {
    if (!UUID_RE.test(id)) throw httpError(400, `Invalid ${label} id`);
}

async function logEvent(db, attemptId, actorId, event, detail = {}) {
    await db.query(
        'INSERT INTO assessment_events (worker_assessment_id, actor_id, event, detail) VALUES ($1, $2, $3, $4)',
        [attemptId, actorId, event, JSON.stringify(detail)]
    );
}

// ------------------------------------------------ GET /api/assessments
router.get('/', authenticate, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, category, title, description, difficulty, instructions, submission_requirements, rubric, active
             FROM assessments WHERE active = TRUE ORDER BY category, title`
        );
        let mine = new Map();
        if (req.user.role === 'worker') {
            const attempts = await pool.query(
                `SELECT assessment_id, status, started_at, reviewed_at FROM worker_assessments
                 WHERE worker_id = $1 ORDER BY started_at DESC`, [req.user.id]
            );
            for (const a of attempts.rows) {
                if (!mine.has(a.assessment_id)) mine.set(a.assessment_id, a);
            }
        }
        res.json(rows.map((a) => {
            const last = mine.get(a.id);
            let cooldownUntil = null;
            if (last && last.status === 'not_verified' && last.reviewed_at) {
                const until = new Date(new Date(last.reviewed_at).getTime() + COOLDOWN_DAYS * 86400000);
                if (until > new Date()) cooldownUntil = until;
            }
            return { ...a, my_status: last ? last.status : null, cooldown_until: cooldownUntil };
        }));
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/assessments (administrator)
router.post('/', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const input = validateAssessment(req.body, CATEGORY_KEYS);
        const { rows } = await pool.query(
            `INSERT INTO assessments (category, title, description, difficulty, instructions, submission_requirements, rubric, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, active`,
            [input.category, input.title, input.description, input.difficulty, input.instructions,
                input.submission_requirements, JSON.stringify(input.rubric), req.user.id]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ PATCH /api/assessments/:id (administrator)
router.patch('/:id', authenticate, requireAdmin, async(req, res, next) => {
    try {
        checkId(req.params.id, 'assessment');
        if (typeof (req.body || {}).active !== 'boolean') throw httpError(400, 'active must be true or false');
        const { rows } = await pool.query('UPDATE assessments SET active = $2 WHERE id = $1 RETURNING id, active', [req.params.id, req.body.active]);
        if (rows.length === 0) throw httpError(404, 'Assessment not found');
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/assessments/:id/start (worker)
router.post('/:id/start', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        checkId(req.params.id, 'assessment');
        const { rows: a } = await pool.query('SELECT id, active FROM assessments WHERE id = $1', [req.params.id]);
        if (a.length === 0) throw httpError(404, 'Assessment not found');
        if (!a[0].active) throw httpError(409, 'This assessment is not available right now');

        const { rows: prior } = await pool.query(
            `SELECT status, reviewed_at FROM worker_assessments
             WHERE assessment_id = $1 AND worker_id = $2 ORDER BY started_at DESC LIMIT 1`, [req.params.id, req.user.id]
        );
        if (prior.length) {
            if (prior[0].status === 'verified') throw httpError(409, 'You have already been verified in this assessment');
            if (prior[0].status === 'in_progress' || prior[0].status === 'submitted') {
                throw httpError(409, 'You already have an open attempt at this assessment');
            }
            if (prior[0].status === 'not_verified' && prior[0].reviewed_at) {
                const until = new Date(new Date(prior[0].reviewed_at).getTime() + COOLDOWN_DAYS * 86400000);
                if (until > new Date()) {
                    throw httpError(409, `You can try again after ${until.toISOString().slice(0, 10)}`);
                }
            }
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `INSERT INTO worker_assessments (assessment_id, worker_id) VALUES ($1, $2) RETURNING id, status, started_at`,
                [req.params.id, req.user.id]
            );
            await logEvent(client, rows[0].id, req.user.id, 'started');
            await client.query('COMMIT');
            res.status(201).json(rows[0]);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err.code === '23505') throw httpError(409, 'You already have an open attempt at this assessment');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/assessments/attempts/:id/submit (worker)
router.post('/attempts/:id/submit', authenticate, requireRole('worker'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        checkId(req.params.id, 'attempt');
        const input = validateSubmission(req.body);
        const { rows } = await pool.query(
            `SELECT wa.id, wa.status, wa.worker_id, a.id AS assessment_id, a.title, a.rubric, a.category
             FROM worker_assessments wa JOIN assessments a ON a.id = wa.assessment_id WHERE wa.id = $1`, [req.params.id]
        );
        if (rows.length === 0) throw httpError(404, 'Attempt not found');
        if (rows[0].worker_id !== req.user.id) throw httpError(403, 'This attempt is not yours');
        if (rows[0].status !== 'in_progress') throw httpError(409, 'This attempt has already been submitted');

        // The pre-check runs outside any transaction, so no lock is held during the AI call.
        const assessment = { rubric: rows[0].rubric };
        const pre = await prescore(req.user.id, assessment, input.submissionText);

        await client.query('BEGIN');
        const locked = await client.query('SELECT status FROM worker_assessments WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (locked.rows[0].status !== 'in_progress') throw httpError(409, 'This attempt has already been submitted');
        await client.query(
            `UPDATE worker_assessments SET status = 'submitted', submission_text = $2, submission_link = $3,
                    ai_prescore = $4, submitted_at = NOW() WHERE id = $1`,
            [req.params.id, input.submissionText, input.link, JSON.stringify(pre)]
        );
        await logEvent(client, req.params.id, req.user.id, 'submitted', { ai_used: pre.ai_used });
        await client.query('COMMIT');
        res.json({ id: req.params.id, status: 'submitted' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ GET /api/assessments/mine (worker)
router.get('/mine', authenticate, requireRole('worker'), async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT wa.id, wa.assessment_id, wa.status, wa.started_at, wa.submitted_at, wa.reviewed_at, wa.reviewer_notes,
                    a.title, a.category, a.difficulty
             FROM worker_assessments wa JOIN assessments a ON a.id = wa.assessment_id
             WHERE wa.worker_id = $1 ORDER BY wa.started_at DESC LIMIT 100`, [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ GET /api/assessments/review (administrator)
router.get('/review', authenticate, requireAdmin, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT wa.id, wa.submission_text, wa.submission_link, wa.ai_prescore, wa.submitted_at,
                    a.title, a.category, a.difficulty, a.rubric, u.name AS worker_name
             FROM worker_assessments wa
             JOIN assessments a ON a.id = wa.assessment_id
             JOIN users u ON u.id = wa.worker_id
             WHERE wa.status = 'submitted' ORDER BY wa.submitted_at ASC LIMIT 100`
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /api/assessments/attempts/:id/review (administrator)
router.post('/attempts/:id/review', authenticate, requireAdmin, async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'attempt');
        const b = req.body || {};
        if (b.decision !== 'verified' && b.decision !== 'not_verified') throw httpError(400, 'Decision must be verified or not_verified');
        const score = Number(b.score);
        if (!Number.isInteger(score) || score < 0 || score > 100) throw httpError(400, 'Score must be a whole number from 0 to 100');
        const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
        if (notes.length < 10 || notes.length > 1000) throw httpError(400, 'Notes must be 10-1000 characters');

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT wa.id, wa.status, wa.worker_id, a.title FROM worker_assessments wa
             JOIN assessments a ON a.id = wa.assessment_id WHERE wa.id = $1 FOR UPDATE OF wa`, [req.params.id]
        );
        if (rows.length === 0) throw httpError(404, 'Attempt not found');
        if (rows[0].status !== 'submitted') throw httpError(409, 'Only a submitted attempt can be reviewed');
        await client.query(
            `UPDATE worker_assessments SET status = $2, score = $3, reviewer_notes = $4, reviewer_id = $5, reviewed_at = NOW()
             WHERE id = $1`,
            [req.params.id, b.decision, score, notes, req.user.id]
        );
        await logEvent(client, req.params.id, req.user.id, 'reviewed', { decision: b.decision });
        notices.push([rows[0].worker_id, `Your assessment "${rows[0].title}" has been reviewed.`, '#/assessments']);
        await client.query('COMMIT');
        notifyAfterCommit(notices);
        res.json({ id: req.params.id, status: b.decision });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ GET /api/assessments/verified/:workerId (public)
router.get('/verified/:workerId', async(req, res, next) => {
    try {
        checkId(req.params.workerId, 'worker');
        const { rows } = await pool.query(
            `SELECT a.title, a.category, a.difficulty, wa.reviewed_at
             FROM worker_assessments wa JOIN assessments a ON a.id = wa.assessment_id
             WHERE wa.worker_id = $1 AND wa.status = 'verified' ORDER BY wa.reviewed_at DESC`, [req.params.workerId]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
