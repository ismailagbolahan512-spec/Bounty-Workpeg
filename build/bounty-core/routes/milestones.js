// routes/milestones.js — milestone-based work inside a project.
//
// Business (project owner):
//   POST  /api/milestones/project/:projectId   create a milestone (optionally assign + depend)
//   GET   /api/milestones/project/:projectId/workers  workers who can be assigned
//   GET   /api/milestones/project/:projectId   all milestones in the project
//   PATCH /api/milestones/project/:projectId/budget  set or clear the project budget cap
//   PATCH /api/milestones/:id                  edit while planned (fields, worker, dependencies)
//   POST  /api/milestones/:id/request-revision submitted -> revision_requested
//   POST  /api/milestones/:id/approve          submitted -> approved, creates payment eligibility
// Assigned worker:
//   GET   /api/milestones/project/:projectId   lists only milestones assigned to them
//   POST  /api/milestones/:id/start            planned -> in_progress, once dependencies are approved
//   POST  /api/milestones/:id/submit           in_progress / revision_requested -> submitted
// Owner or assigned worker:
//   GET   /api/milestones/:id/events           audit trail
//
// Lock order: a project row first, then milestone rows. Dependency edits lock the project,
// so two edits cannot create a cycle at the same time.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { parseMilestone, wouldCreateCycle, assertWithinProjectBudget, projectBudgetView } = require('../services/milestones');
const { notifyAfterCommit } = require('../services/execution');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkId(id, label) {
    if (!UUID_RE.test(id)) throw httpError(400, `Invalid ${label} id`);
}

async function logEvent(db, milestoneId, actorId, event, detail = {}) {
    await db.query(
        'INSERT INTO milestone_events (milestone_id, actor_id, event, detail) VALUES ($1, $2, $3, $4)',
        [milestoneId, actorId, event, JSON.stringify(detail)]
    );
}

// Loads a milestone with its project's owner, locking the milestone row when asked.
async function loadMilestone(client, id, lock) {
    const { rows } = await client.query(
        `SELECT m.*, p.business_id, p.title AS project_title
         FROM milestones m JOIN projects p ON p.id = m.project_id
         WHERE m.id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`, [id]
    );
    if (rows.length === 0) throw httpError(404, 'Milestone not found');
    return rows[0];
}

async function dependenciesOf(db, milestoneIds) {
    if (milestoneIds.length === 0) return new Map();
    const { rows } = await db.query(
        `SELECT d.milestone_id, d.depends_on_id, dep.title, dep.status
         FROM milestone_dependencies d JOIN milestones dep ON dep.id = d.depends_on_id
         WHERE d.milestone_id = ANY($1::uuid[])`, [milestoneIds]
    );
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.milestone_id)) map.set(r.milestone_id, []);
        map.get(r.milestone_id).push({ id: r.depends_on_id, title: r.title, status: r.status });
    }
    return map;
}

function view(m, deps) {
    const dependsOn = deps || [];
    const waiting = dependsOn.filter((d) => d.status !== 'approved');
    return {
        id: m.id,
        project_id: m.project_id,
        position: m.position,
        title: m.title,
        description: m.description,
        deliverables: m.deliverables,
        acceptance_criteria: m.acceptance_criteria,
        budget: Number(m.budget),
        deadline: m.deadline,
        worker_id: m.worker_id,
        status: m.status,
        submission_text: m.submission_text,
        submission_link: m.submission_link,
        submitted_at: m.submitted_at,
        revision_notes: m.revision_notes,
        approved_at: m.approved_at,
        depends_on: dependsOn,
        waiting_on: waiting.map((d) => d.title),
        can_start: m.status === 'planned' && waiting.length === 0,
    };
}

async function assertWorker(db, workerId) {
    if (!workerId) return;
    const { rows } = await db.query("SELECT id FROM users WHERE id = $1 AND role = 'worker'", [workerId]);
    if (rows.length === 0) throw httpError(400, 'The assigned user must be a worker');
}

