// routes/talent.js — a business's private talent pool.
//
//   GET    /api/talent/lists                        business: own lists with counts
//   POST   /api/talent/lists                        business: create a list (up to 10)
//   GET    /api/talent/lists/:id                    business: list members
//   PATCH  /api/talent/lists/:id                    business: rename
//   DELETE /api/talent/lists/:id                    business: delete the list (members are not deleted from the platform)
//   POST   /api/talent/lists/:id/members            business: save a worker who is discoverable or has worked with them
//   DELETE /api/talent/lists/:id/members/:workerId  business: remove a saved worker
//   GET    /api/talent/workers/:workerId/notes      business: own private notes about a worker
//   POST   /api/talent/workers/:workerId/notes      business: add a note (up to 50 per worker)
//   DELETE /api/talent/notes/:id                    business: delete own note
//   GET    /api/talent/open-tasks                   business: own open tasks, for invitations
//   POST   /api/talent/invitations                  business: invite a discoverable worker (needs the worker's acceptance)
//   GET    /api/talent/invitations                  business: invitations sent
//   POST   /api/talent/invitations/:id/withdraw     business: withdraw a pending invitation
//   GET    /api/talent/invitations/mine             worker: invitations received
//   POST   /api/talent/invitations/:id/respond      worker: accept or decline a pending invitation
//
// Consent: a business cannot invite a worker who has not opted in, and an invitation changes nothing
// until the worker accepts. Accepting does not assign work or a payment; the normal task rules still apply.
// A business's lists and notes are never shown to the worker.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { notifyAfterCommit } = require('../services/execution');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTS = 10;
const MAX_NOTES_PER_WORKER = 50;
const INVITATION_DAYS = 14;

function checkId(id, label) {
  if (!UUID_RE.test(id)) throw httpError(400, `Invalid ${label} id`);
}

function text(value, label, min, max) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t.length < min || t.length > max) throw httpError(400, `${label} must be ${min} to ${max} characters`);
  return t;
}

// Marks pending invitations past their expiry as expired. Runs before reads.
async function expireInvitations(db) {
  await db.query(`UPDATE talent_invitations SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()`);
}

async function ownList(db, listId, businessId) {
  const { rows } = await db.query('SELECT id, name FROM talent_lists WHERE id = $1 AND business_id = $2', [listId, businessId]);
  if (rows.length === 0) throw httpError(404, 'List not found');
  return rows[0];
}

// A worker may be saved only if they have opted in, or have submitted work to this business before.
async function savableWorker(db, workerId, businessId) {
  const { rows } = await db.query(
    `SELECT u.id, u.role, u.discoverable,
            EXISTS (SELECT 1 FROM submissions s JOIN bounties b ON b.id = s.bounty_id
                    WHERE s.worker_id = u.id AND b.business_id = $2) AS has_worked_with
     FROM users u WHERE u.id = $1`, [workerId, businessId]
  );
  if (rows.length === 0 || rows[0].role !== 'worker') throw httpError(404, 'Worker not found');
  if (!rows[0].discoverable && !rows[0].has_worked_with) {
    throw httpError(409, 'This worker has not opted in to being found, and has not worked with you');
  }
  return rows[0];
}

