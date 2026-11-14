// routes/services.js — hospitality services: onsite requests from businesses, quotes from providers,
// one accepted quote becomes an appointment, both sides confirm, then chat and status lines.
//
//   POST   /api/services/requests                      business: describe, price, address
//   GET    /api/services/requests?mine=1               business: own requests (with the address)
//   GET    /api/services/requests                      worker: open onsite requests (no address)
//   GET    /api/services/requests/:id                  owner, or a provider who quoted or is assigned
//   DELETE /api/services/requests/:id/address          business: remove the stored address
//   POST   /api/services/requests/:id/quotes           worker: quote
//   GET    /api/services/requests/:id/quotes           business: all quotes; worker: own quote
//   POST   /api/services/quotes/:id/accept             business: accept, propose the visit window
//   POST   /api/services/appointments/:id/confirm      either party confirms
//   POST   /api/services/appointments/:id/change       either party proposes a new window
//   GET    /api/services/appointments                  own appointments
//   GET    /api/services/appointments/:id/address      provider, only after both confirmed (logged)
//   GET    /api/services/appointments/:id/messages     parties
//   POST   /api/services/appointments/:id/messages     parties, once confirmed; status lines by provider
//
// The rules are in services/hospitality.js. The database rules are in docs/drafts/sql/.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { assertActiveAccount, requireAgreement, logAudit } = require('../services/protection');
const { createNotification } = require('./notifications');
const hs = require('../services/hospitality');
const catalogue = require('../services/hospitality-catalogue');
const { flags } = require('../services/schema-flags');

const router = express.Router();
router.use(authenticate);

// If the hospitality migration has not been applied, every route here returns a plain 503
// instead of a 500 from an unknown table or column. Once the migration is in, this is skipped.
router.use(async (req, res, next) => {
    try {
        const f = await flags();
        if (!f.serviceLocations || !f.userWorkModes) {
            return res.status(503).json({ message: 'Hospitality services are not ready on this server yet. Please check back soon.' });
        }
        next();
    } catch (err) { next(err); }
});

const dbq = (sql, params) => pool.query(sql, params);

async function inTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// The deadline column is TIMESTAMP without a time zone and holds UTC. Read it as epoch milliseconds
// so the server's own time zone never changes its meaning.
const DEADLINE_MS = '(EXTRACT(EPOCH FROM b.deadline) * 1000)::bigint AS deadline_ms';

function deadlineDate(row) {
    return new Date(Number(row.deadline_ms));
}