async function assertDependenciesInProject(db, projectId, ids) {
    if (ids.length === 0) return;
    ids.forEach((id) => checkId(id, 'dependency'));
    const { rows } = await db.query('SELECT id FROM milestones WHERE project_id = $1 AND id = ANY($2::uuid[])', [projectId, ids]);
    if (rows.length !== ids.length) throw httpError(400, 'Dependencies must be milestones in the same project');
}

// Sum of milestone budgets in a project, optionally leaving one milestone out.
async function allocatedBudget(db, projectId, excludeMilestoneId) {
    const { rows } = await db.query(
        `SELECT COALESCE(SUM(budget), 0) AS allocated FROM milestones
         WHERE project_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`, [projectId, excludeMilestoneId]
    );
    return Number(rows[0].allocated);
}

async function projectEdges(db, projectId) {
    const { rows } = await db.query(
        `SELECT d.milestone_id, d.depends_on_id FROM milestone_dependencies d
         JOIN milestones m ON m.id = d.milestone_id WHERE m.project_id = $1`, [projectId]
    );
    const edges = new Map();
    for (const r of rows) {
        if (!edges.has(r.milestone_id)) edges.set(r.milestone_id, []);
        edges.get(r.milestone_id).push(r.depends_on_id);
    }
    return edges;
}

