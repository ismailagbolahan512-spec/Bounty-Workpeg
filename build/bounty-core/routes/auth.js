// routes/auth.js — signup, signin, email verification, password reset
//
// POST /api/auth/signup
//   Body:     { "email": "a@b.com", "password": "secret123", "name": "Ada", "role": "worker" }
//   Response: { "id", "email", "name", "role", "email_verified": false, "token": "<jwt>" }
//   Sends a verification email (signup still succeeds if the email cannot be sent).
//
// POST /api/auth/signin
//   Body:     { "email": "a@b.com", "password": "secret123" }
//   Response: same shape as signup.
//
// POST /api/auth/verify                 Body: { "token": "<from email>" }
// POST /api/auth/resend-verification    (signed in) sends a new verification email
// POST /api/auth/forgot                 Body: { "email": "a@b.com" }  always returns the same message
// POST /api/auth/reset                  Body: { "token": "<from email>", "password": "newpass123" }

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, setSessionCookie, clearSessionCookie, verifyToken, readSessionToken, httpError, authenticate } = require('../middleware/auth');
const { sendEmail, appUrl } = require('../services/email');
const { createAuthToken, consumeAuthToken } = require('../services/tokens');
const { lockedSeconds, recordFailure, clearFailures } = require('../middleware/signin-limit');
const { revokeAllForUser } = require('../services/integration-tokens');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['worker', 'business'];
const BCRYPT_ROUNDS = 12;
const GENERIC_FORGOT = 'If an account exists for that email, a reset link has been sent.';

function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, email_verified: !!u.email_verified, is_admin: u.is_admin === true };
}

async function sendVerificationEmail(userId, email) {
    const raw = await createAuthToken(userId, 'verify_email');
    await sendEmail({
        to: email,
        subject: 'Confirm your Bounty email',
        text: `Welcome to Bounty.\n\nConfirm your email address by opening this link:\n${appUrl()}/#/verify?token=${raw}\n\nThe link expires in 24 hours.`,
    });
}

// Shared rule for new passwords (sign-up and reset). bcrypt only uses the first 72 bytes, so a
// longer password would silently lose its tail; the cap keeps the rule honest.
function validatePassword(password) {
    if (typeof password !== 'string') throw httpError(400, 'Password is required');
    if (password.length < 10) throw httpError(400, 'Password must be at least 10 characters');
    if (Buffer.byteLength(password, 'utf8') > 72) throw httpError(400, 'Password must be at most 72 bytes');
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        throw httpError(400, 'Password must include at least one letter and one number');
    }
}

