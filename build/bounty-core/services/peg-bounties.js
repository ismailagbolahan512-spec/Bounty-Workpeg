// services/peg-bounties.js — the rules and the insert for a bounty posted from Workpeg.
// The rules mirror POST /api/bounties (routes/bounties.js) for the fields a peg may send. A peg
// cannot set execution modes, NDAs or rules of engagement: those keep their defaults.
// Posting needs the owner's approval first (routes/peg.js, POST /confirmations), and the approved
// payload must match this one exactly.

const { httpError } = require('../middleware/auth');
const { resolveExecution } = require('./execution');
const { validateTaskCurrency } = require('./regions');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const SUBMISSION_TYPES = ['github', 'url', 'file', 'text'];
const CATEGORIES = ['dev', 'design', 'content', 'marketing', 'other'];
const LIMITS = { TITLE_MIN: 3, TITLE_MAX: 200, DESCRIPTION_MIN: 10, DESCRIPTION_MAX: 5000, REWARD_MIN: 0.01, REWARD_MAX: 1000000 };

const FIELDS = ['title', 'description', 'category', 'difficulty', 'reward_amount', 'deadline', 'submission_type', 'currency', 'requirements', 'max_workers'];

// Returns a clean copy of the fields, or throws a 400 that names the first problem.
function validatePegBounty(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw httpError(400, 'Send the bounty as an object');
    }
    const b = {};
    for (const key of FIELDS) if (input[key] !== undefined) b[key] = input[key];

    if (typeof b.title !== 'string' || b.title.trim().length < LIMITS.TITLE_MIN || b.title.length > LIMITS.TITLE_MAX) {
        throw httpError(400, `Title must be ${LIMITS.TITLE_MIN} to ${LIMITS.TITLE_MAX} characters`);
    }
    if (typeof b.description !== 'string' || b.description.trim().length < LIMITS.DESCRIPTION_MIN || b.description.length > LIMITS.DESCRIPTION_MAX) {
        throw httpError(400, `Description must be ${LIMITS.DESCRIPTION_MIN} to ${LIMITS.DESCRIPTION_MAX} characters`);
    }
    if (!CATEGORIES.includes(b.category)) {
        throw httpError(400, `Category must be one of: ${CATEGORIES.join(', ')}`);
    }
    if (!DIFFICULTIES.includes(b.difficulty)) {
        throw httpError(400, `Difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
    }
    const reward = String(b.reward_amount === undefined || b.reward_amount === null ? '' : b.reward_amount).trim();
    const amount = Number(reward);
    if (!/^\d+(?:\.\d{1,2})?$/.test(reward) || !Number.isFinite(amount) || amount < LIMITS.REWARD_MIN || amount > LIMITS.REWARD_MAX) {
        throw httpError(400, `Reward must be between ${LIMITS.REWARD_MIN} and ${LIMITS.REWARD_MAX}, with at most 2 decimal places`);
    }
    const deadline = new Date(b.deadline);
    if (Number.isNaN(deadline.getTime())) throw httpError(400, 'Deadline must be a valid date');
    if (deadline.getTime() <= Date.now()) throw httpError(400, 'Deadline must be in the future');
    if (!SUBMISSION_TYPES.includes(b.submission_type)) {
        throw httpError(400, `Submission type must be one of: ${SUBMISSION_TYPES.join(', ')}`);
    }
    if (b.requirements !== undefined && b.requirements !== null && typeof b.requirements !== 'string') {
        throw httpError(400, 'Requirements must be text');
    }
    if (b.max_workers !== undefined && b.max_workers !== null &&
        !(Number.isInteger(b.max_workers) && b.max_workers >= 1 && b.max_workers <= 50)) {
        throw httpError(400, 'Workers must be a whole number from 1 to 50');
    }
    b.currency = validateTaskCurrency(b.currency, undefined);
    return {
        max_workers: b.max_workers === undefined || b.max_workers === null ? 3 : b.max_workers,
        title: b.title.trim(), description: b.description.trim(), category: b.category, difficulty: b.difficulty,
        reward_amount: amount.toFixed(2), deadline: deadline.toISOString(), submission_type: b.submission_type,
        requirements: b.requirements === undefined ? null : b.requirements, currency: b.currency,
    };
}

// Inserts an open bounty for the business, inside the caller's transaction (client).
async function insertPegBounty(client, businessId, f, confidential = false) {
    const execution = resolveExecution({ max_workers: f.max_workers });
    const { rows } = await client.query(
        `INSERT INTO bounties
           (business_id, title, description, category, difficulty, reward_amount, deadline, submission_type, requirements,
            acceptance_criteria, completion_checklist, execution_mode, industry, job_type, max_workers, winner_limit,
            independent_target, requires_authorization, nda_text, authorization_statement, rules_of_engagement,
            permitted_targets, prohibited_activities, status, created_at, updated_at, confidential, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]', '[]', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
                 'open', NOW(), NOW(), $22, $23)
         RETURNING id, title, reward_amount, currency, deadline, status`,
        [businessId, f.title, f.description, f.category, f.difficulty, f.reward_amount, f.deadline, f.submission_type,
            f.requirements, execution.execution_mode, execution.industry, execution.job_type, execution.max_workers,
            execution.winner_limit, execution.independent_target, execution.requires_authorization, execution.nda_text,
            execution.authorization_statement, execution.rules_of_engagement, execution.permitted_targets,
            execution.prohibited_activities, confidential, f.currency]
    );
    return rows[0];
}

module.exports = { validatePegBounty, insertPegBounty, FIELDS };