async function nameOf(userId) {
    const { rows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    return rows[0] ? rows[0].name : 'Someone';
}

// The owner's view of a request: everything, including the exact address. Internal columns
// (business id, epoch deadline) never leave the server.
function ownerView(r) {
    return {
        id: r.id, title: r.title, problem: r.problem, needs: r.needs, price: Number(r.price),
        currency: r.currency, area_label: r.area_label, status: r.status,
        address: r.address_text || null,
        worker_notes: r.worker_notes || null, urgent: r.urgent === true,
        region_code: r.region_code || null, time_zone: r.time_zone || null,
        local_deadline: hs.formatLocal(deadlineDate(r), r.time_zone || 'UTC'),
        pending_quotes: r.pending_quotes === undefined ? undefined : Number(r.pending_quotes),
        industry: r.industry || null, services: r.services || [],
    };
}

// The industries and the services each usually needs, for the request form.
router.get('/catalogue', (req, res) => {
    res.json({ industries: catalogue.INDUSTRIES, max_services: catalogue.MAX_SERVICES });
});

// ------------------------------------------------------------------ requests

router.post('/requests', requireRole('business'), async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        await requireAgreement(dbq, req.user.id, 'creator_protection_business');
        const r = hs.validateRequest(req.body, new Date());

        const created = await inTransaction(async(client) => {
            const { rows } = await client.query(
                `INSERT INTO bounties
                   (business_id, title, description, category, difficulty, reward_amount, deadline, submission_type,
                    requirements, status, created_at, updated_at, currency, task_mode, area_label,
                    service_industry, service_labels)
                 VALUES ($1, $2, $3, $4, 'easy', $5, $6, 'text', $7, 'open', NOW(), NOW(), $8, 'onsite', $9, $10, $11)
                 RETURNING id`,
                [req.user.id, r.title, r.problem, hs.CATEGORY, r.price, r.deadline.toISOString(), r.needs,
                    r.currency, r.areaLabel, r.industry, r.serviceLabels]
            );
            const id = rows[0].id;
            await client.query(
                `INSERT INTO service_locations (bounty_id, address_text, region_code, time_zone, created_by, worker_notes, urgent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, r.address, r.region, r.timeZone, req.user.id, r.workerNotes, r.urgent]
            );
            await logAudit(client.query.bind(client), req.user.id, 'service_request.created', 'bounty', id, {
                region: r.region, currency: r.currency,
            });
            return id;
        });

        res.status(201).json({
            id: created,
            status: 'open',
            currency: r.currency,
            time_zone: r.timeZone,
            local_deadline: hs.formatLocal(r.deadline, r.timeZone),
        });
    } catch (err) { next(err); }
});

// The business's own requests, with the exact address (only the owner sees it here).
async function listMine(req, res) {
    const { rows } = await pool.query(
        `SELECT b.id, b.title, b.description AS problem, b.requirements AS needs, b.reward_amount AS price,
                b.currency, b.area_label, b.status, ${DEADLINE_MS}, b.service_industry AS industry, b.service_labels AS services,
                sl.address_text AS address, sl.worker_notes, sl.urgent, sl.region_code, sl.time_zone,
                (SELECT COUNT(*) FROM quotations q WHERE q.bounty_id = b.id AND q.status = 'pending')::int AS pending_quotes
         FROM bounties b
         LEFT JOIN service_locations sl ON sl.bounty_id = b.id
         WHERE b.business_id = $1 AND b.task_mode = 'onsite' AND b.category = $2
         ORDER BY b.created_at DESC LIMIT 100`, [req.user.id, hs.CATEGORY]
    );
    res.json({ requests: rows.map(ownerView) });
}

// Open requests in the region a worker said they serve. The provider decides from the area label
// if they can reach. Remote-only workers are kept out.
async function listForProvider(req, res) {
    const { rows: me } = await pool.query('SELECT work_modes FROM users WHERE id = $1', [req.user.id]);
    const modes = (me[0] && me[0].work_modes) || [];
    if (modes.length === 0) {
        return res.json({ requests: [], needs_area: true });
    }
    if (!modes.includes('onsite')) {
        return res.json({ requests: [], needs_area: false, work_mode_off: true });
    }
    const { rows } = await pool.query(
        `SELECT b.id, b.title, b.description AS problem, b.requirements AS needs, b.reward_amount AS price,
                b.currency, b.area_label, b.status, ${DEADLINE_MS}, b.service_labels AS services,
                sl.region_code, sl.time_zone, sl.urgent
         FROM bounties b
         JOIN service_locations sl ON sl.bounty_id = b.id
         WHERE b.task_mode = 'onsite' AND b.category = $1 AND b.status = 'open' AND b.deadline > NOW()
           AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.bounty_id = b.id AND q.status = 'accepted')
         ORDER BY sl.urgent DESC, b.created_at DESC LIMIT 200`, [hs.CATEGORY]
    );
    const { rows: mine } = await pool.query(
        'SELECT bounty_id, status, amount FROM quotations WHERE provider_id = $1', [req.user.id]
    );
    const quoted = new Map(mine.map((q) => [String(q.bounty_id), q]));

    const visible = rows.map((r) => {
        const q = quoted.get(String(r.id));
        return {
            id: r.id, title: r.title, problem: r.problem, needs: r.needs, price: Number(r.price),
            currency: r.currency, area_label: r.area_label, status: r.status,
            services: r.services || [],
            region_code: r.region_code, urgent: r.urgent === true,
            local_deadline: hs.formatLocal(deadlineDate(r), r.time_zone),
            my_quote: q ? { status: q.status, amount: Number(q.amount) } : null,
        };
    });
    res.json({ requests: visible, needs_area: false });
}

router.get('/requests', async(req, res, next) => {
    try {
        if (req.query.mine === '1' && req.user.role === 'business') return await listMine(req, res);
        if (req.user.role !== 'worker') return res.json({ requests: [], needs_area: false });
        return await listForProvider(req, res);
    } catch (err) { next(err); }
});

// The live appointment of a request (proposed or confirmed), for the screen. A provider sees only theirs.
async function liveAppointment(bountyId, providerId) {
    const params = providerId ? [bountyId, providerId] : [bountyId];
    const where = providerId ? 'AND a.provider_id = $2' : '';
    const { rows } = await pool.query(
        `SELECT a.id, a.bounty_id, a.provider_id, a.starts_at, a.ends_at, a.status,
                a.provider_confirmed_at, a.business_confirmed_at, a.business_paid_at, a.provider_received_at,
                b.business_id, b.title, sl.time_zone
         FROM appointments a JOIN bounties b ON b.id = a.bounty_id LEFT JOIN service_locations sl ON sl.bounty_id = b.id
         WHERE a.bounty_id = $1 ${where} AND a.status IN ('proposed', 'confirmed')
         ORDER BY a.created_at DESC LIMIT 1`, params
    );
    return rows[0] ? { ...publicAppointment(rows[0]), provider_id: rows[0].provider_id } : null;
}

// One request. The owner sees everything. A provider who quoted or is assigned sees the area label
// and the region, and the address only once both sides have confirmed the visit.
router.get('/requests/:id', async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT b.id, b.business_id, b.title, b.description AS problem, b.requirements AS needs, b.reward_amount AS price,
                    b.currency, b.area_label, b.status, ${DEADLINE_MS}, b.service_industry AS industry, b.service_labels AS services,
                    sl.address_text, sl.worker_notes, sl.urgent, sl.region_code, sl.time_zone
             FROM bounties b LEFT JOIN service_locations sl ON sl.bounty_id = b.id
             WHERE b.id = $1 AND b.task_mode = 'onsite' AND b.category = $2`, [req.params.id, hs.CATEGORY]
        );
        const request = rows[0];
        if (!request) throw httpError(404, 'Request not found');

        if (String(request.business_id) === String(req.user.id)) {
            const live = await liveAppointment(request.id, null);
            return res.json({ request: { ...ownerView(request), viewer_role: 'business', appointment: live } });
        }
        if (req.user.role !== 'worker') throw httpError(404, 'Request not found');

        const { rows: link } = await pool.query(
            `SELECT q.status AS quote_status, a.id AS appointment_id, a.status AS appointment_status,
                    a.provider_confirmed_at, a.business_confirmed_at
             FROM quotations q
             LEFT JOIN appointments a ON a.bounty_id = q.bounty_id AND a.provider_id = q.provider_id AND a.status IN ('proposed','confirmed')
             WHERE q.bounty_id = $1 AND q.provider_id = $2 ORDER BY q.created_at DESC LIMIT 1`,
            [request.id, req.user.id]
        );
        if (link.length === 0) throw httpError(404, 'Request not found');

        const appointment = link[0].appointment_id ? {
            id: link[0].appointment_id, status: link[0].appointment_status, provider_id: req.user.id,
            provider_confirmed_at: link[0].provider_confirmed_at, business_confirmed_at: link[0].business_confirmed_at,
        } : null;
        const showAddress = hs.canSeeAddress(req.user, request, appointment);
        const view = {
            id: request.id, title: request.title, problem: request.problem, needs: request.needs,
            price: Number(request.price), currency: request.currency, area_label: request.area_label,
            status: request.status, region_code: request.region_code, urgent: request.urgent === true,
            local_deadline: hs.formatLocal(deadlineDate(request), request.time_zone),
            my_quote_status: link[0].quote_status,
            services: request.services || [],
            viewer_role: 'provider',
            appointment: await liveAppointment(request.id, req.user.id),
        };
        if (showAddress) {
            view.address = request.address_text;
            view.worker_notes = request.worker_notes || null;
        }
        res.json({ request: view });
    } catch (err) { next(err); }
});

