// services/integration-tokens.js — scoped, revocable tokens for Workpeg.
// Design: docs/workpeg-identity-design.md. Schema: migrations 024 and 025.
// Only a SHA-256 hash of a token is stored. The plaintext is returned once, at issue.
// This file must not require middleware/auth.js (auth requires it, so that would be circular).

const crypto = require('crypto');
const { pool } = require('../db');

const TOKEN_PREFIX = 'bnt_wp_';
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const CONFIRM_MINUTES = 15;
const MAX_PAYLOAD_BYTES = 4096;

// Which roles may hold each scope. Checked at issue and again on every request, so a role
// change takes effect at once. Admins hold no integration scopes.
const SCOPE_ROLES = {
    'bounties:read': ['worker', 'business'],
    'bounties:draft': ['business'],
    'bounties:publish': ['business'],
    'applications:write': ['worker'],
    'submissions:write': ['worker'],
    'workspace:read': ['worker', 'business'],
};
// Scopes that run only with the user's explicit approval in Bounty (design section 3.4).
const SENSITIVE_SCOPES = ['bounties:publish', 'applications:write', 'submissions:write'];

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function hashToken(plain) {
    return crypto.createHash('sha256').update(plain).digest('hex');
}

function roleAllows(role, scope) {
    const roles = SCOPE_ROLES[scope];
    return Array.isArray(roles) && roles.includes(role);
}

function validateScopes(role, scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > Object.keys(SCOPE_ROLES).length) {
        throw httpError(400, 'Choose at least one scope');
    }
    const unique = [...new Set(scopes)];
    for (const scope of unique) {
        if (!Object.prototype.hasOwnProperty.call(SCOPE_ROLES, scope)) {
            throw httpError(400, `Unknown scope: ${String(scope).slice(0, 50)}`);
        }
        if (!roleAllows(role, scope)) {
            throw httpError(403, `Your role cannot hold the ${scope} scope`);
        }
    }
    return unique;
}

function validateDays(days) {
    const n = days === undefined ? DEFAULT_DAYS : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
        throw httpError(400, `Lifetime must be between 1 and ${MAX_DAYS} days`);
    }
    return n;
}

// Stable JSON: keys sorted at every level, so the same payload always hashes the same.
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// The approval covers the action AND the payload together, so neither can change after approval
// without the hash no longer matching (design section 3.4).
function confirmationHash(action, payload) {
    const text = stableStringify({ action, payload });
    if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw httpError(413, 'Payload is too large');
    return crypto.createHash('sha256').update(text).digest('hex');
}

// Issues a token. `client` is a pool or a transaction client.
async function issueToken(client, { userId, role, label, scopes, days, rotatedFrom = null }) {
    const cleanLabel = typeof label === 'string' ? label.trim() : '';
    if (cleanLabel.length < 1 || cleanLabel.length > 100) throw httpError(400, 'Label must be 1 to 100 characters');
    const cleanScopes = validateScopes(role, scopes);
    const lifetime = validateDays(days);
    const plain = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const { rows } = await client.query(
        `INSERT INTO integration_tokens (user_id, token_hash, label, scopes, expires_at, rotated_from)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::INTERVAL, $6)
         RETURNING id, scopes, issued_at, expires_at`,
        [userId, hashToken(plain), cleanLabel, cleanScopes, String(lifetime), rotatedFrom]
    );
    return { ...rows[0], token: plain };
}

// Finds a token that is valid right now, with its owner. Returns null for unknown, revoked or
// expired tokens. Owner account state and password changes are checked by the caller.
async function loadActiveToken(plain) {
    if (typeof plain !== 'string' || !plain.startsWith(TOKEN_PREFIX)) return null;
    const { rows } = await pool.query(
        `SELECT t.id, t.user_id, t.scopes, t.issued_at, t.expires_at,
                u.email, u.name, u.role, u.is_admin, u.account_status, u.password_changed_at
         FROM integration_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW()`,
        [hashToken(plain)]
    );
    return rows[0] || null;
}

