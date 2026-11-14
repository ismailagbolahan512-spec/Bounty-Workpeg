// routes/projects.js — multi-task projects (business only to create).
//
// POST /api/projects                       create a project from a plan (verified business)
// POST /api/projects/plan                  ask the AI provider for a DRAFT plan (verified business)
// POST /api/projects/plan/:draftId/approve turn a draft into a project (owner; idempotent)
// GET  /api/projects/mine                  the caller's projects (business)
// GET  /api/projects/:id                   a project and its tasks (public)
// GET  /api/projects/:id/progress          task states, bottlenecks, gaps (owner or a worker on it)
//
// Single-task bounties stay on POST /api/bounties. A project's tasks are ordinary bounties
// with project_id set, so submissions, approval and payments work the same way.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { validatePlan, requestAiPlan } = require('../services/plan');
const { rulesPlan, modelPlan, plannerFor, PLACEHOLDER_REWARD } = require('../services/planner');
const { computeProgress } = require('../services/progress');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_PROMPT_MAX = 1000;

// Inserts a project, its tasks and their dependencies. Runs inside the caller's transaction.
// options.team: every task becomes Team / Parallel Execution (one worker per component).
async function insertProjectFromPlan(client, businessId, plan, options = {}) {
    const projectResult = await client.query(
        `INSERT INTO projects (business_id, title, description, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, title, description, created_at`, [businessId, plan.title, plan.description]
    );
    const project = projectResult.rows[0];

    const taskIds = [];
    for (const t of plan.tasks) {
        const r = await client.query(
            `INSERT INTO bounties
               (business_id, project_id, title, description, category, difficulty, reward_amount, deadline,
                submission_type, acceptance_criteria, execution_mode, max_workers, winner_limit, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, 'open', NOW(), NOW())
             RETURNING id`, [businessId, project.id, t.title, t.description, t.category, t.difficulty,
                t.reward_amount, t.deadline, t.submission_type, JSON.stringify(t.acceptance_criteria),
                options.team ? 'team' : 'competitive', options.team ? 1 : 3,
            ]
        );
        taskIds.push(r.rows[0].id);
    }

    for (let i = 0; i < plan.tasks.length; i++) {
        for (const j of plan.tasks[i].depends_on) {
            await client.query(
                `INSERT INTO task_dependencies (bounty_id, depends_on_id) VALUES ($1, $2)`, [taskIds[i], taskIds[j]]
            );
        }
    }
    return { project, taskIds };
}

