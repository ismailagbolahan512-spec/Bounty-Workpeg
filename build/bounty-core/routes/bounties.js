// routes/bounties.js â€” public browsing + business-only creation
// Production-grade bounty management with validation, pagination, and error handling.
//
// GET  /api/bounties?category=dev&difficulty=easy&status=open&page=1&limit=10  (public)
// GET  /api/bounties/:id                                                        (public)
// POST /api/bounties                                                            (business only)

const express = require('express');
const { pool } = require('../db');
const { readSessionToken, authenticate, requireRole, httpError } = require('../middleware/auth');
const { validateCriteria } = require('../services/criteria');
const { createNotification } = require('./notifications');
const { resolveExecution, logEvent, notifyAfterCommit, participantsOf } = require('../services/execution');
const { catalogue } = require('../services/classification');
const { canSeeTask, validateTaskCurrency } = require('../services/regions');
const { assertActiveAccount, requireAgreement, canAccessConfidential, assertConfidentialAccess } = require('../services/protection');
const dbq = (sql, params) => pool.query(sql, params);

const router = express.Router();

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

// Every value here is written somewhere: open (created), in_progress and under_review
// (reserved for review flow), completed (winner approved), closed (business closed it),
// expired (deadline passed with no winner).
const BOUNTY_STATUSES = ['open', 'in_progress', 'under_review', 'completed', 'closed', 'expired'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const SUBMISSION_TYPES = ['github', 'url', 'file', 'text'];
const CATEGORIES = ['dev', 'design', 'content', 'marketing', 'other'];

const UUID_RE_B = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGINATION = {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 50,
};

const VALIDATION = {
    TITLE_MIN: 3,
    TITLE_MAX: 200,
    DESCRIPTION_MIN: 10,
    CATEGORY_MAX: 50,
    REWARD_MIN: 0.01,
    REWARD_MAX: 1000000,
};

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

// What "done" means for a task: up to 10 short items. Empty is allowed.
function parseChecklist(value) {
    if (value === undefined || value === null || value === '') return [];
    if (!Array.isArray(value) || value.length > 10) {
        throw httpError(400, 'The completion checklist can have up to 10 items');
    }
    return value.map((item) => {
        const text = typeof item === 'string' ? item.trim() : '';
        if (text.length < 3 || text.length > 200) {
            throw httpError(400, 'Each checklist item must be 3-200 characters');
        }
        return text;
    });
}

function validatePagination(page, limit) {
    let p = Number.isInteger(page) && page >= 1 ? page : PAGINATION.DEFAULT_PAGE;
    let l = Number.isInteger(limit) && limit >= 1 ? limit : PAGINATION.DEFAULT_LIMIT;
    l = Math.min(l, PAGINATION.MAX_LIMIT);
    return { page: p, limit: l };
}

// Open bounties past their deadline become 'expired'. Runs before reads so a lapsed
// bounty never shows as open. Only 'open' rows change; completed or closed ones are left alone.
async function expireOverdueBounties() {
    const { rows } = await pool.query(
        `UPDATE bounties
         SET status = 'expired', closure_reason = 'deadline_passed', closed_at = NOW(), updated_at = NOW()
         WHERE status = 'open' AND deadline <= NOW()
         RETURNING id, title`
    );
    for (const b of rows) {
        const workers = await participantsOf(pool, b.id);
        await pool.query(
            `UPDATE bounty_participants SET status = 'closed', updated_at = NOW()
             WHERE bounty_id = $1 AND status IN ('active', 'assigned')`, [b.id]
        );
        await logEvent(pool, b.id, null, 'bounty_expired', { reason: 'deadline_passed' });
        notifyAfterCommit(workers.map((w) => [w, `"${b.title}" reached its deadline and is closed.`, '#/dashboard']));
    }
}

// The signed-in viewer's id and declared country, or null for anonymous visitors.
async function viewerOf(user) {
    if (!user) return null;
    const { rows } = await pool.query('SELECT country FROM users WHERE id = $1', [user.id]);
    return { id: user.id, country: rows.length ? rows[0].country : null };
}

// Reads the signed-in user when a token is sent, without refusing anonymous visitors.
function optionalAuth(req, res, next) {
    // Signed-in viewers can be identified by either a Bearer header or the session cookie.
    if (!req.headers.authorization && !readSessionToken(req)) return next();
    // A stale or revoked session must not block public pages: treat it as signed out.
    return authenticate(req, res, () => next());
}

function participationView(row) {
    return {
        status: row.status,
        nda_accepted: Boolean(row.nda_accepted_at),
        roe_accepted: Boolean(row.roe_accepted_at),
    };
}

function validateBountyInput(data) {
    const errors = [];

    if (typeof data.title !== 'string' || data.title.trim().length < VALIDATION.TITLE_MIN) {
        errors.push(`Title must be at least ${VALIDATION.TITLE_MIN} characters`);
    }
    if (typeof data.title === 'string' && data.title.length > VALIDATION.TITLE_MAX) {
        errors.push(`Title cannot exceed ${VALIDATION.TITLE_MAX} characters`);
    }

    if (typeof data.description !== 'string' || data.description.trim().length < VALIDATION.DESCRIPTION_MIN) {
        errors.push(`Description must be at least ${VALIDATION.DESCRIPTION_MIN} characters`);
    }

    if (typeof data.category !== 'string' || data.category.trim().length === 0) {
        errors.push('Category is required');
    }
    if (typeof data.category === 'string' && data.category.length > VALIDATION.CATEGORY_MAX) {
        errors.push(`Category cannot exceed ${VALIDATION.CATEGORY_MAX} characters`);
    }

    if (!DIFFICULTIES.includes(data.difficulty)) {
        errors.push(`Difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
    }

    const amountText = (data.reward_amount === null || data.reward_amount === undefined) ? '' : String(data.reward_amount).trim();
    const validAmountFormat = /^\d+(?:\.\d{1,2})?$/.test(amountText);
    const amount = Number(amountText);

    if (!validAmountFormat || !Number.isFinite(amount)) {
        errors.push('Reward amount must be a valid currency amount with at most 2 decimal places');
    } else if (amount < VALIDATION.REWARD_MIN || amount > VALIDATION.REWARD_MAX) {
        errors.push(`Reward amount must be between ${VALIDATION.REWARD_MIN} and ${VALIDATION.REWARD_MAX}`);
    }

    const deadline = new Date(data.deadline);
    if (Number.isNaN(deadline.getTime())) {
        errors.push('Deadline must be a valid ISO date');
    }
    if (deadline.getTime() <= Date.now()) {
        errors.push('Deadline must be in the future');
    }

    if (!SUBMISSION_TYPES.includes(data.submission_type)) {
        errors.push(`Submission type must be one of: ${SUBMISSION_TYPES.join(', ')}`);
    }

    return errors;
}

// ============================================================================
// GET /api/bounties â€” Public browsing with filters and pagination
// ============================================================================

router.get('/', optionalAuth, async(req, res, next) => {
    try {
        const { category, difficulty, status, page: pageParam, limit: limitParam } = req.query;

        // Validate filters
        if (difficulty && !DIFFICULTIES.includes(difficulty)) {
            throw httpError(400, `Difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
        }
        if (status && !BOUNTY_STATUSES.includes(status)) {
            throw httpError(400, `Status must be one of: ${BOUNTY_STATUSES.join(', ')}`);
        }

        // Validate pagination
        const { page, limit } = validatePagination(parseInt(pageParam, 10), parseInt(limitParam, 10));

        await expireOverdueBounties();

        // Build parameterized query
        const conditions = [];
        const params = [];

        // Onsite services are listed on their own page (/api/services), never on the bounty board.
        // Filter by category so this works whether or not migration 027 has been applied.
        conditions.push(`b.category <> 'hospitality'`);

        if (category !== undefined) {
            conditions.push(`b.category = $${params.length + 1}`);
            params.push(String(category).trim());
        }

        if (difficulty !== undefined) {
            conditions.push(`b.difficulty = $${params.length + 1}`);
            params.push(difficulty);
        }

        // Browsing shows open bounties unless a status is requested explicitly.
        conditions.push(`b.status = $${params.length + 1}`);
        params.push(status !== undefined ? status : 'open');

        // Tasks limited to some regions are only listed for their business and for people in those regions.
        const viewer = await viewerOf(req.user);
        conditions.push(`(cardinality(b.regions) = 0 OR b.business_id = $${params.length + 1}::uuid OR $${params.length + 2}::char(2) = ANY(b.regions))`);
        params.push(viewer ? viewer.id : null, viewer ? viewer.country : null);

        // A bounty past its deadline is hidden from the public. The business that posted it still sees it
        // and can make its decisions.
        conditions.push(`(b.status <> 'expired' OR b.business_id = $${params.length + 1}::uuid)`);
        params.push(viewer ? viewer.id : null);

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // Count total
        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM bounties b ${whereClause}`,
            params
        );
        const total = countResult.rows[0].total;

        // Fetch paginated results
        const offset = (page - 1) * limit;
        const queryParams = [...params, limit, offset];

        const { rows } = await pool.query(
            `SELECT
         b.id,
         b.title,
         b.description,
         b.category,
         b.difficulty,
         b.reward_amount,
         b.deadline,
         b.submission_type,
         b.status,
         b.created_at,
         u.id AS business_id,
         u.name AS business_name,
         (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id)::int AS submissions_count
       FROM bounties b
       JOIN users u ON u.id = b.business_id
       ${whereClause}
       ORDER BY b.created_at DESC
       LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
            queryParams
        );

        res.json({
            bounties: rows,
            pagination: { page, limit, total },
        });
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// GET /api/bounties/:id â€” Bounty detail with business and winner info
// ============================================================================

router.get('/:id', optionalAuth, async(req, res, next) => {
    try {
        const bountyId = req.params.id;
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!UUID_REGEX.test(bountyId)) {
            throw httpError(400, 'Invalid bounty ID');
        }

        await expireOverdueBounties();

        const { rows } = await pool.query(
            `SELECT
         b.id,
         b.title,
         b.description,
         b.category,
         b.difficulty,
         b.reward_amount,
         b.deadline,
         b.submission_type,
         b.requirements,
         b.acceptance_criteria,
         b.completion_checklist,
         b.funding_status,
         b.project_id,
         b.status,
         b.created_at,
         b.updated_at,
         b.completed_at,
         b.execution_mode,
         b.regions,
         b.industry,
         b.job_type,
         b.max_workers,
         b.winner_limit,
         b.independent_target,
         b.requires_authorization,
         b.confidential,
         b.nda_text,
         b.authorization_statement,
         b.rules_of_engagement,
         b.permitted_targets,
         b.prohibited_activities,
         b.closure_reason,
         b.closed_at,
         (SELECT COUNT(*) FROM bounty_participants p
            WHERE p.bounty_id = b.id AND p.status IN ('active', 'assigned'))::int AS participants_count,
         u.id AS business_id,
         u.name AS business_name,
         u.avatar_url AS business_avatar,
         w.id AS winner_id,
         w.name AS winner_name,
         (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id)::int AS submissions_count
       FROM bounties b
       JOIN users u ON u.id = b.business_id
       LEFT JOIN users w ON w.id = b.winner_id
       WHERE b.id = $1`, [bountyId]
        );

        if (rows.length === 0) {
            throw httpError(404, 'Bounty not found');
        }

        const b = rows[0];
        const viewer = await viewerOf(req.user);
        if (!canSeeTask(b, viewer)) {
            throw httpError(404, 'Bounty not found');
        }
        // Expired bounties are hidden from the public. The business that posted them still sees them,
        // and so does anyone who took the task, so they keep their record of it.
        if (b.status === 'expired' && !(viewer && String(viewer.id) === String(b.business_id))) {
            const { rows: took } = viewer
                ? await pool.query('SELECT 1 FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2 LIMIT 1', [bountyId, viewer.id])
                : { rows: [] };
            if (took.length === 0) throw httpError(404, 'Bounty not found');
        }

        const deps = await pool.query(
            `SELECT d.id, d.title, d.status
             FROM task_dependencies td
             JOIN bounties d ON d.id = td.depends_on_id
             WHERE td.bounty_id = $1
             ORDER BY d.created_at ASC`, [bountyId]
        );

        const viewerId = req.user ? req.user.id : null;
        const isOwner = Boolean(viewerId && viewerId === b.business_id);
        let participation = null;
        if (viewerId && !isOwner) {
            const p = await pool.query(
                `SELECT status, nda_accepted_at, roe_accepted_at FROM bounty_participants
                 WHERE bounty_id = $1 AND worker_id = $2`, [bountyId, viewerId]
            );
            participation = p.rows[0] ? participationView(p.rows[0]) : null;
        }
        // Authorization material is shown to the owner and to workers who accepted the NDA.
        const canSeeScope = isOwner || Boolean(participation && participation.nda_accepted);
        const scope = b.requires_authorization ? (canSeeScope ? {
            authorization_statement: b.authorization_statement,
            rules_of_engagement: b.rules_of_engagement,
            permitted_targets: b.permitted_targets,
            prohibited_activities: b.prohibited_activities,
        } : { restricted: true }) : null;

        const detail = {
            id: b.id,
            project_id: b.project_id,
            execution_mode: b.execution_mode,
            industry: b.industry,
            job_type: b.job_type,
            max_workers: b.max_workers,
            winner_limit: b.winner_limit,
            independent_target: b.independent_target,
            participants_count: b.participants_count,
            closure_reason: b.closure_reason,
            closed_at: b.closed_at,
            requires_authorization: b.requires_authorization,
            nda_text: b.requires_authorization ? b.nda_text : null,
            scope,
            my_participation: participation,
            acceptance_criteria: b.acceptance_criteria,
            completion_checklist: b.completion_checklist,
            funding_status: b.funding_status,
            depends_on: deps.rows,
            blocked: deps.rows.some((d) => d.status !== 'completed'),
            title: b.title,
            description: b.description,
            category: b.category,
            difficulty: b.difficulty,
            reward_amount: b.reward_amount,
            deadline: b.deadline,
            submission_type: b.submission_type,
            requirements: b.requirements,
            status: b.status,
            created_at: b.created_at,
            updated_at: b.updated_at,
            completed_at: b.completed_at,
            business: {
                id: b.business_id,
                name: b.business_name,
                avatar_url: b.business_avatar,
            },
            winner: b.winner_id ? {
                id: b.winner_id,
                name: b.winner_name,
            } : null,
            submissions_count: b.submissions_count,
            confidential: b.confidential,
        };
        // Confidential tasks: material is shown only to the owner, admins, and workers with
        // an accepted task NDA and an active place on the task.
        if (b.confidential && !isOwner && !(req.user && req.user.is_admin)) {
            const allowed = viewerId ? await canAccessConfidential(dbq, viewerId, bountyId) : false;
            if (!allowed) {
                Object.assign(detail, {
                    restricted: true, nda_required: true, scope: null,
                    description: null, requirements: null,
                    acceptance_criteria: null, completion_checklist: null,
                });
            }
        }
        res.json(detail);
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// POST /api/bounties â€” Create bounty (business only)
// ============================================================================

router.post('/', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        await requireAgreement(dbq, req.user.id, 'creator_protection_business');
        const {
            title,
            description,
            category,
            difficulty,
            reward_amount,
            deadline,
            submission_type,
            requirements,
            acceptance_criteria,
            completion_checklist,
        } = req.body || {};
        const criteria = validateCriteria(acceptance_criteria);
        const body = req.body || {};
        const checklist = parseChecklist(completion_checklist);

        // Validate all inputs
        const validationErrors = validateBountyInput({
            title,
            description,
            category,
            difficulty,
            reward_amount,
            deadline,
            submission_type,
        });

        const execution = resolveExecution(body);
        const currency = validateTaskCurrency(body.currency, undefined);

        if (validationErrors.length > 0) {
            throw httpError(400, validationErrors.join('; '));
        }

        // Parse and format values
        const amount = Number(reward_amount).toFixed(2);
        const deadlineDate = new Date(deadline).toISOString();

        // Handle requirements: string or array
        let requirementsValue = null;
        if (requirements !== undefined && requirements !== null) {
            if (typeof requirements === 'string') {
                requirementsValue = requirements;
            } else if (Array.isArray(requirements) && requirements.every((r) => typeof r === 'string')) {
                requirementsValue = JSON.stringify(requirements);
            } else {
                throw httpError(400, 'Requirements must be a string or an array of strings');
            }
        }

        // Insert bounty
        const { rows } = await pool.query(
            `INSERT INTO bounties
         (business_id, title, description, category, difficulty, reward_amount, deadline, submission_type, requirements, acceptance_criteria, completion_checklist,
          execution_mode, industry, job_type, max_workers, winner_limit, independent_target, requires_authorization,
          nda_text, authorization_statement, rules_of_engagement, permitted_targets, prohibited_activities,
          status, created_at, updated_at, confidential, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
               'open', NOW(), NOW(), $24, $25)
       RETURNING
         id, title, description, category, difficulty, reward_amount, deadline,
         submission_type, requirements, acceptance_criteria, completion_checklist, funding_status, status, created_at, updated_at`, [
                req.user.id,
                title.trim(),
                description.trim(),
                category.trim(),
                difficulty,
                amount,
                deadlineDate,
                submission_type,
                requirementsValue,
                JSON.stringify(criteria),
                JSON.stringify(checklist),
                execution.execution_mode,
                execution.industry,
                execution.job_type,
                execution.max_workers,
                execution.winner_limit,
                execution.independent_target,
                execution.requires_authorization,
                execution.nda_text,
                execution.authorization_statement,
                execution.rules_of_engagement,
                execution.permitted_targets,
                execution.prohibited_activities,
                (req.body || {}).confidential === true,
                currency,
            ]
        );

        const bounty = rows[0];
        await logEvent(pool, bounty.id, req.user.id, 'bounty_created', {
            execution_mode: execution.execution_mode, job_type: execution.job_type,
        });

        res.status(201).json({
            id: bounty.id,
            title: bounty.title,
            description: bounty.description,
            category: bounty.category,
            difficulty: bounty.difficulty,
            reward_amount: bounty.reward_amount,
            deadline: bounty.deadline,
            submission_type: bounty.submission_type,
            requirements: bounty.requirements,
            acceptance_criteria: bounty.acceptance_criteria,
            completion_checklist: bounty.completion_checklist,
            funding_status: bounty.funding_status,
            execution_mode: execution.execution_mode,
            job_type: execution.job_type,
            industry: execution.industry,
            max_workers: execution.max_workers,
            winner_limit: execution.winner_limit,
            independent_target: execution.independent_target,
            requires_authorization: execution.requires_authorization,
            execution_note: execution.note,
            status: bounty.status,
            created_at: bounty.created_at,
            updated_at: bounty.updated_at,
        });
    } catch (err) {
        next(err);
    }
});

// Cancel an open bounty (owner business only). Participants are released and told.
router.patch('/:id/close', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        if (!UUID_RE_B.test(id)) throw httpError(400, 'Invalid bounty ID');
        await client.query('BEGIN');
        const owned = await client.query(
            `SELECT id, title FROM bounties
             WHERE id = $1 AND business_id = $2 AND status = 'open'
             FOR UPDATE`, [id, req.user.id]
        );
        if (!owned.rows.length) throw httpError(404, 'Open bounty not found for this account');

        const { rows } = await client.query(
            `UPDATE bounties SET status = 'closed', closure_reason = 'cancelled_by_business', closed_at = NOW(), updated_at = NOW()
             WHERE id = $1
             RETURNING id, status, closure_reason`, [id]
        );
        const workers = await participantsOf(client, id);
        await client.query(
            `UPDATE bounty_participants SET status = 'closed', updated_at = NOW()
             WHERE bounty_id = $1 AND status IN ('active', 'assigned')`, [id]
        );
        await client.query(
            `UPDATE submissions SET status = 'closed', updated_at = NOW()
             WHERE bounty_id = $1 AND status IN ('pending', 'revision_requested')`, [id]
        );
        await logEvent(client, id, req.user.id, 'bounty_cancelled', {});
        await client.query('COMMIT');

        notifyAfterCommit(workers.map((w) => [w, `The business closed "${owned.rows[0].title}".`, '#/dashboard']));
        res.json(rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ============================================================================
// Taking a task. Workers accept open tasks; in team mode the business assigns them.
// Security tasks are taken in two steps: NDA first, rules of engagement second.
// ============================================================================

// POST /api/bounties/:id/accept (worker)
router.post('/:id/accept', authenticate, requireRole('worker'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const bountyId = req.params.id;
        if (!UUID_RE_B.test(bountyId)) throw httpError(400, 'Invalid bounty ID');
        const body = req.body || {};
        const ndaNow = body.nda_accepted === true;
        const roeNow = body.roe_accepted === true;

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, business_id, title, status, deadline, execution_mode, max_workers, requires_authorization, confidential
             FROM bounties WHERE id = $1 FOR UPDATE`, [bountyId]
        );
        if (rows.length === 0) throw httpError(404, 'Bounty not found');
        const b = rows[0];
        if (b.business_id === req.user.id) throw httpError(403, 'You cannot take your own task');
        await assertActiveAccount(req.user.id);
        if (b.confidential) await requireAgreement(client.query.bind(client), req.user.id, 'task_nda', bountyId);

        const found = await client.query(
            `SELECT * FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2 FOR UPDATE`, [bountyId, req.user.id]
        );
        const existing = found.rows[0] || null;
        if (existing && (existing.status === 'closed' || existing.status === 'withdrawn')) {
            throw httpError(409, 'You are no longer part of this task');
        }
        if (b.status !== 'open' || new Date(b.deadline).getTime() <= Date.now()) {
            throw httpError(409, 'This task is not open for new workers');
        }
        if (b.execution_mode === 'team' && !(existing && existing.status === 'assigned')) {
            throw httpError(409, 'Team tasks are assigned by the business');
        }

        const ndaDone = Boolean(existing && existing.nda_accepted_at) || ndaNow;
        if (b.requires_authorization && !ndaDone) {
            throw httpError(400, 'Accept the confidentiality agreement (NDA) before taking this task');
        }
        if (roeNow && !ndaDone) {
            throw httpError(400, 'Accept the NDA before the rules of engagement');
        }

        if (!existing) {
            const count = await client.query(
                `SELECT COUNT(*)::int AS n FROM bounty_participants
                 WHERE bounty_id = $1 AND status IN ('active', 'assigned')`, [bountyId]
            );
            if (count.rows[0].n >= b.max_workers) {
                throw httpError(409, 'This task already has its maximum number of workers');
            }
        }

        const saved = await client.query(
            `INSERT INTO bounty_participants (bounty_id, worker_id, status, nda_accepted_at, roe_accepted_at)
             VALUES ($1, $2, 'active',
                     CASE WHEN $3::boolean THEN NOW() END,
                     CASE WHEN $4::boolean THEN NOW() END)
             ON CONFLICT (bounty_id, worker_id) DO UPDATE SET
               status = CASE WHEN bounty_participants.status = 'assigned' THEN 'active' ELSE bounty_participants.status END,
               nda_accepted_at = COALESCE(bounty_participants.nda_accepted_at, CASE WHEN $3::boolean THEN NOW() END),
               roe_accepted_at = COALESCE(bounty_participants.roe_accepted_at, CASE WHEN $4::boolean THEN NOW() END),
               updated_at = NOW()
             RETURNING *`, [bountyId, req.user.id, ndaNow, roeNow]
        );
        await logEvent(client, bountyId, req.user.id, existing ? 'worker_terms_accepted' : 'worker_accepted', {
            nda: ndaNow, roe: roeNow,
        });
        await client.query('COMMIT');

        if (!existing) {
            notifyAfterCommit([
                [b.business_id, `${req.user.name} took "${b.title}".`, '#/bounties/' + bountyId],
                [req.user.id, `You took "${b.title}". Submit your work before the deadline.`, '#/bounties/' + bountyId],
            ]);
        }
        res.status(existing ? 200 : 201).json(participationView(saved.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// POST /api/bounties/:id/assign (business, team tasks only)
router.post('/:id/assign', authenticate, requireRole('business'), async(req, res, next) => {
    const client = await pool.connect();
    try {
        const bountyId = req.params.id;
        const workerId = typeof (req.body || {}).worker_id === 'string' ? req.body.worker_id.trim() : '';
        if (!UUID_RE_B.test(bountyId)) throw httpError(400, 'Invalid bounty ID');
        if (!UUID_RE_B.test(workerId)) throw httpError(400, 'worker_id must be a valid worker ID');

        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, business_id, title, status, execution_mode, max_workers
             FROM bounties WHERE id = $1 FOR UPDATE`, [bountyId]
        );
        if (rows.length === 0) throw httpError(404, 'Bounty not found');
        const b = rows[0];
        if (b.business_id !== req.user.id) throw httpError(403, 'You do not own this task');
        if (b.execution_mode !== 'team') throw httpError(409, 'Only team tasks are assigned. Other tasks are taken by workers.');
        if (b.status !== 'open') throw httpError(409, 'Only open tasks can be assigned');

        const worker = await client.query(`SELECT id, name, role FROM users WHERE id = $1`, [workerId]);
        if (worker.rows.length === 0 || worker.rows[0].role !== 'worker') {
            throw httpError(400, 'Choose a worker account to assign');
        }

        const existing = await client.query(
            `SELECT status FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2 FOR UPDATE`, [bountyId, workerId]
        );
        if (existing.rows[0] && existing.rows[0].status === 'active') {
            throw httpError(409, 'This worker is already on the task');
        }
        const count = await client.query(
            `SELECT COUNT(*)::int AS n FROM bounty_participants
             WHERE bounty_id = $1 AND status IN ('active', 'assigned') AND worker_id <> $2`, [bountyId, workerId]
        );
        if (count.rows[0].n >= b.max_workers) throw httpError(409, 'This task already has its maximum number of workers');

        await client.query(
            `INSERT INTO bounty_participants (bounty_id, worker_id, status)
             VALUES ($1, $2, 'assigned')
             ON CONFLICT (bounty_id, worker_id) DO UPDATE SET status = 'assigned', updated_at = NOW()`, [bountyId, workerId]
        );
        await logEvent(client, bountyId, req.user.id, 'worker_assigned', { worker_id: workerId });
        await client.query('COMMIT');

        notifyAfterCommit([[workerId, `You were assigned to "${b.title}". Accept its terms to start.`, '#/bounties/' + bountyId]]);
        res.status(201).json({ worker_id: workerId, worker_name: worker.rows[0].name, status: 'assigned' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// GET /api/bounties/:id/history (owner business only): the audit trail for this task.
router.get('/:id/history', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const bountyId = req.params.id;
        if (!UUID_RE_B.test(bountyId)) throw httpError(400, 'Invalid bounty ID');
        const owner = await pool.query(`SELECT business_id FROM bounties WHERE id = $1`, [bountyId]);
        if (owner.rows.length === 0) throw httpError(404, 'Bounty not found');
        if (owner.rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own this task');
        const { rows } = await pool.query(
            `SELECT e.event, e.detail, e.created_at, u.name AS actor_name
             FROM execution_events e
             LEFT JOIN users u ON u.id = e.actor_id
             WHERE e.bounty_id = $1
             ORDER BY e.created_at ASC, e.id ASC`, [bountyId]
        );
        res.json(rows.map((r) => ({ event: r.event, detail: r.detail, at: r.created_at, actor: r.actor_name || 'System' })));
    } catch (err) {
        next(err);
    }
});

// GET /api/bounties/:id/participants (owner business only)
router.get('/:id/participants', authenticate, requireRole('business'), async(req, res, next) => {
    try {
        const bountyId = req.params.id;
        if (!UUID_RE_B.test(bountyId)) throw httpError(400, 'Invalid bounty ID');
        const owner = await pool.query(`SELECT business_id FROM bounties WHERE id = $1`, [bountyId]);
        if (owner.rows.length === 0) throw httpError(404, 'Bounty not found');
        if (owner.rows[0].business_id !== req.user.id) throw httpError(403, 'You do not own this task');
        const { rows } = await pool.query(
            `SELECT p.worker_id, u.name AS worker_name, p.status,
                    p.nda_accepted_at, p.roe_accepted_at, p.created_at
             FROM bounty_participants p
             JOIN users u ON u.id = p.worker_id
             WHERE p.bounty_id = $1
             ORDER BY p.created_at ASC`, [bountyId]
        );
        res.json(rows.map((r) => ({
            worker_id: r.worker_id,
            worker_name: r.worker_name,
            status: r.status,
            nda_accepted: Boolean(r.nda_accepted_at),
            roe_accepted: Boolean(r.roe_accepted_at),
            joined_at: r.created_at,
        })));
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// Task workspace messages. Visible to the business that owns the task and to
// workers who have submitted to it.
// ============================================================================

async function workspaceRole(bountyId, user) {
    const { rows } = await pool.query(
        `SELECT b.business_id,
                (EXISTS (SELECT 1 FROM submissions s WHERE s.bounty_id = b.id AND s.worker_id = $2)
                 OR EXISTS (SELECT 1 FROM bounty_participants p
                            WHERE p.bounty_id = b.id AND p.worker_id = $2 AND p.status <> 'withdrawn')) AS is_worker,
                b.confidential
         FROM bounties b WHERE b.id = $1`, [bountyId, user.id]
    );
    if (rows.length === 0) throw httpError(404, 'Bounty not found');
    if (rows[0].business_id === user.id) return { role: 'business', businessId: rows[0].business_id };
    if (rows[0].is_worker) {
        await assertConfidentialAccess(dbq, bountyId, user.id, rows[0].confidential);
        return { role: 'worker', businessId: rows[0].business_id };
    }
    throw httpError(403, 'Only the business and workers on this task can see its workspace');
}

// GET /api/bounties/:id/messages
router.get('/:id/messages', authenticate, async(req, res, next) => {
    try {
        const bountyId = req.params.id;
        if (!UUID_RE_B.test(bountyId)) throw httpError(400, 'Invalid bounty ID');
        await workspaceRole(bountyId, req.user);

        const { rows } = await pool.query(
            `SELECT m.id, m.body, m.created_at, m.sender_id, u.name AS sender_name,
                    (m.sender_id = b.business_id) AS from_business
             FROM bounty_messages m
             JOIN users u ON u.id = m.sender_id
             JOIN bounties b ON b.id = m.bounty_id
             WHERE m.bounty_id = $1
             ORDER BY m.created_at ASC
             LIMIT 200`, [bountyId]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/bounties/:id/messages  { body }
router.post('/:id/messages', authenticate, async(req, res, next) => {
    try {
        const bountyId = req.params.id;
        if (!UUID_RE_B.test(bountyId)) throw httpError(400, 'Invalid bounty ID');
        const body = typeof (req.body || {}).body === 'string' ? req.body.body.trim() : '';
        if (body.length < 1 || body.length > 2000) throw httpError(400, 'Message must be 1-2000 characters');

        const access = await workspaceRole(bountyId, req.user);
        const { rows } = await pool.query(
            `INSERT INTO bounty_messages (bounty_id, sender_id, body, created_at)
             VALUES ($1, $2, $3, NOW()) RETURNING id, body, created_at, sender_id`, [bountyId, req.user.id, body]
        );

        // Tell the other side. A business message goes to every worker on the task; a worker message goes to the business.
        const link = '#/bounties/' + bountyId;
        if (access.role === 'business') {
            const workers = await pool.query('SELECT DISTINCT worker_id FROM submissions WHERE bounty_id = $1', [bountyId]);
            workers.rows.forEach((w) => createNotification(w.worker_id, 'New message on a task you are working on.', link).catch(() => {}));
        } else {
            createNotification(access.businessId, 'New message from a worker on your task.', link).catch(() => {});
        }
        res.status(201).json({ ...rows[0], from_business: access.role === 'business', sender_name: req.user.name });
    } catch (err) {
        next(err);
    }
});

router.validateBountyInput = validateBountyInput;
module.exports = router;