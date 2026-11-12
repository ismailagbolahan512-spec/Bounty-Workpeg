// services/verification.js — smart task verification reports.
//
// A report explains whether a submission appears to meet the task. It is advisory:
// it never changes a submission's status, and the business makes every decision.
// Outcomes:
//   pass          every check passed and the task is not security work
//   fail          a deterministic check failed, or the description is missing
//   needs_review  anything else; this includes all security work, which is never auto-passed
//
// Security work is never confirmed by an AI report, because a convincing write-up is not
// evidence of authorised, correct testing. A qualified human must review it.

const MIN_DESCRIPTION_WORDS = 10;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'our', 'are', 'was', 'will', 'into', 'task', 'work', 'make', 'build']);

const MODE_NOTES = {
    first_valid: 'Only a verified submission can win this task. Confirm the report before you approve, because the first approval closes the task.',
    competitive: 'Compare this submission with the others before you choose winners.',
    team: 'Check this component against its milestone criteria and its dependencies.',
    independent: 'This counts toward the target only once you accept it. Each accepted report is paid separately.',
};

function significantWords(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((w) => !STOP_WORDS.has(w)) || [];
}

// Pure function. `check` is the result of runSubmissionCheck (criteria + optional AI).
function buildVerification({ submission, bounty, check, executionMode }) {
    const checks = [];
    const words = String(submission.description || '').trim().split(/\s+/).filter(Boolean).length;

    if (words < MIN_DESCRIPTION_WORDS) {
        checks.push({ id: 'documentation', text: 'Work is documented', status: 'confirmed_fail', source: 'automatic', reason: `Only ${words} words describe the work. At least ${MIN_DESCRIPTION_WORDS} are needed.` });
    } else {
        checks.push({ id: 'documentation', text: 'Work is documented', status: 'passed', source: 'automatic', reason: `${words} words describe the work.` });
    }

    // Relevance: a heuristic that asks a person to look. It never rejects anything.
    const taskWords = significantWords(`${bounty.title} ${bounty.description || ''}`);
    const subjectWords = new Set(significantWords(`${submission.title || ''} ${submission.description || ''}`));
    const overlap = taskWords.filter((w) => subjectWords.has(w));
    if (taskWords.length >= 2) {
        checks.push(overlap.length > 0 ?
            { id: 'relevance', text: 'Relevant to the task', status: 'passed', source: 'automatic', reason: `Shares terms with the task (${[...new Set(overlap)].slice(0, 3).join(', ')}).` } :
            { id: 'relevance', text: 'Relevant to the task', status: 'possible_issue', source: 'automatic', reason: 'Shares no key terms with the task title or description. Check that it answers this task.' });
    }

    for (const item of check.results) checks.push(item);

    if (bounty.requires_authorization) {
        checks.push({ id: 'security_review', text: 'Qualified security review', status: 'not_checked', source: 'none', reason: 'Security work needs a qualified human reviewer. No report can confirm it.' });
    }

    const confirmedFail = checks.some((c) => c.status === 'confirmed_fail');
    const allPassed = checks.every((c) => c.status === 'passed');
    let outcome;
    if (confirmedFail) outcome = 'fail';
    else if (allPassed && !bounty.requires_authorization) outcome = 'pass';
    else outcome = 'needs_review';

    const counts = { passed: 0, confirmed_fail: 0, possible_issue: 0, not_checked: 0 };
    checks.forEach((c) => { counts[c.status] += 1; });

    const reasons = {
        pass: 'Every check passed. You still make the final decision.',
        fail: 'At least one required check failed. Confirm this before you decide.',
        needs_review: 'A person should review this before a decision. Some checks could not be confirmed automatically.',
    };

    return {
        outcome,
        requires_human_review: outcome !== 'pass',
        summary: reasons[outcome],
        mode_note: MODE_NOTES[executionMode] || null,
        execution_mode: executionMode,
        security: Boolean(bounty.requires_authorization),
        counts,
        checks,
        ai_used: check.ai_used,
        ai_error: check.ai_error,
        notes: [...check.notes, 'This report is advisory. It never approves or rejects a submission.'],
        checked_at: new Date().toISOString(),
    };
}

module.exports = { buildVerification, significantWords, MIN_DESCRIPTION_WORDS };
