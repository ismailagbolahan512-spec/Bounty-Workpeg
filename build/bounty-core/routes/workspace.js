// routes/workspace.js — deliverables for team tasks.
//
//   GET   /api/workspace/:bountyId                 deliverables with progress (business and participants)
//   POST  /api/workspace/:bountyId                 business creates a deliverable
//   PATCH /api/workspace/deliverables/:id          role-based transitions (see TRANSITIONS below)
//   GET   /api/workspace/:bountyId/timeline        change history (business and participants)
//
// Rules
//   * Only the business and people on the task (participants who have not withdrawn, or submitters) can see the workspace.
//   * The business plans the work (creates, edits while planned, assigns, accepts or requests changes).
//   * A participant claims, starts, delivers, blocks and unblocks work assigned to them (or unassigned, on claim).
//   * A deliverable cannot start until the deliverable it depends on is accepted.
//   * Dependencies form no cycles and stay inside the same task.
//   * Every change is locked on the deliverable row and recorded in the timeline in the same transaction.

const express = require('express');
const { pool } = require('../db');
const { authenticate, httpError } = require('../middleware/auth');
const { notifyAfterCommit } = require('../services/execution');
const { assertConfidentialAccess } = require('../services/protection');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['planned', 'in_progress', 'delivered', 'accepted', 'blocked'];
const MAX_DEPTH = 50;

// Allowed transitions, keyed by "from>to", with who may make them.
const TRANSITIONS = {
  'planned>in_progress': 'participant',
  'in_progress>delivered': 'participant',
  'in_progress>blocked': 'participant',
  'blocked>in_progress': 'participant',
  'delivered>accepted': 'business',
  'delivered>in_progress': 'business',
};

function checkId(id, label) {
  if (!UUID_RE.test(id)) throw httpError(400, `Invalid ${label} id`);
}

function httpsLink(value) {
  if (value === undefined || value === null || value === '') return null;
  const link = String(value).trim();
  if (!/^https:\/\//i.test(link) || link.length > 255) throw httpError(400, 'Link must be an https address of 255 characters or fewer');
  return link;
}

function parseDeliverable(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  if (!partial || b.title !== undefined) {
    const title = String(b.title || '').trim();
    if (title.length < 3 || title.length > 160) throw httpError(400, 'Title must be 3 to 160 characters');
    out.title = title;
  }
  if (b.component !== undefined) {
    const component = String(b.component || '').trim();
    if (component.length > 160) throw httpError(400, 'Component must be 160 characters or fewer');
    out.component = component || null;
  }
  if (b.description !== undefined) {
    const description = String(b.description || '').trim();
    if (description.length > 1000) throw httpError(400, 'Description must be 1000 characters or fewer');
    out.description = description;
  }
  if (b.link !== undefined) out.link = httpsLink(b.link);
  if (b.due_at !== undefined) {
    if (b.due_at === null || b.due_at === '') out.due_at = null;
    else {
      const due = new Date(b.due_at);
      if (Number.isNaN(due.getTime())) throw httpError(400, 'Due date is not valid');
      out.due_at = due.toISOString();
    }
  }
  if (b.depends_on !== undefined) {
    if (b.depends_on === null || b.depends_on === '') out.depends_on = null;
    else {
      checkId(String(b.depends_on), 'dependency');
      out.depends_on = String(b.depends_on);
    }
  }
  if (b.worker_id !== undefined) {
    if (b.worker_id === null || b.worker_id === '') out.worker_id = null;
    else {
      checkId(String(b.worker_id), 'worker');
      out.worker_id = String(b.worker_id);
    }
  }
  return out;
}

// Returns the caller's role on a task, or throws. Participants and submitters both count as team members.
async function memberRole(db, bountyId, userId) {
  const { rows } = await db.query(
    `SELECT b.business_id,
            EXISTS (SELECT 1 FROM bounty_participants p
                    WHERE p.bounty_id = b.id AND p.worker_id = $2 AND p.status <> 'withdrawn') AS is_participant,
            EXISTS (SELECT 1 FROM submissions s WHERE s.bounty_id = b.id AND s.worker_id = $2) AS is_submitter,
            b.confidential
     FROM bounties b WHERE b.id = $1`, [bountyId, userId]
  );
  if (rows.length === 0) throw httpError(404, 'Task not found');
  if (rows[0].business_id === userId) return 'business';
  if (rows[0].is_participant || rows[0].is_submitter) {
    await assertConfidentialAccess((sql, params) => db.query(sql, params), bountyId, userId, rows[0].confidential);
    return 'participant';
  }
  throw httpError(403, 'Only the business and people on this task can see its workspace');
}

// Walks the dependency chain from `start`. Returns true if it reaches `target` (which would be a cycle).
async function reaches(db, start, target, bountyId) {
  let current = start;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    if (current === target) return true;
    const { rows } = await db.query(
      'SELECT depends_on FROM workspace_deliverables WHERE id = $1 AND bounty_id = $2', [current, bountyId]
    );
    if (rows.length === 0) return false;
    current = rows[0].depends_on;
  }
  return false;
}