// Removes the exact address. Refused while an appointment is confirmed, because the provider may need it.
router.delete('/requests/:id/address', requireRole('business'), async(req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT business_id FROM bounties WHERE id = $1 AND task_mode = $2', [req.params.id, 'onsite']);
        if (rows.length === 0 || String(rows[0].business_id) !== String(req.user.id)) throw httpError(404, 'Request not found');
        const { rows: confirmed } = await pool.query(
            `SELECT 1 FROM appointments WHERE bounty_id = $1 AND status = 'confirmed'`, [req.params.id]
        );
        if (confirmed.length > 0) throw httpError(409, 'Cancel the confirmed appointment before removing its address');
        const { rowCount } = await pool.query('DELETE FROM service_locations WHERE bounty_id = $1', [req.params.id]);
        await logAudit(pool.query.bind(pool), req.user.id, 'service_location.removed', 'bounty', req.params.id, {});
        res.json({ ok: true, removed: rowCount > 0 });
    } catch (err) { next(err); }
});

// ------------------------------------------------------------------ quotes

router.post('/requests/:id/quotes', requireRole('worker'), async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const q = hs.validateQuote(req.body);
        const { rows } = await pool.query(
            `SELECT b.id, b.business_id, b.title, b.status, b.deadline AS deadline_utc, ${DEADLINE_MS},
                    sl.time_zone
             FROM bounties b JOIN service_locations sl ON sl.bounty_id = b.id
             WHERE b.id = $1 AND b.task_mode = 'onsite' AND b.category = $2`, [req.params.id, hs.CATEGORY]
        );
        const request = rows[0];
        if (!request) throw httpError(404, 'Request not found');
        if (String(request.business_id) === String(req.user.id)) throw httpError(403, 'You cannot quote on your own request');
        if (request.status !== 'open' || deadlineDate(request) <= new Date()) throw httpError(409, 'This request is no longer open');

        const { rows: accepted } = await pool.query(
            `SELECT 1 FROM quotations WHERE bounty_id = $1 AND status = 'accepted'`, [request.id]
        );
        if (accepted.length > 0) throw httpError(409, 'A provider has already been chosen for this request');

        const { rows: meRows } = await pool.query('SELECT work_modes FROM users WHERE id = $1', [req.user.id]);
        const modes = (meRows[0] && meRows[0].work_modes) || [];
        if (!modes.includes('onsite')) throw httpError(422, 'Turn on on-site work on your profile before you quote');

        let quote;
        try {
            const { rows: inserted } = await pool.query(
                `INSERT INTO quotations (bounty_id, provider_id, amount, note, status, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
                 RETURNING id, bounty_id, amount, note, status, created_at`,
                [request.id, req.user.id, q.amount, q.note]
            );
            quote = inserted[0];
        } catch (err) {
            if (err.code === '23505') throw httpError(409, 'You already have a pending quote on this request');
            throw err;
        }
        await createNotification(request.business_id, `New quote on "${request.title}"`, `#/services/${request.id}`);
        res.status(201).json({ quote: { ...quote, amount: Number(quote.amount) } });
    } catch (err) { next(err); }
});

