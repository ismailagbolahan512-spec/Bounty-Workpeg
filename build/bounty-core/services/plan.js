// services/plan.js — project plan validation (shared by manual create and AI drafts)
// and the AI provider call. Nothing here publishes anything: an AI plan is only a draft
// until a business approves it.
//
// Plan shape:
//   { title, description, tasks: [ { title, description, category, difficulty,
//       reward_amount, deadline, submission_type, acceptance_criteria?, depends_on? } ] }
//   depends_on: array of 0-based task indexes within the same plan.

const { httpError } = require('../middleware/auth');
const { validateCriteria } = require('./criteria');
const { validateBountyInput } = require('../routes/bounties');

const MAX_TASKS = 12;
const PLAN_TITLE_MAX = 200;

// Returns true if the dependency graph (task index -> prerequisite indexes) has a cycle.
function hasDependencyCycle(count, depsByIndex) {
    const state = new Array(count).fill(0); // 0 new, 1 on stack, 2 done
    const visit = (i) => {
        if (state[i] === 1) return true;
        if (state[i] === 2) return false;
        state[i] = 1;
        for (const j of depsByIndex[i]) {
            if (visit(j)) return true;
        }
        state[i] = 2;
        return false;
    };
    for (let i = 0; i < count; i++) {
        if (visit(i)) return true;
    }
    return false;
}

// Validates and normalizes a plan. Throws 400 with every problem listed.
function validatePlan(raw) {
    if (!raw || typeof raw !== 'object') throw httpError(400, 'Plan must be an object');
    const errors = [];

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length < 3 || title.length > PLAN_TITLE_MAX) {
        errors.push(`Project title must be 3-${PLAN_TITLE_MAX} characters`);
    }
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (description.length < 10) errors.push('Project description must be at least 10 characters');

    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
        errors.push('A project needs at least one task');
    } else if (raw.tasks.length > MAX_TASKS) {
        errors.push(`A project can have at most ${MAX_TASKS} tasks`);
    }

    const tasks = [];
    const depsByIndex = [];
    if (Array.isArray(raw.tasks)) {
        raw.tasks.slice(0, MAX_TASKS).forEach((t, i) => {
            const label = `Task ${i + 1}`;
            const taskErrors = validateBountyInput({
                title: t && t.title,
                description: t && t.description,
                category: t && t.category,
                difficulty: t && t.difficulty,
                reward_amount: t && t.reward_amount,
                deadline: t && t.deadline,
                submission_type: t && t.submission_type,
            }).map((e) => `${label}: ${e}`);
            errors.push(...taskErrors);

            let criteria = [];
            try {
                criteria = validateCriteria(t && t.acceptance_criteria);
            } catch (err) {
                errors.push(`${label}: ${err.message}`);
            }

            let deps = [];
            if (t && t.depends_on !== undefined && t.depends_on !== null) {
                if (!Array.isArray(t.depends_on) || !t.depends_on.every(Number.isInteger)) {
                    errors.push(`${label}: depends_on must be an array of task numbers (0-based indexes)`);
                } else {
                    deps = [...new Set(t.depends_on)];
                    for (const d of deps) {
                        if (d < 0 || d >= raw.tasks.length) errors.push(`${label}: depends_on index ${d} does not exist`);
                        if (d === i) errors.push(`${label}: a task cannot depend on itself`);
                    }
                    deps = deps.filter((d) => d >= 0 && d < raw.tasks.length && d !== i);
                }
            }

            tasks.push({
                title: t.title.trim(),
                description: t.description.trim(),
                category: t.category.trim(),
                difficulty: t.difficulty,
                reward_amount: Number(t.reward_amount).toFixed(2),
                deadline: new Date(t.deadline).toISOString(),
                submission_type: t.submission_type,
                acceptance_criteria: criteria,
                depends_on: deps,
            });
            depsByIndex.push(deps);
        });
    }

    if (errors.length === 0 && hasDependencyCycle(tasks.length, depsByIndex)) {
        errors.push('Task dependencies form a cycle. Remove one dependency so tasks are not waiting on each other.');
    }
    if (errors.length) throw httpError(400, errors.join('; '));

    return { title, description, tasks };
}

// Calls the configured AI provider. Requires AI_PROVIDER_URL. AI_PROVIDER_KEY is optional
// (sent as a bearer token). AI_TIMEOUT_MS defaults to 20000.
function aiConfigured() {
    return Boolean(process.env.AI_PROVIDER_URL);
}

// Expected AI failures are shown to the caller as-is (see middleware/errorHandler.js).
function exposed(status, message) {
    const err = httpError(status, message);
    err.expose = true;
    return err;
}

async function requestAiPlan(prompt) {
    if (!aiConfigured()) {
        throw exposed(503, 'AI planning is not configured on this server. Ask the operator to set AI_PROVIDER_URL.');
    }
    const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 20000;
    const headers = { 'content-type': 'application/json' };
    if (process.env.AI_PROVIDER_KEY) headers.authorization = `Bearer ${process.env.AI_PROVIDER_KEY}`;

    let res;
    try {
        res = await fetch(process.env.AI_PROVIDER_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ task: 'project_plan', schema_version: 1, prompt }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw exposed(504, 'The AI provider did not answer in time. Try again.');
        }
        throw exposed(502, 'Could not reach the AI provider.');
    }
    if (!res.ok) throw exposed(502, `The AI provider returned status ${res.status}.`);

    let body;
    try {
        body = await res.json();
    } catch {
        throw exposed(502, 'The AI provider returned something that is not JSON.');
    }
    // Validation failures here are provider problems, not user input problems.
    try {
        return validatePlan(body);
    } catch (err) {
        throw exposed(422, `The AI draft did not match the plan format: ${err.message}`);
    }
}

module.exports = { validatePlan, requestAiPlan, aiConfigured, hasDependencyCycle, MAX_TASKS };
