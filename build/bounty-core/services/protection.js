// services/protection.js — Creator Protection agreements, task NDAs and audit logging.
//
// The agreement texts below are DRAFTS. They must be reviewed by a qualified Nigerian
// intellectual-property and confidentiality lawyer before production launch. They do not
// guarantee enforceability; they state Bounty's terms and record that each user accepted
// the exact wording (SHA-256 pinned per acceptance).

const crypto = require('crypto');
const { httpError } = require('../middleware/auth');
const { pool } = require('../db');

const DRAFT_NOTICE = 'DRAFT: pending review by a qualified Nigerian IP lawyer before production launch.';

const AGREEMENTS = {
    creator_protection_business: {
        version: '2026-11-05-draft1',
        title: 'Creator Protection Agreement (for businesses)',
        body: [
            DRAFT_NOTICE,
            '',
            '1. Viewing a submission does not give you ownership of it or any right to use it commercially.',
            '2. You may not use, reproduce, distribute, modify, trace, recreate or otherwise exploit a submission you have not paid for, without the written authorisation of its creator.',
            '3. Using AI tools to upscale, remove watermarks from, modify or recreate a submission does not give you any usage right in it.',
            '4. You acquire contractual rights in the selected deliverable only after you have paid the agreed reward and Bounty has verified that payment, on the terms stated on the task.',
            '5. Submissions that are not selected remain the property of their creators.',
            '6. Unauthorised use may result in restriction or suspension of your Bounty account, contractual claims, and legal proceedings under applicable law.',
            '7. Bounty records evidence and applies its own platform rules. Bounty does not itself enforce intellectual-property rights and does not guarantee the outcome of any claim.',
            '8. Bounty is governed by the laws of the Federal Republic of Nigeria, and by any other law that applies to your use of the platform.',
        ].join('\n'),
    },
    worker_submission_ip: {
        version: '2026-11-05-draft1',
        title: 'Worker Submission and Intellectual Property Agreement',
        body: [
            DRAFT_NOTICE,
            '',
            '1. You keep ownership of your original work. Submitting does not transfer any intellectual property to the business or to Bounty.',
            '2. A transfer or licence takes effect only if it is the selected deliverable of a task and the reward has been paid, on the terms stated on that task.',
            '3. Unsuccessful submissions remain yours. You can keep them and reuse them.',
            '4. Your submission is stored privately and is not published. Bounty records timestamps and a SHA-256 fingerprint of what you submitted as evidence.',
            '5. You can report unauthorised use of your work through Bounty, and request access to the submission evidence and dispute records that relate to your work.',
            '6. You confirm that you have the rights to what you submit and that it does not infringe anyone else\'s rights.',
            '7. Bounty does not give legal advice. Copyright is governed by applicable law, including the Nigerian Copyright Act 2022.',
        ].join('\n'),
    },
    task_nda: {
        version: '2026-11-05-draft1',
        title: 'Task Confidentiality Agreement (NDA)',
        body: [
            DRAFT_NOTICE,
            '',
            'Confidential Information means non-public information that the business designates as confidential for a specific task and makes available to you through Bounty. It can include documents, source code, trade secrets, internal strategies, and non-public client information.',
            '',
            'Exclusions. Confidential Information does not include information that: (a) is or becomes publicly available without your breach; (b) you lawfully knew without an obligation of confidence before receiving it; (c) you independently developed without using the Confidential Information; (d) you lawfully receive from a third party with no duty of confidence; or (e) is general skill, know-how or experience you would have gained anyway.',
            '',
            'Your obligations. You will: (a) not disclose Confidential Information to anyone outside the task; (b) use it only for the task you were assigned; (c) not reproduce, distribute or commercially exploit it; (d) keep copies only as the task requires and delete them when the task ends or the business asks.',
            '',
            'Access. Your access ends when you are removed from the task or the task closes. Your obligations continue after that.',
            '',
            'Duration. These obligations continue for two (2) years after the task closes. For trade secrets, they continue for as long as the information remains a trade secret under applicable law.',
            '',
            'Your rights. Nothing in this agreement prevents you from: using your general skills and experience; reporting possible crimes or unlawful conduct to a regulator, law enforcement, or your legal adviser; or exercising any right that the law protects, including whistleblowing protections.',
            '',
            'Incidents. If you accidentally disclose Confidential Information, or become aware of a security incident involving it, report it through Bounty promptly.',
            '',
            'Remedies. Bounty may restrict your access to Confidential Information. The business may pursue any remedy available under applicable law. This agreement does not set any penalty.',
        ].join('\n'),
    },
};

const KINDS = Object.keys(AGREEMENTS);