router.get('/requests/:id/quotes', async(req, res, next) => {
    try {
        const { rows: owner } = await pool.query('SELECT business_id FROM bounties WHERE id = $1 AND task_mode = $2', [req.params.id, 'onsite']);
        if (owner.length === 0) throw httpError(404, 'Request not found');
        const isOwner = String(owner[0].business_id) === String(req.user.id);
        const { rows } = await pool.query(
            `SELECT q.id, q.amount, q.note, q.status, q.created_at, q.provider_id, u.name AS provider_name,
                    u.timezone, to_char(u.available_start, 'HH24:MI') AS available_start, to_char(u.available_end, 'HH24:MI') AS available_end
             FROM quotations q JOIN users u ON u.id = q.provider_id
             WHERE q.bounty_id = $1 AND ($2::boolean OR q.provider_id = $3)
             ORDER BY q.created_at ASC`, [req.params.id, isOwner, req.user.id]
        );
        // The hours a provider gave are shown to the business that is choosing, never to others.
        res.json({ quotes: rows.map((r) => {
            const hours = r.available_start && r.available_end && r.timezone
                ? { from: r.available_start, to: r.available_end, zone: r.timezone } : null;
            const { timezone, available_start, available_end, ...rest } = r;
            return { ...rest, amount: Number(r.amount), provider_hours: isOwner ? hours : undefined };
        }) });
    } catch (err) { next(err); }
});

// ------------------------------------------------------------------ appointments