// ------------------------------------------------ POST /api/milestones/project/:projectId
// ------------------------------------------------ PATCH /api/milestones/project/:projectId/budget (owner)
// Sets the project's total budget cap. null clears it. The cap cannot be set below what the
// milestones already allocate, so existing work is never put over budget by this change.
router.patch('/project/:projectId/budget', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        checkId(req.params.projectId, 'project');
        const raw = req.body ? req.body.total_budget : undefined;
        if (raw === undefined) throw httpError(400, 'total_budget is required (a number, or null to clear the cap)');
        let total = null;
        if (raw !== null) {
            total = Number(raw);
            if (raw === '' || !Number.isFinite(total) || total < 0 || total > 10000000) {
                throw httpError(400, 'Project budget must be between 0 and 10,000,000, or null');
            }
            total = Math.round(total * 100) / 100;
        }

        await client.query('BEGIN');
        const project = await client.query('SELECT id, business_id, total_budget FROM projects WHERE id = $1 FOR UPDATE', [req.params.projectId]);
        if (project.rows.length === 0) throw httpError(404, 'Project not found');
        if (project.rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own this project');

        const allocated = await allocatedBudget(client, req.params.projectId, null);
        if (total !== null && total < allocated) {
            throw httpError(409, `Milestones already allocate ${allocated.toFixed(2)}, so the project budget cannot be set below that`);
        }
        const { rows } = await client.query('UPDATE projects SET total_budget = $2, updated_at = NOW() WHERE id = $1 RETURNING total_budget', [req.params.projectId, total]);
        await client.query('COMMIT');
        res.json(projectBudgetView(rows[0].total_budget, allocated));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

router.post('/project/:projectId', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.projectId, 'project');
        const input = parseMilestone(req.body);

        await client.query('BEGIN');
        const project = await client.query('SELECT id, business_id, title, total_budget FROM projects WHERE id = $1 FOR UPDATE', [req.params.projectId]);
        if (project.rows.length === 0) throw httpError(404, 'Project not found');
        if (project.rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own this project');

        await assertWorker(client, input.worker_id);
        await assertDependenciesInProject(client, req.params.projectId, input.depends_on);
        const allocated = await allocatedBudget(client, req.params.projectId, null);
        assertWithinProjectBudget({ totalBudget: project.rows[0].total_budget, allocatedElsewhere: allocated, budget: input.budget });

        const pos = await client.query('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM milestones WHERE project_id = $1', [req.params.projectId]);
        const { rows } = await client.query(
            `INSERT INTO milestones (project_id, position, title, description, deliverables, acceptance_criteria, budget, deadline, worker_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [req.params.projectId, pos.rows[0].next, input.title, input.description, input.deliverables,
                input.acceptance_criteria, input.budget, input.deadline, input.worker_id]
        );
        const m = rows[0];
        for (const depId of input.depends_on) {
            await client.query('INSERT INTO milestone_dependencies (milestone_id, depends_on_id) VALUES ($1, $2)', [m.id, depId]);
        }
        await logEvent(client, m.id, req.user.id, 'created', { depends_on: input.depends_on.length });
        if (input.worker_id) {
            await logEvent(client, m.id, req.user.id, 'assigned', { worker_id: input.worker_id });
            notices.push([input.worker_id, `You have been assigned "${m.title}" in "${project.rows[0].title}".`, '#/dashboard']);
        }
        await client.query('COMMIT');
        notifyAfterCommit(notices);

        const deps = await dependenciesOf(pool, [m.id]);
        res.status(201).json(view(m, deps.get(m.id)));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ GET /api/milestones/project/:projectId
router.get('/project/:projectId', authenticate, async(req, res, next) => {
    try {
        checkId(req.params.projectId, 'project');
        const { rows: p } = await pool.query('SELECT id, business_id, title, total_budget FROM projects WHERE id = $1', [req.params.projectId]);
        if (p.length === 0) throw httpError(404, 'Project not found');

        const isOwner = p[0].business_id === req.user.id;
        if (!isOwner && req.user.role !== 'worker') throw httpError(403, 'You do not have access to this project');

        const { rows } = await pool.query(
            `SELECT * FROM milestones WHERE project_id = $1 ${isOwner ? '' : 'AND worker_id = $2'} ORDER BY position`,
            isOwner ? [req.params.projectId] : [req.params.projectId, req.user.id]
        );
        const deps = await dependenciesOf(pool, rows.map((r) => r.id));
        res.json({
            project_id: p[0].id,
            project_title: p[0].title,
            role: isOwner ? 'owner' : 'worker',
            milestones: rows.map((m) => view(m, deps.get(m.id))),
            ...(isOwner ? { project_budget: projectBudgetView(p[0].total_budget, rows.reduce((s, m) => s + Number(m.budget), 0)) } : {}),
        });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ GET /api/milestones/project/:projectId/workers (owner)
// Workers who have taken or submitted to any task in the project. Only these can be assigned.
router.get('/project/:projectId/workers', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        checkId(req.params.projectId, 'project');
        const { rows: p } = await pool.query('SELECT business_id FROM projects WHERE id = $1', [req.params.projectId]);
        if (p.length === 0) throw httpError(404, 'Project not found');
        if (p[0].business_id !== req.user.id) throw httpError(403, 'You do not own this project');
        const { rows } = await pool.query(
            `SELECT u.id, u.name FROM users u
             WHERE u.role = 'worker' AND u.id IN (
               SELECT bp.worker_id FROM bounty_participants bp JOIN bounties b ON b.id = bp.bounty_id WHERE b.project_id = $1
               UNION
               SELECT s.worker_id FROM submissions s JOIN bounties b ON b.id = s.bounty_id WHERE b.project_id = $1)
             ORDER BY u.name`, [req.params.projectId]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ PATCH /api/milestones/:id (owner, while planned)
router.patch('/:id', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'milestone');
        const current = await loadMilestone(pool, req.params.id, false);
        if (current.business_id !== req.user.id) throw httpError(403, 'You do not own this project');

        await client.query('BEGIN');
        // Lock the project first, so dependency edits in this project are serialised.
        const project = await client.query('SELECT id, total_budget FROM projects WHERE id = $1 FOR UPDATE', [current.project_id]);
        const m = await loadMilestone(client, req.params.id, true);
        if (m.status !== 'planned') throw httpError(409, 'Only planned milestones can be edited');

        const body = req.body || {};
        const currentDeps = (await dependenciesOf(client, [m.id])).get(m.id) || [];
        const merged = {
            title: body.title ?? m.title,
            description: body.description ?? m.description,
            deliverables: body.deliverables ?? m.deliverables,
            acceptance_criteria: body.acceptance_criteria ?? m.acceptance_criteria,
            budget: body.budget ?? Number(m.budget),
            deadline: body.deadline !== undefined ? body.deadline : m.deadline,
            worker_id: body.worker_id !== undefined ? body.worker_id : m.worker_id,
            depends_on: body.depends_on !== undefined ? body.depends_on : currentDeps.map((d) => d.id),
        };
        const input = parseMilestone(merged);

        await assertWorker(client, input.worker_id);
        await assertDependenciesInProject(client, m.project_id, input.depends_on);
        const allocatedElsewhere = await allocatedBudget(client, m.project_id, m.id);
        assertWithinProjectBudget({ totalBudget: project.rows[0].total_budget, allocatedElsewhere, budget: input.budget });
        if (input.depends_on.includes(m.id)) throw httpError(400, 'A milestone cannot depend on itself');
        const edges = await projectEdges(client, m.project_id);
        edges.set(m.id, []);
        if (wouldCreateCycle(m.id, input.depends_on, edges)) throw httpError(400, 'These dependencies would create a loop');

        const { rows } = await client.query(
            `UPDATE milestones SET title = $2, description = $3, deliverables = $4, acceptance_criteria = $5,
                    budget = $6, deadline = $7, worker_id = $8, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [m.id, input.title, input.description, input.deliverables, input.acceptance_criteria,
                input.budget, input.deadline, input.worker_id]
        );
        await client.query('DELETE FROM milestone_dependencies WHERE milestone_id = $1', [m.id]);
        for (const depId of input.depends_on) {
            await client.query('INSERT INTO milestone_dependencies (milestone_id, depends_on_id) VALUES ($1, $2)', [m.id, depId]);
        }
        await logEvent(client, m.id, req.user.id, 'edited', { fields: Object.keys(body) });
        if (input.worker_id && input.worker_id !== m.worker_id) {
            await logEvent(client, m.id, req.user.id, 'assigned', { worker_id: input.worker_id });
            notices.push([input.worker_id, `You have been assigned "${rows[0].title}".`, '#/dashboard']);
        }
        await client.query('COMMIT');
        notifyAfterCommit(notices);

        const deps = await dependenciesOf(pool, [m.id]);
        res.json(view(rows[0], deps.get(m.id)));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/milestones/:id/start (assigned worker)
router.post('/:id/start', authenticate, requireRole('worker'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        checkId(req.params.id, 'milestone');
        await client.query('BEGIN');
        const m = await loadMilestone(client, req.params.id, true);
        if (m.worker_id !== req.user.id) throw httpError(403, 'This milestone is not assigned to you');
        if (m.status !== 'planned') throw httpError(409, 'This milestone has already started');

        const deps = (await dependenciesOf(client, [m.id])).get(m.id) || [];
        const waiting = deps.filter((d) => d.status !== 'approved');
        if (waiting.length > 0) {
            throw httpError(409, `Waiting for approval of: ${waiting.map((d) => d.title).join(', ')}`);
        }

        const { rows } = await client.query(
            "UPDATE milestones SET status = 'in_progress', updated_at = NOW() WHERE id = $1 RETURNING *", [m.id]
        );
        await logEvent(client, m.id, req.user.id, 'started', {});
        await client.query('COMMIT');
        res.json(view(rows[0], deps));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/milestones/:id/submit (assigned worker)
router.post('/:id/submit', authenticate, requireRole('worker'), async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'milestone');
        const body = req.body || {};
        const text = typeof body.submission_text === 'string' ? body.submission_text.trim() : '';
        if (text.length < 20 || text.length > 5000) throw httpError(400, 'Describe the work in 20-5000 characters');
        let link = null;
        if (body.submission_link) {
            link = String(body.submission_link).trim();
            if (link.length > 255 || !/^https:\/\//i.test(link)) throw httpError(400, 'The link must be an https address, 255 characters at most');
        }

        await client.query('BEGIN');
        const m = await loadMilestone(client, req.params.id, true);
        if (m.worker_id !== req.user.id) throw httpError(403, 'This milestone is not assigned to you');
        if (!['in_progress', 'revision_requested'].includes(m.status)) {
            throw httpError(409, 'This milestone is not open for a submission');
        }

        const late = Boolean(m.deadline) && new Date() > new Date(m.deadline);
        const { rows } = await client.query(
            `UPDATE milestones SET status = 'submitted', submission_text = $2, submission_link = $3,
                    submitted_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
            [m.id, text, link]
        );
        await logEvent(client, m.id, req.user.id, 'submitted', { late, revision: m.status === 'revision_requested' });
        notices.push([m.business_id, `"${m.title}" was submitted for review.`, '#/dashboard']);
        await client.query('COMMIT');
        notifyAfterCommit(notices);

        res.json(view(rows[0], (await dependenciesOf(pool, [m.id])).get(m.id)));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/milestones/:id/request-revision (owner)
router.post('/:id/request-revision', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'milestone');
        const notes = typeof (req.body || {}).notes === 'string' ? req.body.notes.trim() : '';
        if (notes.length < 10 || notes.length > 1000) throw httpError(400, 'Explain the changes in 10-1000 characters');

        await client.query('BEGIN');
        const m = await loadMilestone(client, req.params.id, true);
        if (m.business_id !== req.user.id) throw httpError(403, 'You do not own this project');
        if (m.status !== 'submitted') throw httpError(409, 'Only a submitted milestone can get a revision request');

        const { rows } = await client.query(
            "UPDATE milestones SET status = 'revision_requested', revision_notes = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
            [m.id, notes]
        );
        await logEvent(client, m.id, req.user.id, 'revision_requested', { length: notes.length });
        if (m.worker_id) notices.push([m.worker_id, `Changes requested for "${m.title}".`, '#/dashboard']);
        await client.query('COMMIT');
        notifyAfterCommit(notices);

        res.json(view(rows[0], (await dependenciesOf(pool, [m.id])).get(m.id)));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ POST /api/milestones/:id/approve (owner)
router.post('/:id/approve', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    const notices = [];
    try {
        checkId(req.params.id, 'milestone');
        await client.query('BEGIN');
        const m = await loadMilestone(client, req.params.id, true);
        if (m.business_id !== req.user.id) throw httpError(403, 'You do not own this project');
        if (m.status !== 'submitted') throw httpError(409, 'Only a submitted milestone can be approved');

        const { rows } = await client.query(
            "UPDATE milestones SET status = 'approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *", [m.id]
        );
        // Eligibility only. Nothing is held, transferred or released here.
        await client.query(
            `INSERT INTO payment_eligibilities (source_type, source_id, worker_id, business_id, amount)
             VALUES ('milestone', $1, $2, $3, $4) ON CONFLICT (source_type, source_id) DO NOTHING`,
            [m.id, m.worker_id, m.business_id, m.budget]
        );
        await logEvent(client, m.id, req.user.id, 'approved', { budget: Number(m.budget) });
        if (m.worker_id) notices.push([m.worker_id, `"${m.title}" was approved.`, '#/dashboard']);
        await client.query('COMMIT');
        notifyAfterCommit(notices);

        res.json({ ...view(rows[0], (await dependenciesOf(pool, [m.id])).get(m.id)), payment_status: 'eligible' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ------------------------------------------------ GET /api/milestones/:id/events
router.get('/:id/events', authenticate, async(req, res, next) => {
    try {
        checkId(req.params.id, 'milestone');
        const m = await loadMilestone(pool, req.params.id, false);
        const allowed = m.business_id === req.user.id || m.worker_id === req.user.id;
        if (!allowed) throw httpError(403, 'You do not have access to this milestone');
        const { rows } = await pool.query(
            `SELECT e.event, e.detail, e.created_at, u.name AS actor
             FROM milestone_events e LEFT JOIN users u ON u.id = e.actor_id
             WHERE e.milestone_id = $1 ORDER BY e.created_at, e.id`, [m.id]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
