// middleware/auth.js — JWT authentication + role authorization
// Requires env vars: JWT_SECRET
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const integration = require('../services/integration-tokens');

const TOKEN_TTL = '7d';
const TOKEN_ISSUER = 'bounty-api';
const TOKEN_AUDIENCE = 'bounty-web';
const SESSION_COOKIE = 'bounty_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// details (optional) is returned to the client alongside the message. Used by the
// 428 agreement gates so the frontend can show the text and retry.
function httpError(status, message, details) {
    const err = new Error(message);
    err.status = status;
    if (details) err.details = details;
    return err;
}

// Create a signed token. Payload stays minimal — role is re-read
// from the DB on every request so a changed role takes effect
// immediately instead of living forever inside an old token.
// True when the token was issued at or before `revokedAt`. Tokens minted
// before iat_ms existed fall back to the start of their issue second, which
// errs towards rejecting them.
function issuedBefore(payload, revokedAt) {
    if (!revokedAt) return false;
    const issuedMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : payload.iat * 1000;
    return issuedMs <= new Date(revokedAt).getTime();
}

function signToken(user) {
    // iat_ms: millisecond issue time, so revocation can be exact. JWT iat
    // alone only has whole-second precision.
    return jwt.sign({ sub: user.id, iat_ms: Date.now() }, process.env.JWT_SECRET, {
        expiresIn: TOKEN_TTL, algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE,
    });
}

function verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'], issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE,
    });
}

// The session lives in an HttpOnly cookie, so page scripts cannot read it. The JSON token is
// still returned for API clients that send a Bearer header.
function setSessionCookie(res, token) {
    const parts = [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
        `Max-Age=${7 * 24 * 60 * 60}`,
    ];
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function readCookie(header, name) {
    if (!header) return null;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i !== -1 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

// Authentication: verifies the Bearer token, loads the fresh user
// row, and attaches it as req.user. Rejects cleanly otherwise.
async function authenticate(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const [scheme, bearer] = header.split(' ');
        let token = scheme === 'Bearer' && bearer ? bearer : null;
        let viaCookie = false;
        if (!token) {
            token = readCookie(req.headers.cookie, SESSION_COOKIE);
            viaCookie = Boolean(token);
        }
        if (!token) {
            throw httpError(401, 'Missing or malformed Authorization header');
        }
        // Workpeg tokens are scoped and only accepted on /api/peg (see authenticateIntegration).
        // They are never a session, so they cannot reach an ordinary route.
        if (token.startsWith(integration.TOKEN_PREFIX)) {
            throw httpError(401, 'Integration tokens are only accepted on integration routes');
        }

        // A cookie is sent by the browser automatically, so a request from another site could
        // ride on it. Browsers always send Origin on writes; reject writes from any other origin.
        if (viaCookie && UNSAFE_METHODS.has(req.method)) {
            const origin = req.headers.origin;
            const expected = `${req.protocol}://${req.headers.host}`;
            if (origin && origin !== expected) throw httpError(403, 'Cross-site request refused');
        }

        let payload;
        try {
            payload = verifyToken(token);
        } catch {
            throw httpError(401, 'Invalid or expired token');
        }

        const { rows } = await pool.query(
            `SELECT id, email, name, role, reputation_score, total_earned,
                    password_changed_at, tokens_valid_after, is_admin, account_status
             FROM users WHERE id = $1`, [payload.sub]
        );
        if (rows.length === 0) {
            throw httpError(401, 'Account no longer exists');
        }

        // Tokens issued at or before a revocation point are rejected: the last
        // password change, or a logout. Times come from the app clock (see the
        // writers in routes/auth.js), so issue and revocation share one clock.
        const { password_changed_at, tokens_valid_after, ...user } = rows[0];
        if (issuedBefore(payload, password_changed_at)) {
            throw httpError(401, 'Your password was changed. Please log in again.');
        }
        if (issuedBefore(payload, tokens_valid_after)) {
            throw httpError(401, 'You have been logged out. Please log in again.');
        }

        req.user = user;
        next();
    } catch (err) {
        next(err);
    }
}

// Authorization: role gate. Usage: router.post('/', authenticate, requireRole('business'), handler)
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return next(httpError(403, `Requires role: ${roles.join(' or ')}`));
        }
        next();
    };
}

// Admin gate. is_admin is set in the database only, never through the API.
function requireAdmin(req, res, next) {
    if (!req.user || req.user.is_admin !== true) {
        return next(httpError(403, 'Admins only'));
    }
    next();
}

// The token from a Bearer header or the session cookie, or null. Used by logout.
function readSessionToken(req) {
    const [scheme, bearer] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Bearer' && bearer) return bearer;
    return readCookie(req.headers.cookie, SESSION_COOKIE);
}

// Integration authentication (Workpeg). Bearer only, never a cookie. The token is checked on
// every request: unknown, revoked and expired tokens are refused, and so is a token whose owner
// has changed password since it was issued, or whose account is not active. Role and status
// come from the database each time, so a role change or suspension applies at once.
async function authenticateIntegration(req, res, next) {
    try {
        const [scheme, bearer] = (req.headers.authorization || '').split(' ');
        if (scheme !== 'Bearer' || !bearer || !bearer.startsWith(integration.TOKEN_PREFIX)) {
            throw httpError(401, 'Missing integration token');
        }
        const row = await integration.loadActiveToken(bearer);
        if (!row) {
            throw httpError(401, 'Integration token is invalid, expired or revoked');
        }
        if (row.password_changed_at && new Date(row.password_changed_at) > new Date(row.issued_at)) {
            throw httpError(401, 'Your password was changed. Link Bounty again to continue.');
        }
        if (row.account_status !== 'active') {
            throw httpError(403, 'This account cannot use integrations right now.');
        }
        if (row.is_admin === true || row.role === 'admin') {
            throw httpError(403, 'Admins cannot use integrations.');
        }
        // Recorded for the owner's settings page. Not awaited: a failed write must not block the call.
        pool.query('UPDATE integration_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
        req.integration = { tokenId: row.id, scopes: row.scopes };
        req.user = {
            id: row.user_id, email: row.email, name: row.name, role: row.role,
            is_admin: row.is_admin, account_status: row.account_status,
        };
        next();
    } catch (err) {
        next(err);
    }
}

// Scope gate for integration routes. A scope must be on the token AND allowed for the owner's
// current role. The token body can never widen what the role permits.
function requireScope(scope) {
    return (req, res, next) => {
        if (!req.integration) return next(httpError(401, 'Missing integration token'));
        if (!req.integration.scopes.includes(scope)) {
            return next(httpError(403, `This token does not allow ${scope}`));
        }
        if (!integration.roleAllows(req.user.role, scope)) {
            return next(httpError(403, `Your role cannot use ${scope}`));
        }
        next();
    };
}

module.exports = {
    authenticate, authenticateIntegration, requireScope, requireRole, requireAdmin, signToken,
    setSessionCookie, clearSessionCookie, verifyToken, readSessionToken, httpError, SESSION_COOKIE,
};