router.post('/quotes/:id/accept', requireRole('business'), async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const body = req.body || {};
        const appointment = await inTransaction(async(client) => {
            const { rows } = await client.query(
                `SELECT q.id, q.bounty_id, q.provider_id, q.status, b.business_id, b.title, b.status AS bounty_status,
                        ${DEADLINE_MS}, sl.time_zone
                 FROM quotations q
                 JOIN bounties b ON b.id = q.bounty_id
                 JOIN service_locations sl ON sl.bounty_id = b.id
                 WHERE q.id = $1 AND b.task_mode = 'onsite' FOR UPDATE OF q`, [req.params.id]
            );
            const quote = rows[0];
            if (!quote) throw httpError(404, 'Quote not found');
            if (String(quote.business_id) !== String(req.user.id)) throw httpError(403, 'Only the business can accept a quote');
            if (quote.status !== 'pending') throw httpError(409, 'Only a pending quote can be accepted');
            if (quote.bounty_status !== 'open') throw httpError(409, 'This request is no longer open');

            const window = hs.validateWindow(body.starts_local, body.ends_local, quote.time_zone, deadlineDate(quote));
            const { rows: hoursRows } = await client.query(
                `SELECT timezone, to_char(available_start, 'HH24:MI') AS available_start, to_char(available_end, 'HH24:MI') AS available_end
                 FROM users WHERE id = $1`, [quote.provider_id]
            );
            const h = hoursRows[0] || {};
            if (h.timezone && h.available_start && h.available_end) {
                if (!hs.visitFitsHours(window.starts, window.ends, h.timezone, h.available_start, h.available_end)) {
                    throw httpError(409, `This provider is available ${h.available_start} to ${h.available_end} (${h.timezone}). Choose a visit inside those hours.`);
                }
            }

            await client.query(`UPDATE quotations SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [quote.id]);
            await client.query(
                `UPDATE quotations SET status = 'declined', updated_at = NOW()
                 WHERE bounty_id = $1 AND status = 'pending' AND id <> $2`, [quote.bounty_id, quote.id]
            );
            await client.query(
                `INSERT INTO bounty_participants (bounty_id, worker_id, status) VALUES ($1, $2, 'assigned')`,
                [quote.bounty_id, quote.provider_id]
            );
            let inserted;
            try {
                const result = await client.query(
                    `INSERT INTO appointments (bounty_id, provider_id, starts_at, ends_at, status, proposed_by, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, 'proposed', $5, NOW(), NOW())
                     RETURNING id, bounty_id, provider_id, starts_at, ends_at, status`,
                    [quote.bounty_id, quote.provider_id, window.starts.toISOString(), window.ends.toISOString(), req.user.id]
                );
                inserted = result.rows[0];
            } catch (err) {
                if (err.code === '23505') throw httpError(409, 'This request already has a live appointment');
                throw err;
            }
            await client.query(
                `INSERT INTO appointment_events (appointment_id, actor_id, event, details) VALUES ($1, $2, 'proposed', $3)`,
                [inserted.id, req.user.id, JSON.stringify({ starts_at: window.starts.toISOString(), ends_at: window.ends.toISOString() })]
            );
            return { ...inserted, title: quote.title, time_zone: quote.time_zone };
        });
        await createNotification(
            appointment.provider_id, `Your quote for "${appointment.title}" was accepted. Confirm the visit time.`,
            `#/services/appointments/${appointment.id}`
        );
        res.status(201).json({
            appointment: {
                id: appointment.id, bounty_id: appointment.bounty_id, status: appointment.status,
                local_starts: hs.formatLocal(new Date(appointment.starts_at), appointment.time_zone),
                local_ends: hs.formatLocal(new Date(appointment.ends_at), appointment.time_zone),
            },
        });
    } catch (err) { next(err); }
});

// Loads an appointment with its request, and the caller's side. Shared by the appointment routes.
async function loadAppointment(id) {
    const { rows } = await pool.query(
        `SELECT a.id, a.bounty_id, a.provider_id, a.starts_at, a.ends_at, a.status, a.proposed_by,
                a.provider_confirmed_at, a.provider_confirmed_by, a.business_confirmed_at, a.business_confirmed_by,
                a.business_paid_at, a.provider_received_at,
                b.business_id, b.title, sl.time_zone
         FROM appointments a
         JOIN bounties b ON b.id = a.bounty_id
         LEFT JOIN service_locations sl ON sl.bounty_id = b.id
         WHERE a.id = $1`, [id]
    );
    return rows[0] || null;
}

function publicAppointment(a) {
    return {
        id: a.id, bounty_id: a.bounty_id, status: a.status, title: a.title,
        local_starts: a.time_zone ? hs.formatLocal(new Date(a.starts_at), a.time_zone) : null,
        local_ends: a.time_zone ? hs.formatLocal(new Date(a.ends_at), a.time_zone) : null,
        provider_confirmed: a.provider_confirmed_at !== null,
        business_confirmed: a.business_confirmed_at !== null,
        payment: {
            business_paid: a.business_paid_at != null,
            provider_received: a.provider_received_at != null,
            confirmed: a.business_paid_at != null && a.provider_received_at != null,
        },
    };
}

