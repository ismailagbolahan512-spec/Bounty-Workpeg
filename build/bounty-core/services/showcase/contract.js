// services/showcase/contract.js
// Public-safe mirror contract for the Workpeg showcase (docs/integration-architecture.md, section 2).
//
// PostgreSQL stays authoritative. This module only decides which fields of a bounty may be copied
// into the public showcase, and checks structural invariants. It never decides roles, permissions
// or whether anything may be approved: those stay in the Bounty backend.
//
// Pure functions, no I/O, so they can be tested without a database or Workpeg.

const SHOWCASE_STATUSES = ['open', 'in_progress', 'under_review', 'completed', 'closed', 'expired'];
const SUMMARY_MAX = 280;
const TITLE_MAX = 255;
const CATEGORY_MAX = 100;
const REWARD_MAX = 9999999999.99; // NUMERIC(12,2) in the bounties table

// The only fields that may leave PostgreSQL for the showcase. Anything not listed is never copied.
const SHOWCASE_FIELDS = Object.freeze([
    'pg_id',
    'title',
    'category',
    'reward_amount',
    'deadline',
    'status',
    'summary',
    'updated_at',
]);

// Strip control characters, collapse whitespace, and cut to SUMMARY_MAX characters.
// Output is plain text. The showcase page must render it with Text(), never as markup.
function makeSummary(description) {
    if (typeof description !== 'string') return '';
    const plain = description
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (plain.length <= SUMMARY_MAX) return plain;
    return plain.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
}

function toIso(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'string') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
}

// Map one bounties row (as read from PostgreSQL) to a public-safe showcase task.
// Returns a plain object containing only SHOWCASE_FIELDS.
function toShowcaseTask(row) {
    if (!row || typeof row !== 'object') {
        throw new TypeError('toShowcaseTask expects a bounty row');
    }
    return {
        pg_id: row.id,
        title: row.title,
        category: row.category,
        reward_amount: row.reward_amount === null || row.reward_amount === undefined
            ? null
            : Number(row.reward_amount),
        deadline: toIso(row.deadline),
        status: row.status,
        // Only the business-written public_summary. Never description (decision 4, 2026-11-12).
        summary: row.public_summary ? makeSummary(row.public_summary) : '',
        updated_at: toIso(row.updated_at),
    };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Structural invariants only, mirroring the one pre-save hook planned for showcase_tasks.
// Returns an array of problems. An empty array means the task may be published.
function validateShowcaseTask(task) {
    const problems = [];
    if (!task || typeof task !== 'object') return ['task must be an object'];

    const allowed = new Set(SHOWCASE_FIELDS);
    for (const key of Object.keys(task)) {
        if (!allowed.has(key)) problems.push(`unexpected field: ${key}`);
    }

    if (typeof task.pg_id !== 'string' || !UUID_RE.test(task.pg_id)) {
        problems.push('pg_id must be a PostgreSQL uuid');
    }
    if (typeof task.title !== 'string' || task.title.trim() === '' || task.title.length > TITLE_MAX) {
        problems.push(`title must be 1-${TITLE_MAX} characters`);
    }
    if (typeof task.category !== 'string' || task.category.trim() === '' || task.category.length > CATEGORY_MAX) {
        problems.push(`category must be 1-${CATEGORY_MAX} characters`);
    }
    if (typeof task.reward_amount !== 'number' || !Number.isFinite(task.reward_amount)
        || task.reward_amount < 0 || task.reward_amount > REWARD_MAX) {
        problems.push('reward_amount must be a finite number between 0 and the column limit');
    }
    if (toIso(task.deadline) === null) problems.push('deadline must be a valid timestamp');
    if (!SHOWCASE_STATUSES.includes(task.status)) {
        problems.push(`status must be one of: ${SHOWCASE_STATUSES.join(', ')}`);
    }
    if (typeof task.summary !== 'string' || task.summary.length > SUMMARY_MAX) {
        problems.push(`summary must be a string of at most ${SUMMARY_MAX} characters`);
    }
    if (toIso(task.updated_at) === null) problems.push('updated_at must be a valid timestamp');

    return problems;
}

module.exports = {
    SHOWCASE_FIELDS,
    SHOWCASE_STATUSES,
    SUMMARY_MAX,
    makeSummary,
    toShowcaseTask,
    validateShowcaseTask,
};