// ------------------------------------------------ lists
router.get('/lists', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.created_at, l.updated_at,
              (SELECT COUNT(*)::int FROM talent_list_members m WHERE m.list_id = l.id) AS member_count
       FROM talent_lists l WHERE l.business_id = $1 ORDER BY l.name`, [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/lists', authenticate, requireRole('business'), async(req, res, next) => {
  const client = await pool.connect();
  try {
    const name = text((req.body || {}).name, 'List name', 2, 80);
    await client.query('BEGIN');
    // Lock the business row so concurrent creates cannot exceed the list limit.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const count = await client.query('SELECT COUNT(*)::int AS n FROM talent_lists WHERE business_id = $1', [req.user.id]);
    if (count.rows[0].n >= MAX_LISTS) throw httpError(409, `You can keep up to ${MAX_LISTS} lists`);
    const { rows } = await client.query(
      'INSERT INTO talent_lists (business_id, name) VALUES ($1, $2) RETURNING id, name, created_at', [req.user.id, name]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return next(httpError(409, 'You already have a list with that name'));
    next(err);
  } finally {
    client.release();
  }
});

router.get('/lists/:id', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.id, 'list');
    const list = await ownList(pool, req.params.id, req.user.id);
    await expireInvitations(pool);
    const { rows } = await pool.query(
      `SELECT u.id AS worker_id, u.name, u.categories, u.languages, u.timezone, u.discoverable, m.added_at,
              (SELECT COUNT(*)::int FROM worker_assessments wa WHERE wa.worker_id = u.id AND wa.status = 'verified') AS verified_count,
              (SELECT COUNT(*)::int FROM talent_notes n WHERE n.worker_id = u.id AND n.business_id = $2) AS notes_count
       FROM talent_list_members m JOIN users u ON u.id = m.worker_id
       WHERE m.list_id = $1 ORDER BY u.name`, [list.id, req.user.id]
    );
    res.json({ id: list.id, name: list.name, members: rows });
  } catch (err) { next(err); }
});

router.patch('/lists/:id', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.id, 'list');
    await ownList(pool, req.params.id, req.user.id);
    const name = text((req.body || {}).name, 'List name', 2, 80);
    const { rows } = await pool.query(
      'UPDATE talent_lists SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name', [req.params.id, name]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return next(httpError(409, 'You already have a list with that name'));
    next(err);
  }
});

router.delete('/lists/:id', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.id, 'list');
    await ownList(pool, req.params.id, req.user.id);
    await pool.query('DELETE FROM talent_lists WHERE id = $1', [req.params.id]);
    res.json({ id: req.params.id, deleted: true });
  } catch (err) { next(err); }
});

router.post('/lists/:id/members', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.id, 'list');
    await ownList(pool, req.params.id, req.user.id);
    const workerId = (req.body || {}).worker_id;
    checkId(String(workerId || ''), 'worker');
    await savableWorker(pool, workerId, req.user.id);
    await pool.query(
      `INSERT INTO talent_list_members (list_id, worker_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.params.id, workerId]
    );
    res.status(201).json({ list_id: req.params.id, worker_id: workerId });
  } catch (err) { next(err); }
});

router.delete('/lists/:id/members/:workerId', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.id, 'list');
    checkId(req.params.workerId, 'worker');
    await ownList(pool, req.params.id, req.user.id);
    await pool.query('DELETE FROM talent_list_members WHERE list_id = $1 AND worker_id = $2', [req.params.id, req.params.workerId]);
    res.json({ list_id: req.params.id, worker_id: req.params.workerId, removed: true });
  } catch (err) { next(err); }
});