router.post('/appointments/:id/confirm', async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const result = await inTransaction(async(client) => {
            const { rows } = await client.query(
                `SELECT a.*, b.business_id, b.title, sl.time_zone FROM appointments a
                 JOIN bounties b ON b.id = a.bounty_id LEFT JOIN service_locations sl ON sl.bounty_id = b.id
                 WHERE a.id = $1 FOR UPDATE OF a`, [req.params.id]
            );
            const a = rows[0];
            if (!a) throw httpError(404, 'Appointment not found');
            const party = hs.partyOf(req.user.id, a, a.business_id);
            if (!party) throw httpError(404, 'Appointment not found');
            if (a.status === 'confirmed') return { a, changed: false };
            if (a.status !== 'proposed') throw httpError(409, `An appointment that is ${a.status} cannot be confirmed`);

            if (party === 'provider' && a.provider_confirmed_at === null) {
                await client.query('UPDATE appointments SET provider_confirmed_at = NOW(), provider_confirmed_by = $2, updated_at = NOW() WHERE id = $1', [a.id, req.user.id]);
                await client.query(`INSERT INTO appointment_events (appointment_id, actor_id, event) VALUES ($1, $2, 'confirmed_by_provider')`, [a.id, req.user.id]);
            }
            if (party === 'business' && a.business_confirmed_at === null) {
                await client.query('UPDATE appointments SET business_confirmed_at = NOW(), business_confirmed_by = $2, updated_at = NOW() WHERE id = $1', [a.id, req.user.id]);
                await client.query(`INSERT INTO appointment_events (appointment_id, actor_id, event) VALUES ($1, $2, 'confirmed_by_business')`, [a.id, req.user.id]);
            }
            const { rows: now } = await client.query('SELECT * FROM appointments WHERE id = $1', [a.id]);
            const fresh = now[0];
            if (fresh.provider_confirmed_at !== null && fresh.business_confirmed_at !== null) {
                await client.query(`UPDATE appointments SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [a.id]);
                fresh.status = 'confirmed';
            }
            return { a: { ...fresh, title: a.title, time_zone: a.time_zone, business_id: a.business_id }, changed: true, party };
        });

        const a = result.a;
        if (result.changed) {
            const other = result.party === 'provider' ? a.business_id : a.provider_id;
            const who = await nameOf(req.user.id);
            const text = a.status === 'confirmed'
                ? `Visit for "${a.title}" is confirmed. Chat is open.`
                : `${who} confirmed the visit for "${a.title}". Please confirm too.`;
            await createNotification(other, text, `#/services/appointments/${a.id}`);
        }
        res.json({ appointment: publicAppointment(a) });
    } catch (err) { next(err); }
});

router.post('/appointments/:id/change', async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const body = req.body || {};
        const created = await inTransaction(async(client) => {
            const { rows } = await client.query(
                `SELECT a.*, b.business_id, b.title, b.deadline AS deadline_utc, ${DEADLINE_MS}, sl.time_zone
                 FROM appointments a JOIN bounties b ON b.id = a.bounty_id LEFT JOIN service_locations sl ON sl.bounty_id = b.id
                 WHERE a.id = $1 FOR UPDATE OF a`, [req.params.id]
            );
            const a = rows[0];
            if (!a) throw httpError(404, 'Appointment not found');
            const party = hs.partyOf(req.user.id, a, a.business_id);
            if (!party) throw httpError(404, 'Appointment not found');
            hs.assertTransition(a.status, 'superseded');

            const window = hs.validateWindow(body.starts_local, body.ends_local, a.time_zone, deadlineDate(a));
            await client.query(`UPDATE appointments SET status = 'superseded', updated_at = NOW() WHERE id = $1`, [a.id]);
            await client.query(`INSERT INTO appointment_events (appointment_id, actor_id, event) VALUES ($1, $2, 'superseded')`, [a.id, req.user.id]);
            const { rows: fresh } = await client.query(
                `INSERT INTO appointments (bounty_id, provider_id, starts_at, ends_at, status, proposed_by, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'proposed', $5, NOW(), NOW())
                 RETURNING id, bounty_id, provider_id, starts_at, ends_at, status`,
                [a.bounty_id, a.provider_id, window.starts.toISOString(), window.ends.toISOString(), req.user.id]
            );
            await client.query(
                `INSERT INTO appointment_events (appointment_id, actor_id, event, details) VALUES ($1, $2, 'proposed', $3)`,
                [fresh[0].id, req.user.id, JSON.stringify({ starts_at: window.starts.toISOString(), ends_at: window.ends.toISOString() })]
            );
            return { ...fresh[0], title: a.title, business_id: a.business_id, time_zone: a.time_zone, party };
        });
        const other = created.party === 'provider' ? created.business_id : created.provider_id;
        const who = await nameOf(req.user.id);
        await createNotification(other, `${who} proposed a new time for "${created.title}". Please confirm it.`, `#/services/appointments/${created.id}`);
        res.status(201).json({ appointment: publicAppointment({ ...created, provider_confirmed_at: null, business_confirmed_at: null }) });
    } catch (err) { next(err); }
});

