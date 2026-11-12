// services/matching.js — AI worker matching. Pure scoring, no database access.
//
// The goal is to prioritise demonstrated ability: verified completed work and verified
// practical assessments count most. Declared skills count less, because they are self-reported.
//
// Factors (weights sum to 1):
//   demonstrated   verified completed work and verified assessments in the task's area   0.45
//   declared       category and skill terms the worker has listed                          0.20
//   availability   weekly hours and start date, when shared                                0.15
//   timezone       closeness of time zones, when both sides shared one                    0.10
//   language       a shared working language, when both sides shared languages            0.10
//
// Never used: nationality, ethnicity, gender, religion, or any other protected characteristic.
// Location is not used at all. A missing field scores neutral, never negative, so a worker is
// not penalised for choosing not to share.

const { significantWords } = require('./verification');

const WEIGHTS = { demonstrated: 0.45, declared: 0.2, availability: 0.15, timezone: 0.1, language: 0.1 };
const MIN_SCORE_TO_SHOW = 10;

// Offset from UTC in hours for an IANA time zone, or null when the zone is not recognised.
function offsetHours(zone, at = new Date()) {
    if (!zone) return null;
    try {
        const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
            .formatToParts(at).find((p) => p.type === 'timeZoneName');
        const m = part && part.value.match(/GMT([+-])(\d{2}):(\d{2})/);
        if (!m) return 0;
        return (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60);
    } catch (err) {
        return null;
    }
}

function validTimezone(zone) {
    return offsetHours(zone) !== null;
}

function clamp(n) {
    return Math.max(0, Math.min(1, n));
}

function demonstrated(worker, task) {
    const industry = (worker.reputation && worker.reputation.industries || []).find((i) => i.industry === task.category);
    const verified = industry ? industry.verified_completed : 0;
    const hasAssessment = (worker.verified_assessment_categories || []).includes(task.category);
    const work = clamp(verified / 5);
    const score = clamp(0.6 * work + 0.4 * (hasAssessment ? 1 : 0));
    const reasons = [];
    if (verified > 0) reasons.push(`${verified} verified completed ${verified === 1 ? 'task' : 'tasks'} in this area`);
    if (hasAssessment) reasons.push('Passed a practical assessment in this area');
    return { score, reasons };
}

function declared(worker, task) {
    const inCategory = (worker.categories || []).includes(task.category);
    const skillTerms = new Set(significantWords(worker.skills));
    const taskTerms = new Set(significantWords(`${task.title || ''} ${task.description || ''}`));
    const overlap = [...taskTerms].filter((t) => skillTerms.has(t));
    const skillScore = clamp(overlap.length / 3);
    const reasons = [];
    if (inCategory) reasons.push('Listed in this category');
    if (overlap.length) reasons.push(`Listed skills match the task (${overlap.slice(0, 3).join(', ')})`);
    return { score: clamp(0.6 * (inCategory ? 1 : 0) + 0.4 * skillScore), reasons };
}

function availability(worker, task, now = new Date()) {
    const reasons = [];
    if (worker.available_from && task.deadline && new Date(worker.available_from) > new Date(task.deadline)) {
        return { score: 0, reasons: ['Not available before this deadline'] };
    }
    if (worker.weekly_hours === null || worker.weekly_hours === undefined) {
        return { score: 0.4, reasons: ['Weekly availability not shared'] };
    }
    const h = Number(worker.weekly_hours);
    let score = 0.3;
    if (h >= 20) score = 1;
    else if (h >= 10) score = 0.8;
    else if (h >= 5) score = 0.5;
    if (h === 0) score = 0;
    reasons.push(h === 0 ? 'Not accepting work at the moment' : `Shares ${h} hours a week`);
    if (worker.available_from && new Date(worker.available_from) > now) reasons.push('Starts on a later date');
    return { score, reasons };
}

function timezone(worker, owner) {
    const wOff = offsetHours(worker.timezone);
    const oOff = offsetHours(owner.timezone);
    if (wOff === null || oOff === null || !worker.timezone || !owner.timezone) {
        return { score: 0.5, reasons: ['Time zone not shared by both sides'] };
    }
    const diff = Math.abs(wOff - oOff);
    if (diff <= 3) return { score: 1, reasons: ['Time zones overlap closely'] };
    if (diff <= 7) return { score: 0.6, reasons: ['Time zones are a workable distance apart'] };
    return { score: 0.3, reasons: ['Time zones are far apart; agree working hours early'] };
}

function language(worker, owner) {
    const wl = (worker.languages || []).map((l) => String(l).trim());
    const ol = (owner.languages || []).map((l) => String(l).trim().toLowerCase());
    if (!wl.length || !ol.length) return { score: 0.5, reasons: ['Working languages not shared by both sides'] };
    const shared = wl.filter((l) => ol.includes(l.toLowerCase()));
    if (shared.length) return { score: 1, reasons: [`Shares a working language (${shared[0]})`] };
    return { score: 0.3, reasons: ['No shared working language listed'] };
}

// worker: { categories, skills, timezone, languages, weekly_hours, available_from, reputation, verified_assessment_categories }
// task:   { title, description, category, deadline }
// owner:  { timezone, languages }
function scoreMatch(worker, task, owner, now = new Date()) {
    const parts = {
        demonstrated: demonstrated(worker, task),
        declared: declared(worker, task),
        availability: availability(worker, task, now),
        timezone: timezone(worker, owner),
        language: language(worker, owner),
    };
    let total = 0;
    const factors = {};
    const reasons = [];
    for (const key of Object.keys(WEIGHTS)) {
        total += WEIGHTS[key] * parts[key].score;
        factors[key] = Math.round(parts[key].score * 100);
        reasons.push(...parts[key].reasons.filter(Boolean));
    }
    return { score: Math.round(total * 100), factors, reasons };
}

function rank(items, limit) {
    return items.filter((i) => i.score >= MIN_SCORE_TO_SHOW)
        .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
        .slice(0, limit);
}

module.exports = { scoreMatch, rank, offsetHours, validTimezone, WEIGHTS, MIN_SCORE_TO_SHOW };
