// services/tokens.js — one-time tokens for email verification and password reset.
// The raw token goes only into the email link. The database keeps a SHA-256 hash,
// so a leaked database cannot be used to log in or reset passwords.

const crypto = require('crypto');
const { pool } = require('../db');

const TTL_MS = {
    verify_email: 24 * 60 * 60 * 1000, // 24 hours
    reset_password: 60 * 60 * 1000, // 1 hour
};

function hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// Creates a token for a user and returns the raw value (for the email link only).
// Older unused tokens of the same purpose are invalidated, so only the newest link works.
async function createAuthToken(userId, purpose) {
    const raw = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TTL_MS[purpose]);

    await pool.query(
        `UPDATE auth_tokens SET used_at = NOW()
         WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]
    );
    await pool.query(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`, [userId, purpose, hashToken(raw), expiresAt]
    );
    return raw;
}

// Marks a token used and returns the user id, or null if it is wrong, expired, or already used.
// The single UPDATE is atomic, so the same link cannot be used twice.
async function consumeAuthToken(raw, purpose) {
    if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return null;

    const { rows } = await pool.query(
        `UPDATE auth_tokens SET used_at = NOW()
         WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
         RETURNING user_id`, [hashToken(raw), purpose]
    );
    return rows.length ? rows[0].user_id : null;
}

module.exports = { createAuthToken, consumeAuthToken };
