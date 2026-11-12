// services/budget.js — budget planning estimates for a business.
//
// These are planning estimates from stated assumptions, not market data. They do not claim
// to reflect what workers are paid in any market. The business keeps control of the budget.
// The hourly range below is an assumption to be replaced by verified rates when they exist.

const ASSUMPTIONS = {
    hourly_ngn: { low: 2500, high: 6000 },
    productive_hours_per_day: 6,
};

const BASE_HOURS = { dev: 8, design: 6, content: 4, marketing: 5, other: 4 };
const DIFFICULTY = { easy: 1, medium: 1.8, hard: 3 };
const TEAM_OVERHEAD_PER_EXTRA_WORKER = 0.05;
const TEAM_OVERHEAD_CAP = 0.3;

function hourText(n) {
    return n === 1 ? '1 hour' : `${n} hours`;
}

function roundMoney(n) {
    return Math.round(n / 100) * 100;
}

function deliverableCount(text) {
    return String(text || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).length;
}

// Pure function. input: { category, difficulty, description, deliverables, criteria_count,
// revision_rounds, requires_authorization, execution_mode, workers, deadline_days, reward }
function estimateBudget(input) {
    const category = BASE_HOURS[input.category] ? input.category : 'other';
    const difficulty = DIFFICULTY[input.difficulty] ? input.difficulty : 'medium';
    const factors = [];

    let hours = BASE_HOURS[category];
    factors.push(`Base effort for ${category === 'dev' ? 'development' : category} work: ${hourText(BASE_HOURS[category])}.`);

    hours *= DIFFICULTY[difficulty];
    factors.push(`${difficulty[0].toUpperCase() + difficulty.slice(1)} difficulty multiplies the base effort by ${DIFFICULTY[difficulty]}.`);

    const words = String(input.description || '').trim().split(/\s+/).filter(Boolean).length;
    const extraWords = Math.max(0, words - 150);
    const wordHours = Math.min(6, Math.round((extraWords / 100) * 0.5 * 10) / 10);
    if (wordHours > 0) {
        hours += wordHours;
        factors.push(`A detailed description adds ${hourText(wordHours)} of scoping.`);
    }

    const deliverables = Math.min(10, deliverableCount(input.deliverables));
    const deliverableHours = Math.min(4, deliverables * 0.5);
    if (deliverableHours > 0) {
        hours += deliverableHours;
        factors.push(`${deliverables} listed deliverable${deliverables === 1 ? '' : 's'} add ${hourText(deliverableHours)}.`);
    }

    const criteria = Math.min(20, Math.max(0, Number(input.criteria_count) || 0));
    const criteriaHours = Math.min(2, criteria * 0.25);
    if (criteriaHours > 0) {
        hours += criteriaHours;
        factors.push(`${criteria} acceptance criteria add ${hourText(criteriaHours)} of checking.`);
    }

    const revisions = Math.min(5, Math.max(0, Number(input.revision_rounds) || 0));
    if (revisions > 0) {
        hours += revisions;
        factors.push(`${revisions} planned revision round${revisions === 1 ? '' : 's'} add ${hourText(revisions)}.`);
    }

    if (input.requires_authorization) {
        hours = hours * 1.5 + 2;
        factors.push('Security work needs authorisation checks and careful review, adding 50% and 2 hours.');
    }

    const workers = Math.min(50, Math.max(1, Number(input.workers) || 1));
    if (input.execution_mode === 'team' && workers > 1) {
        const overhead = Math.min(TEAM_OVERHEAD_CAP, (workers - 1) * TEAM_OVERHEAD_PER_EXTRA_WORKER);
        hours *= 1 + overhead;
        factors.push(`Coordinating ${workers} workers adds ${Math.round(overhead * 100)}% for handovers.`);
    }

    hours = Math.round(hours * 10) / 10;
    const low = Math.round(hours * 0.8 * 10) / 10;
    const high = Math.round(hours * 1.25 * 10) / 10;

    const complexity = hours <= 4 ? 'simple' : hours <= 12 ? 'moderate' : 'complex';
    const recommended = {
        low: roundMoney(low * ASSUMPTIONS.hourly_ngn.low),
        high: roundMoney(high * ASSUMPTIONS.hourly_ngn.high),
    };
    const days = {
        low: Math.max(1, Math.ceil(low / ASSUMPTIONS.productive_hours_per_day)),
        high: Math.max(1, Math.ceil(high / ASSUMPTIONS.productive_hours_per_day)),
    };

    const warnings = [];
    const reward = input.reward === undefined || input.reward === null || input.reward === '' ? null : Number(input.reward);
    if (reward !== null && reward < recommended.low * 0.6) {
        warnings.push('This reward looks low for the work described. Check the scope or raise the budget before publishing.');
    }
    if (reward !== null && reward > recommended.high * 2) {
        warnings.push('This reward is well above the estimate. Confirm it reflects the work.');
    }
    if (input.deadline_days !== undefined && input.deadline_days !== null && input.deadline_days < days.low) {
        warnings.push(`The deadline may be too short. This work is estimated at ${days.low} to ${days.high} working days.`);
    }

    return {
        complexity,
        estimated_hours: { low, high },
        estimated_days: days,
        recommended_range: recommended,
        reward_check: reward === null ? null : (warnings.length ? 'review' : 'within_estimate'),
        warnings,
        factors,
        assumptions: [
            `Planning rate assumed between NGN ${ASSUMPTIONS.hourly_ngn.low.toLocaleString('en-NG')} and NGN ${ASSUMPTIONS.hourly_ngn.high.toLocaleString('en-NG')} per hour.`,
            `Assumes ${ASSUMPTIONS.productive_hours_per_day} productive hours per working day.`,
            'These are planning estimates, not verified market rates. You make the final budget decision.',
        ],
        source: 'planning_estimate',
    };
}

module.exports = { estimateBudget, ASSUMPTIONS, BASE_HOURS, DIFFICULTY };
