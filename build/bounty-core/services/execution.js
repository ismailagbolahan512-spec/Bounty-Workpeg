// services/execution.js — shared rules for the four execution modes.
//
// Used by routes/bounties.js (creation, acceptance, closure) and routes/submissions.js
// (submitting and approving). Keeping the rules here means each mode is defined once.

const { pool } = require('../db');
const { httpError } = require('../middleware/auth');
const { createNotification } = require('../routes/notifications');
const { EXECUTION_MODES, jobTypeById, modeFit } = require('./classification');

const MODES = Object.keys(EXECUTION_MODES);
const MAX_WORKERS = 50;

// One winner only: first valid, team components, and competitive tasks with one winner.
// Competitive with several winners and independent assessments allow several approvals.
function isExclusive(mode, winnerLimit) {
    if (mode === 'first_valid' || mode === 'team') return true;
    if (mode === 'competitive') return Number(winnerLimit) === 1;
    return false;
}

// How many approved results complete the task.
function targetFor(bounty) {
    if (bounty.execution_mode === 'independent') return Number(bounty.independent_target);
    return Number(bounty.winner_limit);
}

async function logEvent(db, bountyId, actorId, event, detail = {}) {
    await db.query(
        `INSERT INTO execution_events (bounty_id, actor_id, event, detail) VALUES ($1, $2, $3, $4)`,
        [bountyId, actorId || null, event, JSON.stringify(detail)]
    );
}

// Sends notifications after a commit. A failed notification never undoes the action.
function notifyAfterCommit(items) {
    for (const [userId, message, link] of items) {
        createNotification(userId, message, link || null).catch(() => {});
    }
}

async function participantsOf(db, bountyId, statuses = ['active', 'assigned']) {
    const { rows } = await db.query(
        `SELECT worker_id FROM bounty_participants WHERE bounty_id = $1 AND status = ANY($2)`,
        [bountyId, statuses]
    );
    return rows.map((r) => r.worker_id);
}

// Checks the execution settings a business submits. Returns the values to store, a note
// about how the chosen mode fits the job type, and throws a 400 for impossible setups.
function resolveExecution(input) {
    const mode = input.execution_mode === undefined || input.execution_mode === null || input.execution_mode === '' ?
        'competitive' : input.execution_mode;
    if (!MODES.includes(mode)) {
        throw httpError(400, `Execution mode must be one of: ${MODES.join(', ')}`);
    }
    if (mode === 'team') {
        throw httpError(400, 'Team execution is set up from a project. Create a project and choose Team / Parallel Execution there.');
    }

    let job = null;
    if (input.job_type !== undefined && input.job_type !== null && input.job_type !== '') {
        job = jobTypeById(String(input.job_type));
        if (!job) throw httpError(400, 'Unknown job type. Choose one from the list.');
    }

    const intOr = (value, fallback, min, max, label) => {
        if (value === undefined || value === null || value === '') return fallback;
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isInteger(n) || n < min || n > max) {
            throw httpError(400, `${label} must be a whole number from ${min} to ${max}`);
        }
        return n;
    };

    const maxWorkers = intOr(input.max_workers, 3, 1, MAX_WORKERS, 'Maximum workers');
    let winnerLimit = 1;
    let independentTarget = null;

    if (mode === 'competitive') {
        winnerLimit = intOr(input.winner_limit, 1, 1, maxWorkers, 'Number of winners');
    } else if (mode === 'independent') {
        independentTarget = intOr(input.independent_target, Math.min(3, maxWorkers), 2, maxWorkers,
            'Number of independent assessments');
        winnerLimit = independentTarget;
    } else if (mode === 'first_valid') {
        if (input.winner_limit !== undefined && input.winner_limit !== null && Number(input.winner_limit) !== 1) {
            throw httpError(400, 'First Valid Submission has exactly one winner');
        }
    }

    const requiresAuthorization = Boolean(job && job.requires_authorization);
    const security = {
        nda_text: null, authorization_statement: null, rules_of_engagement: null,
        permitted_targets: null, prohibited_activities: null,
    };
    if (requiresAuthorization) {
        const field = (key, label, min) => {
            const text = typeof input[key] === 'string' ? input[key].trim() : '';
            if (text.length < min || text.length > 5000) {
                throw httpError(400, `${label} is required for this kind of task (${min}-5000 characters)`);
            }
            security[key] = text;
        };
        field('nda_text', 'The confidentiality agreement (NDA) text', 80);
        field('authorization_statement', 'The written authorization statement', 80);
        field('rules_of_engagement', 'Rules of engagement', 80);
        field('permitted_targets', 'Permitted targets and scope', 20);
        field('prohibited_activities', 'Prohibited activities', 20);
    }

    const fit = job ? modeFit(job, mode) : { fit: 'unknown', note: null };
    return {
        execution_mode: mode,
        job_type: job ? job.id : null,
        industry: job ? job.industry : null,
        max_workers: maxWorkers,
        winner_limit: winnerLimit,
        independent_target: independentTarget,
        requires_authorization: requiresAuthorization,
        ...security,
        fit: fit.fit,
        note: fit.note,
    };
}

module.exports = {
    MODES, MAX_WORKERS, isExclusive, targetFor, logEvent, notifyAfterCommit,
    participantsOf, resolveExecution,
};
