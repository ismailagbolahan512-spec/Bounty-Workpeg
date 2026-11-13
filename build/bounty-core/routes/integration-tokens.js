// routes/integration-tokens.js — the user's own controls for Workpeg links. Signed in with a normal
// session (never with a Workpeg token). Design: docs/workpeg-identity-design.md, sections 3.4 and 3.5.
//   GET    /api/integration-tokens                          list the user's tokens (no secrets)
//   POST   /api/integration-tokens                          issue a token; shown once
//   POST   /api/integration-tokens/:id/rotate               replace a token; the old one stops at once
//   POST   /api/integration-tokens/:id/revoke               revoke a token; takes effect on the next request
//   POST   /api/integration-tokens/confirmations/:id/approve approve one sensitive action

const express = require('express');
const { pool } = require('../db');
const { authenticate, httpError } = require('../middleware/auth');
const { logAudit } = require('../services/protection');
const tokens = require('../services/integration-tokens');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkId(value, label) {
    if (!UUID_RE.test(value)) throw httpError(400, `Invalid ${label} id`);
}

function requireActive(user) {
    if (user.account_status !== 'active') {
        throw httpError(403, 'Your account cannot link Workpeg right now.');
    }
}

router.use(authenticate);

router.get('/', async(req, res, next) => {
    try {
        res.json({ tokens: await tokens.listTokens(req.user.id) });
    } catch (err) { next(err); }
});

router.post('/', async(req, res, next) => {
    try {
        requireActive(req.user);
        const body = req.body || {};
        const issued = await tokens.issueToken(pool, {
            userId: req.user.id, role: req.user.role, label: body.label, scopes: body.scopes, days: body.days,
        });
        await logAudit(pool.query.bind(pool), req.user.id, 'integration_token.issued', 'integration_token', issued.id, {
            scopes: issued.scopes,
        });
        res.status(201).json({
            id: issued.id, token: issued.token, scopes: issued.scopes, expires_at: issued.expires_at,
            shown_once: true,
        });
    } catch (err) { next(err); }
});

router.post('/:id/rotate', async(req, res, next) => {
    try {
        checkId(req.params.id, 'token');
        requireActive(req.user);
        const days = req.body ? req.body.days : undefined;
        const issued = await tokens.rotateToken(req.user.id, req.user.role, req.params.id, days);
        if (!issued) throw httpError(404, 'Token not found, or already revoked or expired');
        await logAudit(pool.query.bind(pool), req.user.id, 'integration_token.rotated', 'integration_token', req.params.id, {
            replaced_by: issued.id,
        });
        res.status(201).json({
            id: issued.id, token: issued.token, scopes: issued.scopes, expires_at: issued.expires_at,
            shown_once: true,
        });
    } catch (err) { next(err); }
});

router.post('/:id/revoke', async(req, res, next) => {
    try {
        checkId(req.params.id, 'token');
        const done = await tokens.revokeToken(req.user.id, req.params.id, 'revoked by user');
        if (!done) throw httpError(404, 'Token not found, or already revoked');
        await logAudit(pool.query.bind(pool), req.user.id, 'integration_token.revoked', 'integration_token', req.params.id, {});
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.post('/confirmations/:id/approve', async(req, res, next) => {
    try {
        checkId(req.params.id, 'confirmation');
        requireActive(req.user);
        const approved = await tokens.approveConfirmation(req.user.id, req.params.id);
        if (!approved) throw httpError(404, 'Confirmation not found, expired, or already approved');
        await logAudit(pool.query.bind(pool), req.user.id, 'integration_confirmation.approved', 'integration_confirmation', approved.id, {
            action: approved.action,
        });
        res.json({ id: approved.id, action: approved.action, approved: true });
    } catch (err) { next(err); }
});

module.exports = router;
