// routes/global.js — global opportunity access.
//
//   GET   /api/global/regions                   public: supported countries, currencies (honest status), payout note
//   PATCH /api/global/tasks/:id/regions         business owner: limit an open task to some regions (empty = everywhere)
//   GET   /api/global/opportunities             worker: open tasks visible to them, ranked, with regional information

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { REGIONS, CURRENCIES, PAYOUT_NOTE, parseTaskRegions, eligibilityFor } = require('../services/regions');
const { rankTasksForWorker } = require('./matching');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------ GET /api/global/regions (public)
router.get('/regions', (req, res) => {
  res.json({
    regions: REGIONS,
    currencies: CURRENCIES,
    supported_currency: 'NGN',
    payout_note: PAYOUT_NOTE,
  });
});

// ------------------------------------------------ PATCH /api/global/tasks/:id/regions (business)
router.patch('/tasks/:id/regions', authenticate, requireRole('business'), async(req, res, next) => {
  const client = await pool.connect();
  try {
    if (!UUID_RE.test(req.params.id)) throw httpError(400, 'Invalid task id');
    const regions = parseTaskRegions((req.body || {}).regions);

    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, business_id, status FROM bounties WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (rows.length === 0) throw httpError(404, 'Task not found');
    if (rows[0].business_id !== req.user.id) throw httpError(403, 'Only the business that posted this task can change who sees it');
    if (rows[0].status !== 'open') throw httpError(409, 'Visibility can only change while the task is open');
    const { rows: updated } = await client.query(
      'UPDATE bounties SET regions = $2::char(2)[], updated_at = NOW() WHERE id = $1 RETURNING id, regions', [req.params.id, regions]
    );
    await client.query('COMMIT');
    res.json({ id: updated[0].id, regions: updated[0].regions });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ------------------------------------------------ GET /api/global/opportunities (worker)
router.get('/opportunities', authenticate, requireRole('worker'), async(req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT country FROM users WHERE id = $1', [req.user.id]);
    const country = rows.length ? rows[0].country : null;
    const results = await rankTasksForWorker(req.user.id);
    res.json({ eligibility: eligibilityFor(country), results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