// ------------------------------------------------ POST /logout
// Clears the session cookie. When the caller has a valid session, every session issued before
// now is revoked, so a copied token stops working too.
router.post('/logout', async(req, res, next) => {
    try {
        clearSessionCookie(res);
        const token = readSessionToken(req);
        if (token) {
            try {
                const payload = verifyToken(token);
                await pool.query('UPDATE users SET tokens_valid_after = $2 WHERE id = $1', [payload.sub, new Date()]);
                // Logging out also ends the user's Workpeg links (design section 3.5).
                await revokeAllForUser(payload.sub, 'logout');
            } catch {
                // An expired or invalid token has nothing to revoke.
            }
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /signup
router.post('/signup', async(req, res, next) => {
    try {
        const { email, password, name, role } = req.body || {};

        if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
            throw httpError(400, 'A valid email is required');
        }
        validatePassword(password);
        if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100) {
            throw httpError(400, 'Name must be 2-100 characters');
        }
        if (!ROLES.includes(role)) {
            throw httpError(400, `Role must be one of: ${ROLES.join(', ')}`);
        }

        const normalizedEmail = email.trim().toLowerCase();
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        let user;
        try {
            const { rows } = await pool.query(
                `INSERT INTO users (email, password_hash, name, role)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, email, name, role`, [normalizedEmail, passwordHash, name.trim(), role]
            );
            user = rows[0];
        } catch (err) {
            if (err.code === '23505') { // unique_violation
                throw httpError(409, 'An account with this email already exists');
            }
            throw err;
        }

        // Best effort: a mail failure must not block signup. The user can resend from the app.
        sendVerificationEmail(user.id, user.email).catch((err) => {
            console.error('✗ Verification email failed:', err.message);
        });

        const token = signToken(user);
        setSessionCookie(res, token);
        res.status(201).json({...publicUser({...user, email_verified: false }), token });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /signin
router.post('/signin', async(req, res, next) => {
    try {
        const { email, password } = req.body || {};
        if (typeof email !== 'string' || typeof password !== 'string') {
            throw httpError(400, 'Email and password are required');
        }

        // Too many recent failures for this account: refuse, even with the right password.
        const waitSeconds = lockedSeconds(email, req.ip);
        if (waitSeconds) {
            res.set('Retry-After', String(waitSeconds));
            throw httpError(429, 'Too many failed sign-in attempts for this account. Try again later.');
        }

        const { rows } = await pool.query(
            `SELECT id, email, name, role, password_hash, (email_verified_at IS NOT NULL) AS email_verified, is_admin
             FROM users WHERE email = $1`, [email.trim().toLowerCase()]
        );

        // Identical response for "no such user" and "wrong password":
        // do not leak which accounts exist.
        const GENERIC = 'Invalid email or password';
        if (rows.length === 0) {
            recordFailure(email, req.ip);
            throw httpError(401, GENERIC);
        }

        const ok = await bcrypt.compare(password, rows[0].password_hash);
        if (!ok) {
            recordFailure(email, req.ip);
            throw httpError(401, GENERIC);
        }
        clearFailures(email, req.ip);

        const token = signToken(rows[0]);
        setSessionCookie(res, token);
        res.json({...publicUser(rows[0]), token });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /verify
router.post('/verify', async(req, res, next) => {
    try {
        const userId = await consumeAuthToken(req.body && req.body.token, 'verify_email');
        if (!userId) throw httpError(400, 'This verification link is invalid or has expired.');

        await pool.query(
            `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
             WHERE id = $1`, [userId]
        );
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------ POST /resend-verification
router.post('/resend-verification', authenticate, async(req, res, next) => {
    try {
        if (req.user.email_verified_at) {
            return res.json({ ok: true, already_verified: true });
        }
        // Here a failure is shown to the user, so they know the email did not go out.
        await sendVerificationEmail(req.user.id, req.user.email);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /forgot
router.post('/forgot', async(req, res, next) => {
    try {
        const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email)) throw httpError(400, 'A valid email is required');

        const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
        if (rows.length > 0) {
            // Errors are logged, never shown, so the response cannot reveal whether the account exists.
            try {
                const raw = await createAuthToken(rows[0].id, 'reset_password');
                await sendEmail({
                    to: rows[0].email,
                    subject: 'Reset your Bounty password',
                    text: `We got a request to reset your Bounty password.\n\nOpen this link to choose a new one:\n${appUrl()}/#/reset?token=${raw}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email. Your password will not change.`,
                });
            } catch (err) {
                console.error('✗ Password reset email failed:', err.message);
            }
        }
        res.json({ ok: true, message: GENERIC_FORGOT });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------ POST /reset
router.post('/reset', async(req, res, next) => {
    try {
        const { token, password } = req.body || {};
        validatePassword(password);

        const userId = await consumeAuthToken(token, 'reset_password');
        if (!userId) throw httpError(400, 'This reset link is invalid or has expired. Request a new one.');

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await pool.query(
            `UPDATE users
             SET password_hash = $1, password_changed_at = $3, updated_at = NOW()
             WHERE id = $2`, [passwordHash, userId, new Date()]
        );
        // Logged-in sessions on other devices stop working (see authenticate).
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