async function listTokens(userId) {
    const { rows } = await pool.query(
        `SELECT id, label, scopes, issued_at, expires_at, last_used_at, revoked_at, revoked_reason, rotated_from
         FROM integration_tokens WHERE user_id = $1 ORDER BY issued_at DESC`,
        [userId]
    );
    return rows;
}

// Revokes one token belonging to the user. Returns true when a live token was revoked.
async function revokeToken(userId, tokenId, reason) {
    const { rowCount } = await pool.query(
        `UPDATE integration_tokens SET revoked_at = NOW(), revoked_reason = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [tokenId, userId, String(reason).slice(0, 200)]
    );
    return rowCount === 1;
}

async function revokeAllForUser(userId, reason) {
    await pool.query(
        `UPDATE integration_tokens SET revoked_at = NOW(), revoked_reason = $2
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId, String(reason).slice(0, 200)]
    );
}

// Rotation: revokes the old token and issues a new one with the same scopes, in one transaction.
// Returns null when the token is not the user's live token.
async function rotateToken(userId, role, tokenId, days) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, label, scopes FROM integration_tokens
             WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE`,
            [tokenId, userId]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }
        const old = rows[0];
        await client.query(
            `UPDATE integration_tokens SET revoked_at = NOW(), revoked_reason = 'rotated' WHERE id = $1`,
            [old.id]
        );
        const issued = await issueToken(client, {
            userId, role, label: old.label, scopes: old.scopes, days: days === undefined ? DEFAULT_DAYS : days, rotatedFrom: old.id,
        });
        await client.query('COMMIT');
        return issued;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// Requests a confirmation for a sensitive action. The token may only ask for scopes it holds.
async function requestConfirmation({ tokenId, action, payload }) {
    if (!SENSITIVE_SCOPES.includes(action)) throw httpError(400, 'This action does not need confirmation');
    const hash = confirmationHash(action, payload);
    const { rows } = await pool.query(
        `INSERT INTO integration_confirmations (token_id, action, payload_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::INTERVAL)
         RETURNING id, action, expires_at`,
        [tokenId, action, hash, String(CONFIRM_MINUTES)]
    );
    return rows[0];
}

// Approves a pending confirmation for the user who owns its token. Single use, before expiry.
async function approveConfirmation(userId, confirmationId) {
    const { rowCount, rows } = await pool.query(
        `UPDATE integration_confirmations c SET approved_at = NOW()
         FROM integration_tokens t
         WHERE c.id = $1 AND t.id = c.token_id AND t.user_id = $2
           AND c.approved_at IS NULL AND c.consumed_at IS NULL AND c.expires_at > NOW()
         RETURNING c.id, c.action, c.expires_at`,
        [confirmationId, userId]
    );
    return rowCount === 1 ? rows[0] : null;
}

// Used by each sensitive action, in the same transaction as the action itself. Succeeds once,
// only for the exact action and payload that the user approved, before expiry.
async function consumeConfirmation(client, { confirmationId, tokenId, action, payload }) {
    const { rowCount } = await client.query(
        `UPDATE integration_confirmations SET consumed_at = NOW()
         WHERE id = $1 AND token_id = $2 AND action = $3 AND payload_hash = $4
           AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW()`,
        [confirmationId, tokenId, action, confirmationHash(action, payload)]
    );
    return rowCount === 1;
}

module.exports = {
    TOKEN_PREFIX, DEFAULT_DAYS, MAX_DAYS, CONFIRM_MINUTES, SCOPE_ROLES, SENSITIVE_SCOPES,
    hashToken, roleAllows, validateScopes, stableStringify, confirmationHash,
    issueToken, loadActiveToken, listTokens, revokeToken, revokeAllForUser, rotateToken,
    requestConfirmation, approveConfirmation, consumeConfirmation,
};
