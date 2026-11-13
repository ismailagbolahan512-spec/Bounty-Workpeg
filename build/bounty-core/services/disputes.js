// services/disputes.js — dispute rules: categories, statuses and who may act when.
//
// Any business or worker who is party to a task (or a milestone) may raise a dispute against
// the other party. Administrators decide. Both parties can answer, add evidence, and escalate
// a decision once. Every change is recorded in dispute_events.

const CATEGORIES = [
    ['unfair_rejection', 'Unfair rejection'],
    ['changed_requirements', 'Requirements changed after the work started'],
    ['non_payment', 'Non-payment'],
    ['missed_deadline', 'Missed deadline'],
    ['inadequate_deliverables', 'Inadequate deliverables'],
    ['unreasonable_revisions', 'Unreasonable revision requests'],
    ['unauthorised_scope_change', 'Unauthorised scope change'],
    ['confidentiality_breach', 'Confidentiality breach'],
    ['misrepresentation', 'Misrepresentation'],
    ['other', 'Something else'],
];

const STATUSES = {
    open: 'Open',
    awaiting_response: 'Awaiting response',
    under_review: 'Under review',
    awaiting_evidence: 'Awaiting additional evidence',
    escalated: 'Escalated',
    resolved: 'Resolved',
};

const OUTCOMES = {
    upheld_raiser: 'Decision in favour of the person who raised it',
    upheld_respondent: 'Decision in favour of the other party',
    partial: 'Partly in favour of each party',
    no_action: 'No action required',
};

const ACTIVE = ['open', 'awaiting_response', 'under_review', 'awaiting_evidence', 'escalated'];

// Returns the status after a party or administrator posts a message.
function statusAfterMessage(status, actorIsRespondent) {
    if (status === 'resolved') return null;
    if (status === 'open' || status === 'awaiting_response') return actorIsRespondent ? 'under_review' : status;
    if (status === 'awaiting_evidence') return 'under_review';
    return status;
}

module.exports = { CATEGORIES, STATUSES, OUTCOMES, ACTIVE, statusAfterMessage };