router.get('/appointments', async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT a.id, a.bounty_id, a.provider_id, a.starts_at, a.ends_at, a.status,
                    a.provider_confirmed_at, a.business_confirmed_at, b.business_id, b.title, sl.time_zone
             FROM appointments a JOIN bounties b ON b.id = a.bounty_id LEFT JOIN service_locations sl ON sl.bounty_id = b.id
             WHERE (a.provider_id = $1 OR b.business_id = $1) AND a.status IN ('proposed', 'confirmed')
             ORDER BY a.starts_at ASC LIMIT 100`, [req.user.id]
        );
        res.json({ appointments: rows.map((a) => ({ ...publicAppointment(a), role: String(a.provider_id) === String(req.user.id) ? 'provider' : 'business' })) });
    } catch (err) { next(err); }
});

// The exact address. Only the provider, only after both confirmed. Every read is logged without the address.
router.get('/appointments/:id/address', async(req, res, next) => {
    try {
        const a = await loadAppointment(req.params.id);
        if (!a) throw httpError(404, 'Appointment not found');
        if (String(req.user.id) !== String(a.provider_id)) throw httpError(403, 'Only the assigned provider can see the address');
        if (!hs.canSeeAddress(req.user, { business_id: a.business_id }, a)) {
            throw httpError(403, 'The address opens once both sides confirm the visit');
        }
        const { rows } = await pool.query('SELECT address_text, worker_notes FROM service_locations WHERE bounty_id = $1', [a.bounty_id]);
        if (rows.length === 0) throw httpError(404, 'The address has been removed');
        await pool.query(`INSERT INTO appointment_events (appointment_id, actor_id, event) VALUES ($1, $2, 'address_disclosed')`, [a.id, req.user.id]);
        res.json({ address: rows[0] });
    } catch (err) { next(err); }
});

// ------------------------------------------------------------------ chat

router.get('/appointments/:id/messages', async(req, res, next) => {
    try {
        const a = await loadAppointment(req.params.id);
        if (!a) throw httpError(404, 'Appointment not found');
        if (!hs.partyOf(req.user.id, a, a.business_id)) throw httpError(404, 'Appointment not found');
        const { rows } = await pool.query(
            `SELECT m.id, m.author_id, u.name AS author_name, m.kind, m.body, m.status_code, m.created_at
             FROM appointment_messages m JOIN users u ON u.id = m.author_id
             WHERE m.appointment_id = $1 ORDER BY m.created_at ASC LIMIT 500`, [a.id]
        );
        res.json({ messages: rows, open: a.status === 'confirmed' });
    } catch (err) { next(err); }
});

router.post('/appointments/:id/messages', async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const input = hs.validateChatInput(req.body);
        const a = await loadAppointment(req.params.id);
        if (!a) throw httpError(404, 'Appointment not found');
        const party = hs.partyOf(req.user.id, a, a.business_id);
        hs.assertCanChat(a, party, input);

        const { rows } = await pool.query(
            `INSERT INTO appointment_messages (appointment_id, author_id, kind, body, status_code, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING id, author_id, kind, body, status_code, created_at`,
            [a.id, req.user.id, input.kind, input.body, input.status_code]
        );
        const other = party === 'provider' ? a.business_id : a.provider_id;
        const who = await nameOf(req.user.id);
        const text = input.kind === 'status'
            ? `${who} ${hs.STATUS_TEXT[input.status_code]} for "${a.title}"`
            : `New message from ${who} about "${a.title}"`;
        await createNotification(other, text, `#/services/appointments/${a.id}`);

        const warning = input.kind === 'message' && hs.looksLikeAddress(input.body)
            ? 'This looks like a street address. Share it through the address on the request, after the visit is confirmed.'
            : null;
        res.status(201).json({ message: rows[0], warning });
    } catch (err) { next(err); }
});