// ------------------------------------------- POST /api/projects (manual plan)
router.post('/', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const plan = validatePlan(req.body || {});

        await client.query('BEGIN');
        const team = (req.body || {}).execution_mode === 'team';
        if ((req.body || {}).execution_mode !== undefined && !['team', 'competitive'].includes((req.body || {}).execution_mode)) {
            throw httpError(400, 'Project execution mode must be team or competitive');
        }
        const { project, taskIds } = await insertProjectFromPlan(client, req.user.id, plan, { team });
        await client.query('COMMIT');
        res.status(201).json({ id: project.id, title: project.title, task_ids: taskIds, execution_mode: team ? 'team' : 'competitive' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------- POST /api/projects/plan (AI draft)
router.post('/plan', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const prompt = typeof (req.body || {}).prompt === 'string' ? req.body.prompt.trim() : '';
        if (prompt.length < 10 || prompt.length > PLAN_PROMPT_MAX) {
            throw httpError(400, `Describe the project in 10-${PLAN_PROMPT_MAX} characters`);
        }

        // Engine: the legacy URL planner if configured, else a model, else our rules planner.
        // Nothing is stored until the business approves.
        const engine = plannerFor();
        let plan;
        if (engine === 'legacy') plan = await requestAiPlan(prompt);
        else if (engine === 'model') plan = await modelPlan(req.user.id, prompt);
        else plan = validatePlan(rulesPlan(prompt));

        const { rows } = await pool.query(
            `INSERT INTO ai_plan_drafts (business_id, prompt, plan, status, created_at, updated_at)
             VALUES ($1, $2, $3, 'draft', NOW(), NOW())
             RETURNING id, status, created_at`, [req.user.id, prompt, JSON.stringify(plan)]
        );
        res.status(201).json({ id: rows[0].id, status: rows[0].status, source: engine === 'legacy' ? 'legacy' : engine === 'model' ? 'ai' : 'rules', plan });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------- POST /api/projects/plan/:draftId/approve
// Body may include an edited { plan }; it is validated again before anything is written.
// Approving the same draft twice returns the project from the first approval.
router.post('/plan/:draftId/approve', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const draftId = req.params.draftId;
        if (!UUID_RE.test(draftId)) throw httpError(400, 'Invalid draft id');

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, business_id, plan, status, project_id FROM ai_plan_drafts WHERE id = $1 FOR UPDATE`, [draftId]
        );
        if (rows.length === 0 || rows[0].business_id !== req.user.id) throw httpError(404, 'Draft not found');
        const draft = rows[0];

        if (draft.status === 'approved') {
            await client.query('COMMIT');
            return res.json({ id: draft.project_id, already_approved: true });
        }

        const edited = req.body && req.body.plan !== undefined;
        const plan = validatePlan(edited ? req.body.plan : draft.plan);

        // A placeholder reward is not a real price. Publishing one needs the business to confirm it.
        const placeholders = plan.tasks.filter((t) => Number(t.reward_amount) === Number(PLACEHOLDER_REWARD)).length;
        if (placeholders > 0 && (req.body || {}).confirm_rewards !== true) {
            throw httpError(409, `${placeholders} task${placeholders === 1 ? '' : 's'} still use the placeholder reward ${PLACEHOLDER_REWARD}. Set each reward, or confirm them, before publishing.`);
        }

        const { project, taskIds } = await insertProjectFromPlan(client, req.user.id, plan);
        await client.query(
            `UPDATE ai_plan_drafts SET status = 'approved', project_id = $1, plan = $2, updated_at = NOW() WHERE id = $3`, [project.id, JSON.stringify(plan), draftId]
        );
        await client.query('COMMIT');
        res.status(201).json({ id: project.id, title: project.title, task_ids: taskIds, already_approved: false });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------- GET /api/projects/mine
// GET /api/projects/:id/progress — computed from real task, submission and dependency data.
// Visible to the project's business and to workers who have submitted on one of its tasks.
router.get('/:id/progress', authenticate, async(req, res, next) => {
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id)) throw httpError(400, 'Invalid project id');

        const p = await pool.query('SELECT id, business_id FROM projects WHERE id = $1', [id]);
        if (p.rows.length === 0) throw httpError(404, 'Project not found');

        const tasks = await pool.query(
            `SELECT id, title, status, deadline FROM bounties WHERE project_id = $1 ORDER BY created_at ASC, id ASC`, [id]
        );
        const taskIds = tasks.rows.map((t) => t.id);
        const isOwner = p.rows[0].business_id === req.user.id;
        if (!isOwner) {
            const mine = await pool.query(
                `SELECT 1 FROM submissions s JOIN bounties b ON b.id = s.bounty_id
                 WHERE b.project_id = $1 AND s.worker_id = $2 LIMIT 1`, [id, req.user.id]
            );
            if (mine.rows.length === 0) throw httpError(403, 'Only the project owner and workers on this project can see its progress');
        }

        const deps = taskIds.length ? await pool.query(
            `SELECT bounty_id, depends_on_id FROM task_dependencies WHERE bounty_id = ANY($1::uuid[])`, [taskIds]
        ) : { rows: [] };
        const subs = taskIds.length ? await pool.query(
            `SELECT bounty_id, status, COUNT(*)::int AS n FROM submissions WHERE bounty_id = ANY($1::uuid[]) GROUP BY bounty_id, status`, [taskIds]
        ) : { rows: [] };

        const subCounts = new Map();
        for (const r of subs.rows) {
            if (!subCounts.has(r.bounty_id)) subCounts.set(r.bounty_id, {});
            subCounts.get(r.bounty_id)[r.status] = r.n;
        }
        res.json({ project_id: id, ...computeProgress(tasks.rows, deps.rows.map((d) => ({ bounty_id: d.bounty_id, depends_on_id: d.depends_on_id })), subCounts) });
    } catch (err) {
        next(err);
    }
});

router.get('/mine', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT p.id, p.title, p.created_at,
                    COUNT(b.id)::int AS task_count,
                    COUNT(b.id) FILTER (WHERE b.status = 'completed')::int AS completed_count
             FROM projects p
             LEFT JOIN bounties b ON b.project_id = p.id
             WHERE p.business_id = $1
             GROUP BY p.id
             ORDER BY p.created_at DESC`, [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------- GET /api/projects/:id (public)
router.get('/:id', async(req, res, next) => {
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id)) throw httpError(400, 'Invalid project id');

        const p = await pool.query(
            `SELECT p.id, p.title, p.description, p.created_at, u.name AS business_name
             FROM projects p JOIN users u ON u.id = p.business_id WHERE p.id = $1`, [id]
        );
        if (p.rows.length === 0) throw httpError(404, 'Project not found');

        const tasks = await pool.query(
            `SELECT b.id, b.title, b.category, b.difficulty, b.reward_amount, b.deadline, b.status,
                    b.submission_type, b.acceptance_criteria,
                    COALESCE(
                      (SELECT json_agg(json_build_object('id', d.id, 'title', d.title, 'status', d.status))
                       FROM task_dependencies td JOIN bounties d ON d.id = td.depends_on_id
                       WHERE td.bounty_id = b.id), '[]'::json) AS depends_on
             FROM bounties b
             WHERE b.project_id = $1
             ORDER BY b.created_at ASC, b.id ASC`, [id]
        );

        const taskRows = tasks.rows.map((t) => ({
            ...t,
            blocked: t.depends_on.some((d) => d.status !== 'completed'),
        }));
        res.json({ ...p.rows[0], tasks: taskRows });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
