// services/milestones.js — validation and dependency rules for milestones.

const { httpError } = require('../middleware/auth');

const MAX_MILESTONES = 20;
const STATUSES = ['planned', 'in_progress', 'submitted', 'revision_requested', 'approved'];

function requiredText(value, label, min, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw httpError(400, `${label} must be ${min}-${max} characters`);
    return text;
}

function optionalText(value, label, max) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > max) throw httpError(400, `${label} must be text, ${max} characters at most`);
    return value.trim();
}

function parseMilestone(body) {
    const b = body || {};
    const budget = b.budget === undefined || b.budget === null || b.budget === '' ? 0 : Number(b.budget);
    if (!Number.isFinite(budget) || budget < 0 || budget > 1000000) throw httpError(400, 'Budget must be between 0 and 1,000,000');
    let deadline = null;
    if (b.deadline) {
        deadline = new Date(b.deadline);
        if (Number.isNaN(deadline.getTime())) throw httpError(400, 'Deadline is not a valid date');
    }
    const dependsOn = b.depends_on === undefined || b.depends_on === null ? [] : b.depends_on;
    if (!Array.isArray(dependsOn) || dependsOn.length > MAX_MILESTONES) throw httpError(400, 'depends_on must be a list of milestone ids');
    return {
        title: requiredText(b.title, 'Title', 3, 160),
        description: optionalText(b.description, 'Description', 2000),
        deliverables: requiredText(b.deliverables, 'Deliverables', 3, 2000),
        acceptance_criteria: requiredText(b.acceptance_criteria, 'Acceptance criteria', 3, 2000),
        budget: Math.round(budget * 100) / 100,
        deadline,
        worker_id: b.worker_id || null,
        depends_on: [...new Set(dependsOn.map((x) => String(x)))],
    };
}

// Adding edges from `milestoneId` to `dependsOn` must not create a cycle.
// `edges` is a Map of milestone id -> array of ids it depends on, for the whole project.
function wouldCreateCycle(milestoneId, dependsOn, edges) {
    const stack = [...dependsOn];
    const seen = new Set();
    while (stack.length) {
        const id = stack.pop();
        if (id === milestoneId) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const next of edges.get(id) || []) stack.push(next);
    }
    return false;
}


// Project budget cap. A project with no total_budget has no cap. Otherwise the milestone
// budgets, including this one, must not exceed the total.
function assertWithinProjectBudget({ totalBudget, allocatedElsewhere, budget }) {
    if (totalBudget === null || totalBudget === undefined) return;
    const total = Number(totalBudget);
    const after = Math.round((Number(allocatedElsewhere) + Number(budget)) * 100) / 100;
    if (after > total) {
        throw httpError(400, `Milestone budgets would total ${after.toFixed(2)}, above the project budget of ${total.toFixed(2)}`);
    }
}

function projectBudgetView(totalBudget, allocated) {
    const total = totalBudget === null || totalBudget === undefined ? null : Number(totalBudget);
    const alloc = Math.round(Number(allocated) * 100) / 100;
    return {
        total,
        allocated: alloc,
        remaining: total === null ? null : Math.round((total - alloc) * 100) / 100,
    };
}

module.exports = {
    assertWithinProjectBudget,
    projectBudgetView, parseMilestone, wouldCreateCycle, STATUSES, MAX_MILESTONES };