// POST /api/services/appointments/:id/review
// Either side reviews the other once, after the provider has marked the visit finished.
router.post('/appointments/:id/review', async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const a = await loadAppointment(req.params.id);
        if (!a) throw httpError(404, 'Appointment not found');
        const party = hs.partyOf(req.user.id, a, a.business_id);
        if (!party) throw httpError(403, 'Only the provider and the business can review this visit');
        const { rows: done } = await pool.query(
            `SELECT 1 FROM appointment_messages WHERE appointment_id = $1 AND kind = 'status' AND status_code = 'finished' LIMIT 1`,
            [a.id]
        );
        if (done.length === 0) throw httpError(409, 'You can review a visit once the provider marks it finished');
        const input = hs.validateReview(req.body);
        try {
            const { rows } = await pool.query(
                `INSERT INTO service_reviews (appointment_id, reviewer_id, rating, note)
                 VALUES ($1, $2, $3, $4) RETURNING id, rating, note, created_at`,
                [a.id, req.user.id, input.rating, input.note]
            );
            res.status(201).json({ review: rows[0] });
        } catch (err) {
            if (err.code === '23505') throw httpError(409, 'You have already reviewed this visit');
            throw err;
        }
    } catch (err) { next(err); }
});

// POST /api/services/appointments/:id/payment
// Each side records its own step: the business says it has paid, the provider says it has received the
// payment. Nothing is held and no money moves through Bounty. The visit counts as paid once both have marked it.
router.post('/appointments/:id/payment', async(req, res, next) => {
    try {
        await assertActiveAccount(req.user.id);
        const a = await loadAppointment(req.params.id);
        if (!a) throw httpError(404, 'Appointment not found');
        const party = hs.partyOf(req.user.id, a, a.business_id);
        if (!party) throw httpError(403, 'Only the provider and the business can record payment for this visit');
        if (a.status !== 'confirmed') throw httpError(409, 'Payment is recorded once both sides have confirmed the visit');

        const column = party === 'business' ? 'business_paid_at' : 'provider_received_at';
        const event = party === 'business' ? 'payment_made_marked' : 'payment_received_marked';
        const { rows } = await pool.query(
            `UPDATE appointments SET ${column} = COALESCE(${column}, NOW()), updated_at = NOW()
             WHERE id = $1 RETURNING business_paid_at, provider_received_at`, [a.id]
        );
        await pool.query(
            `INSERT INTO appointment_events (appointment_id, actor_id, event) VALUES ($1, $2, $3)`,
            [a.id, req.user.id, event]
        );
        const other = party === 'provider' ? a.business_id : a.provider_id;
        const who = await nameOf(req.user.id);
        const text = party === 'business'
            ? `${who} says the payment for "${a.title}" has been made. Confirm once you have received it.`
            : `${who} says they have received the payment for "${a.title}".`;
        await createNotification(other, text, `#/services/appointments/${a.id}`);

        const payment = {
            business_paid: rows[0].business_paid_at != null,
            provider_received: rows[0].provider_received_at != null,
        };
        payment.confirmed = payment.business_paid && payment.provider_received;
        res.json({ payment });
    } catch (err) { next(err); }
});

// GET /api/services/appointments/:id/reviews
// Your own review, and the other side's once they have written theirs.
router.get('/appointments/:id/reviews', async(req, res, next) => {
    try {
        const a = await loadAppointment(req.params.id);
        if (!a) throw httpError(404, 'Appointment not found');
        if (!hs.partyOf(req.user.id, a, a.business_id)) throw httpError(403, 'Only the provider and the business can see these reviews');
        const { rows } = await pool.query(
            `SELECT reviewer_id, rating, note, created_at FROM service_reviews WHERE appointment_id = $1`, [a.id]
        );
        const mine = rows.find((r) => String(r.reviewer_id) === String(req.user.id)) || null;
        const theirs = rows.find((r) => String(r.reviewer_id) !== String(req.user.id)) || null;
        res.json({
            mine: mine ? { rating: mine.rating, note: mine.note, created_at: mine.created_at } : null,
            theirs: theirs ? { rating: theirs.rating, note: theirs.note, created_at: theirs.created_at } : null,
        });
    } catch (err) { next(err); }
});

module.exports = router;