function bodyHash(kind) {
    return crypto.createHash('sha256').update(AGREEMENTS[kind].body, 'utf8').digest('hex');
}

// Public view of the current agreements, including the hash that acceptances record.
function agreementCatalogue() {
    return KINDS.map((kind) => ({
        kind,
        version: AGREEMENTS[kind].version,
        title: AGREEMENTS[kind].title,
        body: AGREEMENTS[kind].body,
        body_sha256: bodyHash(kind),
    }));
}

// Runs a query on a pool or a client. Keeps the helpers usable inside transactions.
async function hasAcceptance(q, userId, kind, bountyId = null) {
    const { rows } = await q(
        `SELECT 1 FROM agreement_acceptances
         WHERE user_id = $1 AND kind = $2 AND version = $3
           AND bounty_id IS NOT DISTINCT FROM $4::uuid
         LIMIT 1`,
        [userId, kind, AGREEMENTS[kind].version, bountyId]
    );
    return rows.length > 0;
}

// Throws 428 with the agreement text so the frontend can show it and retry.
async function requireAgreement(q, userId, kind, bountyId = null) {
    if (await hasAcceptance(q, userId, kind, bountyId)) return;
    const a = AGREEMENTS[kind];
    const code = kind === 'task_nda' ? 'nda_required' : 'agreement_required';
    throw httpError(428, kind === 'task_nda'
        ? 'Accept the confidentiality agreement (NDA) for this task first'
        : `Accept the ${a.title} first`, {
        code, kind, version: a.version, title: a.title, body: a.body,
        body_sha256: bodyHash(kind), bounty_id: bountyId,
    });
}

// Records an acceptance. Duplicate acceptance of the same version is a no-op.
async function recordAcceptance(q, userId, kind, bountyId = null) {
    const a = AGREEMENTS[kind];
    await q(
        `INSERT INTO agreement_acceptances (user_id, kind, version, body_sha256, bounty_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [userId, kind, a.version, bodyHash(kind), bountyId]
    );
}

// A worker may see restricted task material only with an accepted NDA for that task
// AND an active place on it. Owners and admins are handled by the callers.
async function canAccessConfidential(q, workerId, bountyId) {
    const { rows } = await q(
        `SELECT 1
         FROM bounty_participants p
         JOIN bounties b ON b.id = p.bounty_id
         WHERE p.bounty_id = $1 AND p.worker_id = $2
           AND p.status IN ('active', 'assigned')
           AND b.confidential = TRUE
           AND EXISTS (
             SELECT 1 FROM agreement_acceptances a
             WHERE a.user_id = $2 AND a.kind = 'task_nda'
               AND a.version = $3 AND a.bounty_id = $1
           )`,
        [bountyId, workerId, AGREEMENTS.task_nda.version]
    );
    return rows.length > 0;
}

// Append-only audit record. Never log passwords, tokens or payment details here.
async function logAudit(q, actorId, action, entityType, entityId, details = {}) {
    await q(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [actorId || null, action, entityType, entityId || null, JSON.stringify(details)]
    );
}

// Re-reads the account status, so a suspension applies at once, not at token expiry.
async function currentAccountStatus(userId) {
    const { rows } = await pool.query('SELECT account_status FROM users WHERE id = $1', [userId]);
    return rows[0] ? rows[0].account_status : 'suspended';
}

// Blocks publishing, submitting and taking tasks for restricted or suspended accounts.
// Suspended users can still read and appeal.
async function assertActiveAccount(userId) {
    const status = await currentAccountStatus(userId);
    if (status === 'restricted') {
        throw httpError(403, 'Your account is restricted from this action. You can appeal from your account.');
    }
    if (status === 'suspended') {
        throw httpError(403, 'Your account is suspended. You can still appeal the decision.');
    }
    if (status === 'terminated') {
        throw httpError(403, 'This account has been terminated.');
    }
}

// Throws 403 unless a worker on a confidential task holds an accepted NDA and an active place.
// Used by every workspace path, so a removed worker loses messages and deliverables too.
async function assertConfidentialAccess(q, bountyId, userId, confidential) {
    if (!confidential) return;
    if (!(await canAccessConfidential(q, userId, bountyId))) {
        throw httpError(403, 'This task is confidential. Accept its NDA and keep an active place on it to see this.');
    }
}

module.exports = {
    assertConfidentialAccess,
    AGREEMENTS,
    KINDS,
    DRAFT_NOTICE,
    agreementCatalogue,
    bodyHash,
    hasAcceptance,
    requireAgreement,
    recordAcceptance,
    canAccessConfidential,
    logAudit,
    currentAccountStatus,
    assertActiveAccount,
};
