// routes/peg.js — the Workpeg integration surface. Every route here takes an integration token
// (Bearer, bnt_wp_...) and checks its scope and the owner's current role on every request.
// Design: docs/workpeg-identity-design.md. Nothing here approves work, changes roles, or touches money.
//   GET  /api/peg/me                      the token's owner and scopes
//   GET  /api/peg/bounties                open, public, non-regional tasks (bounties:read)
//   GET  /api/peg/business/requests       a business's own hospitality requests (services:read)
//   GET  /api/peg/business/requests/:id   one request with its quotes and visit (services:read)
//   GET  /api/peg/business/appointments   the business's live visits (services:read)
//   POST /api/peg/confirmations           ask the user to approve a sensitive action

const express = require('express');
const { pool } = require('../db');
const { authenticateIntegration, requireScope, httpError } = require('../middleware/auth');
const { logAudit } = require('../services/protection');
const tokens = require('../services/integration-tokens');
const hs = require('../services/hospitality');
const { flags } = require('../services/schema-flags');

const router = express.Router();

router.use(authenticateIntegration);

// Only businesses see the hospitality services surface. The peg is a business-facing tool.
function businessOnly(req, res, next) {
    if (req.user.role !== 'business') return next(httpError(403, 'Only a business can use this'));
    next();
}

// Hospitality tables may not be in this database yet. Return a clear 503 instead of a 500.
async function requireHospitality(req, res, next) {
    try {
        const f = await flags();
        if (!f.serviceLocations) {
            return res.status(503).json({ message: 'Hospitality services are not ready on this server yet. Please check back soon.' });
        }
        next();
    } catch (err) { next(err); }
}

const DEADLINE_MS = '(EXTRACT(EPOCH FROM b.deadline) * 1000)::bigint AS deadline_ms';
function fmtDeadline(row) {
    return hs.formatLocal(new Date(Number(row.deadline_ms)), row.time_zone || 'UTC');
}

router.get('/me', (req, res) => {
    res.json({
        user: { name: req.user.name, role: req.user.role },
        scopes: req.integration.scopes,
    });
});

// Only tasks that are open, public, not confidential and not limited to a region. Region-limited
// and confidential tasks stay out until the Peg can check the user's region and NDA (rules section 3).
router.get('/bounties', requireScope('bounties:read'), async(req, res, next) => {
    try {
        const parsed = parseInt(req.query.limit, 10);
        const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 20) : 10;
        const category = typeof req.query.category === 'string' && req.query.category.length > 0 && req.query.category.length <= 100
            ? req.query.category : null;
        const { rows } = await pool.query(
            `SELECT id, title, category, difficulty, reward_amount, deadline, submission_type, status
             FROM bounties
             WHERE status = 'open' AND confidential = FALSE AND cardinality(regions) = 0
               AND deadline > NOW() AND ($1::text IS NULL OR category = $1)
             ORDER BY created_at DESC LIMIT $2`,
            [category, limit]
        );
        res.json({ bounties: rows.map((r) => ({ ...r, reward_amount: Number(r.reward_amount) })) });
    } catch (err) { next(err); }
});

// ----------------------------------------------------------------- business-side hospitality
// Owner view, read-only. Everything is scoped to this user's own bounties.

