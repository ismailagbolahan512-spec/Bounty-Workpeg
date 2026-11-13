// routes/matching.js — explainable matching between tasks and workers.
//
//   GET /api/matching/tasks/:bountyId   business owner: discoverable workers ranked for one task
//   GET /api/matching/tasks             worker: open tasks ranked for the signed-in worker
//
// Every result carries its score factors and plain-language reasons. Matching never uses location,
// and it never uses anything about a person's identity. Workers who have not opted in are never
// shown to a business.

const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole, httpError } = require('../middleware/auth');
const { scoreMatch, rank } = require('../services/matching');
const { workersReputation } = require('./reputation');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANDIDATE_LIMIT = 200;
const RESULT_LIMIT = 20;

const WORKER_COLUMNS = `id, name, categories, skills, timezone, languages, weekly_hours,
  to_char(available_from, 'YYYY-MM-DD') AS available_from`;

async function verifiedCategories(ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const { rows } = await pool.query(
    `SELECT DISTINCT wa.worker_id, a.category
     FROM worker_assessments wa JOIN assessments a ON a.id = wa.assessment_id
     WHERE wa.status = 'verified' AND wa.worker_id = ANY($1::uuid[])`, [ids]
  );
  for (const r of rows) map.get(r.worker_id).push(r.category);
  return map;
}

function publicMatch(item) {
  return { worker_id: item.id, name: item.name, score: item.score, factors: item.factors, reasons: item.reasons };
}

// ------------------------------------------------ GET /api/matching/tasks/:bountyId (business owner)
router.get('/tasks/:bountyId', authenticate, requireRole('business'), async(req, res, next) => {
  try {
    const bountyId = req.params.bountyId;
    if (!UUID_RE.test(bountyId)) throw httpError(400, 'Invalid bounty id');

    const { rows: bounties } = await pool.query(
      `SELECT b.id, b.title, b.category, b.deadline, b.business_id, u.timezone, u.languages
       FROM bounties b JOIN users u ON u.id = b.business_id WHERE b.id = $1`, [bountyId]
    );
    if (bounties.length === 0) throw httpError(404, 'Bounty not found');
    const task = bounties[0];
    if (task.business_id !== req.user.id) throw httpError(403, 'Only the business that posted this task can see matches');

    const { rows: candidates } = await pool.query(
      `SELECT ${WORKER_COLUMNS} FROM users
       WHERE role = 'worker' AND discoverable = TRUE
       ORDER BY updated_at DESC LIMIT $1`, [CANDIDATE_LIMIT]
    );
    const ids = candidates.map((c) => c.id);
    const [reputation, verified] = await Promise.all([workersReputation(ids), verifiedCategories(ids)]);

    const now = new Date();
    const scored = candidates.map((w) => {
      const worker = { ...w, reputation: reputation.get(w.id) || null, verified_assessment_categories: verified.get(w.id) || [] };
      return { id: w.id, name: w.name, ...scoreMatch(worker, task, task, now) };
    });
    res.json({ bounty_id: bountyId, results: rank(scored, RESULT_LIMIT).map(publicMatch) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ GET /api/matching/tasks (worker)
// Open tasks the worker may see (region limits apply), ranked. Shared with the opportunities page.
async function rankTasksForWorker(userId) {
  const { rows: me } = await pool.query(`SELECT ${WORKER_COLUMNS}, country FROM users WHERE id = $1`, [userId]);
  if (me.length === 0) throw httpError(404, 'Account not found');
  const worker = me[0];

  const { rows: tasks } = await pool.query(
    `SELECT b.id, b.title, b.category, b.deadline, b.business_id, u.timezone, u.languages
     FROM bounties b JOIN users u ON u.id = b.business_id
     WHERE b.status = 'open' AND b.deadline > NOW()
       AND (cardinality(b.regions) = 0 OR $2::char(2) = ANY(b.regions))
     ORDER BY b.created_at DESC LIMIT $1`, [CANDIDATE_LIMIT, worker.country || null]
  );
  const [reputation, verified] = await Promise.all([
    workersReputation([worker.id]), verifiedCategories([worker.id])
  ]);
  const profile = {
    ...worker,
    reputation: reputation.get(worker.id) || null,
    verified_assessment_categories: verified.get(worker.id) || []
  };

  const now = new Date();
  const scored = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    deadline: t.deadline,
    ...scoreMatch(profile, t, { timezone: t.timezone, languages: t.languages }, now)
  }));
  return rank(scored, RESULT_LIMIT).map((r) => ({
    bounty_id: r.id, title: r.title, category: r.category, deadline: r.deadline,
    score: r.score, factors: r.factors, reasons: r.reasons
  }));
}

router.get('/tasks', authenticate, requireRole('worker'), async(req, res, next) => {
  try {
    res.json({ results: await rankTasksForWorker(req.user.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.rankTasksForWorker = rankTasksForWorker;