// ------------------------------------------------ notes (private to the business)
router.get('/workers/:workerId/notes', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.workerId, 'worker');
    const { rows } = await pool.query(
      `SELECT id, body, created_at FROM talent_notes WHERE business_id = $1 AND worker_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, req.params.workerId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/workers/:workerId/notes', authenticate, requireRole('business'), async(req, res, next) => {
  const client = await pool.connect();
  try {
    checkId(req.params.workerId, 'worker');
    const body = text((req.body || {}).body, 'Note', 3, 1000);
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const { rows: w } = await client.query(`SELECT id FROM users WHERE id = $1 AND role = 'worker'`, [req.params.workerId]);
    if (w.length === 0) throw httpError(404, 'Worker not found');
    const count = await client.query('SELECT COUNT(*)::int AS n FROM talent_notes WHERE business_id = $1 AND worker_id = $2', [req.user.id, req.params.workerId]);
    if (count.rows[0].n >= MAX_NOTES_PER_WORKER) throw httpError(409, `You can keep up to ${MAX_NOTES_PER_WORKER} notes about one worker`);
    const { rows } = await client.query(
      'INSERT INTO talent_notes (business_id, worker_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at',
      [req.user.id, req.params.workerId, body]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/notes/:id', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    checkId(req.params.id, 'note');
    const { rowCount } = await pool.query('DELETE FROM talent_notes WHERE id = $1 AND business_id = $2', [req.params.id, req.user.id]);
    if (rowCount === 0) throw httpError(404, 'Note not found');
    res.json({ id: req.params.id, deleted: true });
  } catch (err) { next(err); }
});

// ------------------------------------------------ invitations
router.get('/open-tasks', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title FROM bounties WHERE business_id = $1 AND status = 'open' AND deadline > NOW() ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/invitations', authenticate, requireRole('business'), async(req, res, next) => {
  const client = await pool.connect();
  const notices = [];
  try {
    const b = req.body || {};
    checkId(String(b.worker_id || ''), 'worker');
    const message = text(b.message, 'Message', 10, 500);
    let bountyId = null;
    if (b.bounty_id !== undefined && b.bounty_id !== null && b.bounty_id !== '') {
      checkId(String(b.bounty_id), 'task');
      bountyId = String(b.bounty_id);
    }

    await client.query('BEGIN');
    const { rows: w } = await client.query('SELECT id, name, role, discoverable FROM users WHERE id = $1', [b.worker_id]);
    if (w.length === 0 || w[0].role !== 'worker') throw httpError(404, 'Worker not found');
    if (!w[0].discoverable) throw httpError(409, 'This worker has not opted in to being found, so they cannot be invited');

    if (bountyId) {
      const { rows: t } = await client.query(
        `SELECT id, title, status, deadline FROM bounties WHERE id = $1 AND business_id = $2 FOR SHARE`, [bountyId, req.user.id]
      );
      if (t.length === 0) throw httpError(404, 'Task not found');
      if (t[0].status !== 'open' || new Date(t[0].deadline) <= new Date()) throw httpError(409, 'Only open tasks can be offered');
    }

    const { rows } = await client.query(
      `INSERT INTO talent_invitations (business_id, worker_id, bounty_id, message, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)
       RETURNING id, worker_id, bounty_id, message, status, created_at, expires_at`,
      [req.user.id, b.worker_id, bountyId, message, String(INVITATION_DAYS)]
    );
    notices.push([b.worker_id, 'A business has sent you an invitation. You can accept or decline it.', '#/invitations']);
    await client.query('COMMIT');
    notifyAfterCommit(notices);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return next(httpError(409, 'You already have a pending invitation for this worker and task'));
    next(err);
  } finally {
    client.release();
  }
});

router.get('/invitations', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    await expireInvitations(pool);
    const { rows } = await pool.query(
      `SELECT i.id, i.status, i.message, i.created_at, i.responded_at, i.expires_at,
              u.name AS worker_name, b.title AS task_title
       FROM talent_invitations i
       JOIN users u ON u.id = i.worker_id
       LEFT JOIN bounties b ON b.id = i.bounty_id
       WHERE i.business_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/invitations/:id/withdraw', authenticate, requireRole('business'), async(req, res, next) => {
  const client = await pool.connect();
  try {
    checkId(req.params.id, 'invitation');
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, business_id, status FROM talent_invitations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (rows.length === 0 || rows[0].business_id !== req.user.id) throw httpError(404, 'Invitation not found');
    if (rows[0].status !== 'pending') throw httpError(409, 'Only a pending invitation can be withdrawn');
    await client.query(`UPDATE talent_invitations SET status = 'withdrawn', responded_at = NOW() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ id: req.params.id, status: 'withdrawn' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/invitations/mine', authenticate, requireRole('worker'), async(req, res, next) => {
  try {
    await expireInvitations(pool);
    const { rows } = await pool.query(
      `SELECT i.id, i.status, i.message, i.created_at, i.responded_at, i.expires_at,
              u.name AS business_name, b.title AS task_title
       FROM talent_invitations i
       JOIN users u ON u.id = i.business_id
       LEFT JOIN bounties b ON b.id = i.bounty_id
       WHERE i.worker_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/invitations/:id/respond', authenticate, requireRole('worker'), async(req, res, next) => {
  const client = await pool.connect();
  const notices = [];
  try {
    checkId(req.params.id, 'invitation');
    const decision = (req.body || {}).decision;
    if (decision !== 'accept' && decision !== 'decline') throw httpError(400, 'Decision must be accept or decline');

    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, business_id, worker_id, bounty_id, status, expires_at FROM talent_invitations WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (rows.length === 0 || rows[0].worker_id !== req.user.id) throw httpError(404, 'Invitation not found');
    const inv = rows[0];
    if (inv.status !== 'pending') throw httpError(409, 'This invitation is no longer pending');
    if (new Date(inv.expires_at) <= new Date()) {
      await client.query(`UPDATE talent_invitations SET status = 'expired' WHERE id = $1`, [inv.id]);
      await client.query('COMMIT');
      throw httpError(409, 'This invitation has expired');
    }

    const status = decision === 'accept' ? 'accepted' : 'declined';
    await client.query('UPDATE talent_invitations SET status = $2, responded_at = NOW() WHERE id = $1', [inv.id, status]);
    notices.push([inv.business_id, `A worker ${status} your invitation.`, '#/talent/sent']);
    await client.query('COMMIT');
    notifyAfterCommit(notices);

    const nextStep = decision === 'accept' && inv.bounty_id
      ? 'You have accepted. Accepting does not assign you work or a payment. To take part, apply through the normal task process.'
      : decision === 'accept'
        ? 'You have accepted. This does not assign you any work or payment.'
        : 'You have declined this invitation.';
    res.json({ id: inv.id, status, next_step: nextStep });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