router.get('/business/requests', requireScope('services:read'), businessOnly, requireHospitality, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT b.id, b.title, b.description AS problem, b.requirements AS needs, b.reward_amount AS price,
                    b.currency, b.area_label, b.status, ${DEADLINE_MS},
                    b.service_industry AS industry, b.service_labels AS services,
                    sl.region_code, sl.time_zone,
                    (SELECT COUNT(*) FROM quotations q WHERE q.bounty_id = b.id AND q.status = 'pending')::int AS pending_quotes
             FROM bounties b
             LEFT JOIN service_locations sl ON sl.bounty_id = b.id
             WHERE b.business_id = $1 AND b.task_mode = 'onsite' AND b.category = $2
             ORDER BY b.created_at DESC LIMIT 100`,
            [req.user.id, hs.CATEGORY]
        );
        res.json({
            requests: rows.map((r) => ({
                id: r.id, title: r.title, problem: r.problem, needs: r.needs,
                price: Number(r.price), currency: r.currency, area_label: r.area_label, status: r.status,
                industry: r.industry || null, services: r.services || [],
                region_code: r.region_code || null,
                local_deadline: fmtDeadline(r),
                pending_quotes: Number(r.pending_quotes) || 0,
            })),
        });
    } catch (err) { next(err); }
});

router.get('/business/requests/:id', requireScope('services:read'), businessOnly, requireHospitality, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT b.id, b.business_id, b.title, b.description AS problem, b.requirements AS needs,
                    b.reward_amount AS price, b.currency, b.area_label, b.status, ${DEADLINE_MS},
                    b.service_industry AS industry, b.service_labels AS services,
                    sl.address_text, sl.region_code, sl.time_zone
             FROM bounties b LEFT JOIN service_locations sl ON sl.bounty_id = b.id
             WHERE b.id = $1 AND b.business_id = $2 AND b.task_mode = 'onsite' AND b.category = $3`,
            [req.params.id, req.user.id, hs.CATEGORY]
        );
        const r = rows[0];
        if (!r) throw httpError(404, 'Request not found');
        const { rows: quoteRows } = await pool.query(
            `SELECT q.id, q.amount, q.note, q.status, q.created_at, u.name AS provider_name
             FROM quotations q JOIN users u ON u.id = q.provider_id
             WHERE q.bounty_id = $1 ORDER BY q.created_at ASC`,
            [r.id]
        );
        const { rows: appt } = await pool.query(
            `SELECT a.id, a.status, a.provider_confirmed_at, a.business_confirmed_at,
                    EXTRACT(EPOCH FROM a.starts_at) * 1000 AS starts_ms,
                    EXTRACT(EPOCH FROM a.ends_at)   * 1000 AS ends_ms,
                    u.name AS provider_name
             FROM appointments a JOIN users u ON u.id = a.provider_id
             WHERE a.bounty_id = $1 AND a.status IN ('proposed','confirmed')
             ORDER BY a.created_at DESC LIMIT 1`,
            [r.id]
        );
        const visit = appt[0] ? {
            id: appt[0].id, status: appt[0].status,
            provider_name: appt[0].provider_name,
            provider_confirmed: appt[0].provider_confirmed_at != null,
            business_confirmed: appt[0].business_confirmed_at != null,
            local_starts: hs.formatLocal(new Date(Number(appt[0].starts_ms)), r.time_zone || 'UTC'),
            local_ends: hs.formatLocal(new Date(Number(appt[0].ends_ms)), r.time_zone || 'UTC'),
        } : null;
        res.json({
            request: {
                id: r.id, title: r.title, problem: r.problem, needs: r.needs,
                price: Number(r.price), currency: r.currency, area_label: r.area_label, status: r.status,
                address: r.address_text || null, region_code: r.region_code || null,
                industry: r.industry || null, services: r.services || [],
                local_deadline: fmtDeadline(r),
                quotes: quoteRows.map((q) => ({ ...q, amount: Number(q.amount) })),
                appointment: visit,
            },
        });
    } catch (err) { next(err); }
});

router.get('/business/appointments', requireScope('services:read'), businessOnly, requireHospitality, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT a.id, a.bounty_id, a.status, a.provider_confirmed_at, a.business_confirmed_at,
                    EXTRACT(EPOCH FROM a.starts_at) * 1000 AS starts_ms,
                    EXTRACT(EPOCH FROM a.ends_at)   * 1000 AS ends_ms,
                    b.title, sl.time_zone
             FROM appointments a
             JOIN bounties b ON b.id = a.bounty_id
             LEFT JOIN service_locations sl ON sl.bounty_id = b.id
             WHERE b.business_id = $1 AND a.status IN ('proposed','confirmed')
             ORDER BY a.starts_at ASC LIMIT 50`,
            [req.user.id]
        );
        res.json({
            appointments: rows.map((a) => ({
                id: a.id, bounty_id: a.bounty_id, title: a.title, status: a.status,
                provider_confirmed: a.provider_confirmed_at != null,
                business_confirmed: a.business_confirmed_at != null,
                local_starts: hs.formatLocal(new Date(Number(a.starts_ms)), a.time_zone || 'UTC'),
                local_ends: hs.formatLocal(new Date(Number(a.ends_ms)), a.time_zone || 'UTC'),
            })),
        });
    } catch (err) { next(err); }
});

// Asks for the user's approval of one sensitive action. The action itself does not run here:
// it runs only after approval, and only with the exact payload approved (design section 3.4).
router.post('/confirmations', async(req, res, next) => {
    try {
        const body = req.body || {};
        const action = body.action;
        if (!tokens.SENSITIVE_SCOPES.includes(action)) {
            throw httpError(400, 'This action does not need approval, or is not supported');
        }
        if (!req.integration.scopes.includes(action)) {
            throw httpError(403, `This token does not allow ${action}`);
        }
        if (!tokens.roleAllows(req.user.role, action)) {
            throw httpError(403, `Your role cannot use ${action}`);
        }
        const payload = body.payload;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            throw httpError(400, 'Send the action details as an object in payload');
        }
        const conf = await tokens.requestConfirmation({ tokenId: req.integration.tokenId, action, payload });
        await logAudit(pool.query.bind(pool), req.user.id, 'integration.confirmation_requested', 'integration_confirmation', conf.id, {
            action,
        });
        res.status(201).json({
            id: conf.id, action: conf.action, expires_at: conf.expires_at, status: 'awaiting_user_approval',
        });
    } catch (err) { next(err); }
});

module.exports = router;
