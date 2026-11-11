// services/criteria.js — acceptance criteria: validation and deterministic checks.
//
// A criterion is { id, text, rule }.
//   rule: null                              -> subjective, needs a human reviewer
//   rule: { type: 'min_words', min: n }     -> description must contain at least n words
//   rule: { type: 'link_required' }         -> a github_link must be present
//   rule: { type: 'link_host', hosts: [..] }-> the link host must match one of hosts
//
// Checks never reject anything. They only report pass / fail / subjective so the
// business can decide. A failed check is a signal, not a verdict.

const { httpError } = require('../middleware/auth');

const MAX_CRITERIA = 10;
const RULE_TYPES = ['min_words', 'link_required', 'link_host'];

function validateCriteria(input) {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw httpError(400, 'acceptance_criteria must be an array');
    if (input.length > MAX_CRITERIA) throw httpError(400, `At most ${MAX_CRITERIA} acceptance criteria`);

    return input.map((c, i) => {
        if (!c || typeof c !== 'object') throw httpError(400, `Criterion ${i + 1} must be an object`);
        const text = typeof c.text === 'string' ? c.text.trim() : '';
        if (text.length < 3 || text.length > 300) {
            throw httpError(400, `Criterion ${i + 1} text must be 3-300 characters`);
        }
        let rule = null;
        if (c.rule !== undefined && c.rule !== null) {
            if (typeof c.rule !== 'object' || !RULE_TYPES.includes(c.rule.type)) {
                throw httpError(400, `Criterion ${i + 1} rule type must be one of: ${RULE_TYPES.join(', ')}`);
            }
            if (c.rule.type === 'min_words') {
                if (!Number.isInteger(c.rule.min) || c.rule.min < 1 || c.rule.min > 5000) {
                    throw httpError(400, `Criterion ${i + 1} min_words must be an integer 1-5000`);
                }
                rule = { type: 'min_words', min: c.rule.min };
            } else if (c.rule.type === 'link_required') {
                rule = { type: 'link_required' };
            } else {
                const hosts = Array.isArray(c.rule.hosts) ? c.rule.hosts : [];
                const clean = hosts
                    .filter((h) => typeof h === 'string')
                    .map((h) => h.trim().toLowerCase())
                    .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
                if (clean.length === 0) {
                    throw httpError(400, `Criterion ${i + 1} link_host needs at least one valid host name`);
                }
                rule = { type: 'link_host', hosts: clean };
            }
        }
        return { id: `c${i + 1}`, text, rule };
    });
}

function hostMatches(host, allowed) {
    return allowed.some((a) => host === a || host.endsWith('.' + a));
}

// submission: { description, github_link }. Returns one result per criterion.
function evaluateCriteria(criteria, submission) {
    const results = (criteria || []).map((c) => {
        if (!c.rule) {
            return { id: c.id, text: c.text, result: 'subjective', reason: 'Needs a manual review.' };
        }
        if (c.rule.type === 'min_words') {
            const words = (submission.description || '').trim().split(/\s+/).filter(Boolean).length;
            return words >= c.rule.min ?
                { id: c.id, text: c.text, result: 'pass', reason: `${words} words (min ${c.rule.min}).` } :
                { id: c.id, text: c.text, result: 'fail', reason: `${words} words, needs ${c.rule.min}.` };
        }
        if (c.rule.type === 'link_required') {
            return submission.github_link ?
                { id: c.id, text: c.text, result: 'pass', reason: 'Link provided.' } :
                { id: c.id, text: c.text, result: 'fail', reason: 'No link provided.' };
        }
        // link_host
        if (!submission.github_link) {
            return { id: c.id, text: c.text, result: 'fail', reason: 'No link provided.' };
        }
        let host = '';
        try {
            host = new URL(submission.github_link).hostname.toLowerCase();
        } catch {
            host = '';
        }
        return hostMatches(host, c.rule.hosts) ?
            { id: c.id, text: c.text, result: 'pass', reason: `Link host ${host} is allowed.` } :
            { id: c.id, text: c.text, result: 'fail', reason: `Link host ${host || 'unknown'} is not on the allowed list.` };
    });

    const hasFail = results.some((r) => r.result === 'fail');
    const hasSubjective = results.some((r) => r.result === 'subjective');
    const overall = hasFail ? 'needs_attention' : hasSubjective ? 'manual_review' : 'checks_passed';
    return { overall, results };
}

module.exports = { validateCriteria, evaluateCriteria, MAX_CRITERIA };