async function recordEvent(db, deliverableId, actorId, event, detail = {}) {
  await db.query(
    'INSERT INTO workspace_deliverable_events (deliverable_id, actor_id, event, detail) VALUES ($1, $2, $3, $4)',
    [deliverableId, actorId, event, JSON.stringify(detail)]
  );
}

function progressOf(rows) {
  const total = rows.length;
  const count = (s) => rows.filter((r) => r.status === s).length;
  const accepted = count('accepted');
  return {
    total,
    planned: count('planned'),
    in_progress: count('in_progress'),
    delivered: count('delivered'),
    accepted,
    blocked: count('blocked'),
    percent: total === 0 ? 0 : Math.round((accepted / total) * 100),
  };
}

// ------------------------------------------------ GET /api/workspace/:bountyId
router.get('/:bountyId', authenticate, async(req, res, next) => {
  try {
    checkId(req.params.bountyId, 'task');
    const role = await memberRole(pool, req.params.bountyId, req.user.id);
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.component, d.description, d.link, d.status, d.blocked_reason, d.due_at,
              d.depends_on, d.worker_id, d.created_at, d.updated_at, u.name AS worker_name,
              (dep.status IS NULL OR dep.status = 'accepted') AS dependency_met
       FROM workspace_deliverables d
       LEFT JOIN users u ON u.id = d.worker_id
       LEFT JOIN workspace_deliverables dep ON dep.id = d.depends_on
       WHERE d.bounty_id = $1 ORDER BY d.created_at ASC`, [req.params.bountyId]
    );
    res.json({ role, progress: progressOf(rows), deliverables: rows });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ POST /api/workspace/:bountyId (business)
router.post('/:bountyId', authenticate, async(req, res, next) => {
  const client = await pool.connect();
  const notices = [];
  try {
    checkId(req.params.bountyId, 'task');
    const role = await memberRole(client, req.params.bountyId, req.user.id);
    if (role !== 'business') throw httpError(403, 'Only the business can add deliverables');
    const input = parseDeliverable(req.body);
    if (input.worker_id) await assertParticipant(client, req.params.bountyId, input.worker_id);

    await client.query('BEGIN');
    // Lock the task so concurrent additions cannot exceed the deliverable limit.
    await client.query('SELECT id FROM bounties WHERE id = $1 FOR UPDATE', [req.params.bountyId]);
    const count = await client.query('SELECT COUNT(*)::int AS n FROM workspace_deliverables WHERE bounty_id = $1', [req.params.bountyId]);
    if (count.rows[0].n >= 50) throw httpError(409, 'A task can have at most 50 deliverables');
    if (input.depends_on) {
      const dep = await client.query('SELECT id FROM workspace_deliverables WHERE id = $1 AND bounty_id = $2', [input.depends_on, req.params.bountyId]);
      if (dep.rows.length === 0) throw httpError(400, 'The dependency must be a deliverable on this task');
    }
    const { rows } = await client.query(
      `INSERT INTO workspace_deliverables (bounty_id, worker_id, title, component, description, link, due_at, depends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, component, description, link, status, due_at, depends_on, worker_id`,
      [req.params.bountyId, input.worker_id || null, input.title, input.component || null, input.description || '',
        input.link || null, input.due_at || null, input.depends_on || null, req.user.id]
    );
    await recordEvent(client, rows[0].id, req.user.id, 'created', { title: input.title });
    if (input.worker_id) notices.push([input.worker_id, `You have been assigned "${input.title}".`, '#/bounties/' + req.params.bountyId]);
    await client.query('COMMIT');
    notifyAfterCommit(notices);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

async function assertParticipant(db, bountyId, workerId) {
  const { rows } = await db.query(
    `SELECT 1 FROM bounty_participants WHERE bounty_id = $1 AND worker_id = $2 AND status <> 'withdrawn'`, [bountyId, workerId]
  );
  if (rows.length === 0) throw httpError(400, 'Assign only a worker who is on this task');
}

// ------------------------------------------------ PATCH /api/workspace/deliverables/:id
router.patch('/deliverables/:id', authenticate, async(req, res, next) => {
  const client = await pool.connect();
  const notices = [];
  try {
    checkId(req.params.id, 'deliverable');
    const body = req.body || {};
    const hasStatus = body.status !== undefined;
    if (hasStatus && !STATUSES.includes(body.status)) throw httpError(400, 'Status is not valid');

    await client.query('BEGIN');
    const { rows: found } = await client.query(
      'SELECT * FROM workspace_deliverables WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (found.length === 0) throw httpError(404, 'Deliverable not found');
    const d = found[0];
    const role = await memberRole(client, d.bounty_id, req.user.id);
    const { rows: bountyRows } = await client.query('SELECT title, business_id FROM bounties WHERE id = $1', [d.bounty_id]);
    const bounty = bountyRows[0];
    const link = '#/bounties/' + d.bounty_id;

    const updates = {};
    const events = [];

    // Field edits: the business only, and only while the deliverable is still planned.
    // A delivery link travels with the delivered transition, so it is not a field edit.
    const wantsDeliveryLink = body.status === 'delivered' && body.link !== undefined;
    const editKeys = ['title', 'component', 'description', 'link', 'due_at', 'depends_on', 'worker_id']
      .filter((k) => body[k] !== undefined && !(k === 'link' && wantsDeliveryLink));
    const editBody = {};
    for (const k of editKeys) editBody[k] = body[k];
    const fieldInput = parseDeliverable(editBody, { partial: true });
    const hasFieldEdits = editKeys.length > 0;
    if (hasFieldEdits) {
      if (role !== 'business') throw httpError(403, 'Only the business can change a deliverable\'s details');
      if (d.status !== 'planned') throw httpError(409, 'Details can only change while the deliverable is planned');
      if (fieldInput.depends_on !== undefined && fieldInput.depends_on !== null) {
        if (fieldInput.depends_on === d.id) throw httpError(400, 'A deliverable cannot depend on itself');
        const dep = await client.query('SELECT id FROM workspace_deliverables WHERE id = $1 AND bounty_id = $2', [fieldInput.depends_on, d.bounty_id]);
        if (dep.rows.length === 0) throw httpError(400, 'The dependency must be a deliverable on this task');
        if (await reaches(client, fieldInput.depends_on, d.id, d.bounty_id)) {
          throw httpError(409, 'That dependency would create a loop');
        }
      }
      if (fieldInput.worker_id) await assertParticipant(client, d.bounty_id, fieldInput.worker_id);
      Object.assign(updates, fieldInput);
      events.push(['edited', { fields: Object.keys(fieldInput) }]);
      if (fieldInput.worker_id && fieldInput.worker_id !== d.worker_id) {
        notices.push([fieldInput.worker_id, `You have been assigned "${fieldInput.title || d.title}".`, link]);
      }
    }

    // Status transitions.
    if (hasStatus && body.status !== d.status) {
      const key = `${d.status}>${body.status}`;
      const allowedFor = TRANSITIONS[key];
      if (!allowedFor) throw httpError(409, `A deliverable cannot move from ${d.status} to ${body.status}`);
      if (allowedFor === 'business' && role !== 'business') throw httpError(403, 'Only the business can make this change');
      if (allowedFor === 'participant' && role !== 'participant') throw httpError(403, 'Only people on this task can make this change');
      if (allowedFor === 'participant' && role === 'business') throw httpError(403, 'The business plans the work; the assigned worker moves it forward');

      if (allowedFor === 'participant') {
        // Claim an unassigned deliverable, or act only on one assigned to you.
        if (d.worker_id === null) {
          if (body.status === 'in_progress' || d.status === 'planned') updates.worker_id = req.user.id;
        } else if (d.worker_id !== req.user.id) {
          throw httpError(403, 'This deliverable is assigned to someone else');
        }
      }

      if (body.status === 'in_progress' && d.depends_on) {
        const dep = await client.query('SELECT status, title FROM workspace_deliverables WHERE id = $1', [d.depends_on]);
        if (dep.rows.length && dep.rows[0].status !== 'accepted') {
          throw httpError(409, `Wait until "${dep.rows[0].title}" is accepted before starting this`);
        }
      }

      if (body.status === 'blocked') {
        const reason = String(body.blocked_reason || '').trim();
        if (reason.length < 5 || reason.length > 500) throw httpError(400, 'Say what is blocking this, in 5 to 500 characters');
        updates.blocked_reason = reason;
      } else if (d.status === 'blocked') {
        updates.blocked_reason = null;
      }

      if (body.status === 'delivered' && body.link !== undefined) updates.link = httpsLink(body.link);

      updates.status = body.status;
      events.push(['status_changed', { from: d.status, to: body.status }]);

      if (body.status === 'accepted') notices.push([d.worker_id, `"${d.title}" was accepted.`, link]);
      if (body.status === 'in_progress' && d.status === 'delivered') notices.push([d.worker_id, `"${d.title}" needs changes.`, link]);
      if (body.status === 'delivered') notices.push([bounty.business_id, `"${d.title}" was delivered for review.`, link]);
      if (body.status === 'blocked') notices.push([bounty.business_id, `"${d.title}" is blocked.`, link]);
    } else if (hasStatus && body.status === d.status && !hasFieldEdits) {
      throw httpError(409, 'The deliverable is already ' + d.status);
    }

    if (Object.keys(updates).length === 0) throw httpError(400, 'Nothing to update');

    const cols = Object.keys(updates);
    const values = cols.map((c) => updates[c]);
    values.push(d.id);
    const { rows } = await client.query(
      `UPDATE workspace_deliverables SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, title, component, description, link, status, blocked_reason, due_at, depends_on, worker_id`,
      values
    );
    for (const [event, detail] of events) await recordEvent(client, d.id, req.user.id, event, detail);
    await client.query('COMMIT');
    notifyAfterCommit(notices.filter(([who]) => who && who !== req.user.id));
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ------------------------------------------------ GET /api/workspace/:bountyId/timeline
router.get('/:bountyId/timeline', authenticate, async(req, res, next) => {
  try {
    checkId(req.params.bountyId, 'task');
    await memberRole(pool, req.params.bountyId, req.user.id);
    const { rows } = await pool.query(
      `SELECT e.id, e.event, e.detail, e.created_at, d.title AS deliverable_title, u.name AS actor_name
       FROM workspace_deliverable_events e
       JOIN workspace_deliverables d ON d.id = e.deliverable_id
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE d.bounty_id = $1
       ORDER BY e.created_at DESC, e.id DESC LIMIT 200`, [req.params.bountyId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
