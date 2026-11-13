const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticate, httpError } = require('../middleware/auth');
const { publicPortfolio } = require('../services/portfolio');
const { workerReputation } = require('./reputation');
const { validTimezone } = require('../services/matching');
const { isCountry } = require('../services/regions');

const CATEGORIES = ['dev', 'design', 'content', 'marketing', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_ME = `SELECT id, email, name, role, bio, avatar_url, categories, skills, website, location,
  onboarding_done, total_earned, reputation_score,
  timezone, languages, weekly_hours, to_char(available_from, 'YYYY-MM-DD') AS available_from, discoverable, country,
  is_admin
  FROM users WHERE id = $1`;

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    bio: row.bio,
    avatar_url: row.avatar_url,
    categories: row.categories || [],
    skills: row.skills || '',
    website: row.website || '',
    location: row.location || '',
    onboarding_done: row.onboarding_done,
    total_earned: row.total_earned,
    reputation_score: row.reputation_score,
    timezone: row.timezone || '',
    languages: row.languages || [],
    weekly_hours: row.weekly_hours === null || row.weekly_hours === undefined ? null : Number(row.weekly_hours),
    available_from: row.available_from || null,
    discoverable: row.discoverable === true,
    country: row.country ? String(row.country).trim() : null,
    is_admin: row.is_admin === true
  };
}

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(SELECT_ME, [req.user.id]);
    if (!rows.length) throw httpError(404, 'Account not found');
    res.json(publicUser(rows[0]));
  } catch (err) { next(err); }
});

router.get('/business/:id', authenticate, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw httpError(400, 'Invalid company id');
    const { rows } = await pool.query(
      `SELECT id, name, bio, avatar_url, website, location FROM users WHERE id = $1 AND role = 'business'`,
      [id]
    );
    if (!rows.length) throw httpError(404, 'Company not found');
    const stats = await pool.query(
      `SELECT COUNT(*)::int AS posted,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM bounties WHERE business_id = $1`,
      [id]
    );
    res.json(Object.assign({}, rows[0], {
      website: rows[0].website || '',
      location: rows[0].location || '',
      bounties_posted: stats.rows[0].posted,
      bounties_completed: stats.rows[0].completed
    }));
  } catch (err) { next(err); }
});

router.patch('/me', authenticate, async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = [];
    const values = [];
    function add(column, value) {
      values.push(value);
      fields.push(column + ' = $' + values.length);
    }

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2 || name.length > 100) throw httpError(400, 'Name must be 2 to 100 characters');
      add('name', name);
    }
    if (body.bio !== undefined) {
      const bio = String(body.bio).trim();
      if (bio.length > 500) throw httpError(400, 'Bio must be 500 characters or fewer');
      add('bio', bio);
    }
    if (body.avatar_url !== undefined) {
      const avatar = String(body.avatar_url);
      if (!avatar.startsWith('data:image/') || avatar.length > 300000) {
        throw httpError(400, 'Photo must be an image under about 300KB');
      }
      add('avatar_url', avatar);
    }
    if (body.categories !== undefined) {
      if (!Array.isArray(body.categories)) throw httpError(400, 'Categories must be a list');
      const cats = body.categories.map(String).filter(function(c) { return CATEGORIES.indexOf(c) !== -1; });
      add('categories', cats);
    }
    if (body.skills !== undefined) {
      const skills = String(body.skills).trim();
      if (skills.length > 300) throw httpError(400, 'Skills must be 300 characters or fewer');
      add('skills', skills);
    }
    if (body.website !== undefined) {
      const website = String(body.website).trim();
      if (website && !/^https?:\/\//i.test(website)) throw httpError(400, 'Website must start with http:// or https://');
      if (website.length > 200) throw httpError(400, 'Website must be 200 characters or fewer');
      add('website', website);
    }
    if (body.location !== undefined) {
      const location = String(body.location).trim();
      if (location.length > 100) throw httpError(400, 'Location must be 100 characters or fewer');
      add('location', location);
    }
    if (body.timezone !== undefined) {
      const zone = String(body.timezone).trim();
      if (zone && !validTimezone(zone)) throw httpError(400, 'Time zone must be a valid IANA name, such as Europe/London');
      add('timezone', zone);
    }
    if (body.languages !== undefined) {
      if (!Array.isArray(body.languages)) throw httpError(400, 'Languages must be a list');
      const langs = [...new Set(body.languages.map((l) => String(l).trim()).filter(Boolean))];
      if (langs.length > 10 || langs.some((l) => l.length > 40)) {
        throw httpError(400, 'Use up to 10 languages, each 40 characters or fewer');
      }
      add('languages', langs);
    }
    if (body.weekly_hours !== undefined) {
      if (body.weekly_hours === null || body.weekly_hours === '') {
        add('weekly_hours', null);
      } else {
        const hours = Number(body.weekly_hours);
        if (!Number.isInteger(hours) || hours < 0 || hours > 80) throw httpError(400, 'Weekly hours must be a whole number from 0 to 80');
        add('weekly_hours', hours);
      }
    }
    if (body.available_from !== undefined) {
      if (body.available_from === null || body.available_from === '') {
        add('available_from', null);
      } else {
        const d = String(body.available_from);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) {
          throw httpError(400, 'Available-from must be a date in YYYY-MM-DD format');
        }
        add('available_from', d);
      }
    }
    if (body.discoverable !== undefined) {
      if (typeof body.discoverable !== 'boolean') throw httpError(400, 'Discoverable must be true or false');
      add('discoverable', body.discoverable);
    }
    if (body.country !== undefined) {
      const code = body.country === null || body.country === '' ? null : String(body.country).trim().toUpperCase();
      if (code && !isCountry(code)) throw httpError(400, 'Choose a country from the list');
      add('country', code);
    }
    if (body.onboarding_done !== undefined) add('onboarding_done', body.onboarding_done === true);

    if (!fields.length) throw httpError(400, 'Nothing to update');

    values.push(req.user.id);
    const updated = await pool.query(
      'UPDATE users SET ' + fields.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING id',
      values
    );
    if (!updated.rows.length) throw httpError(404, 'Account not found');

    const { rows } = await pool.query(SELECT_ME, [req.user.id]);
    res.json(publicUser(rows[0]));
  } catch (err) { next(err); }
});

// ------------------------------------------------ GET /worker/:id  (public portfolio)
// Shows skills, reputation, reviews and completed bounty titles.
// Deliberately omits email and earnings.
router.get('/worker/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw httpError(400, 'Invalid worker id');

    const { rows } = await pool.query(
      `SELECT id, name, bio, avatar_url, skills, categories, location, website, reputation_score
       FROM users WHERE id = $1 AND role = 'worker'`, [id]
    );
    if (!rows.length) throw httpError(404, 'Worker not found');

    const completed = await pool.query(
      `SELECT id, title, category, completed_at
       FROM bounties WHERE winner_id = $1 AND status = 'completed'
       ORDER BY completed_at DESC NULLS LAST LIMIT 20`, [id]
    );
    const reviews = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS average
       FROM reviews WHERE reviewee_id = $1`, [id]
    );
    const recentReviews = await pool.query(
      `SELECT r.rating, r.comment, r.created_at, u.name AS reviewer_name, b.title AS bounty_title
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_id
       JOIN bounties b ON b.id = r.bounty_id
       WHERE r.reviewee_id = $1
       ORDER BY r.created_at DESC LIMIT 10`, [id]
    );

    res.json({
      ...rows[0],
      website: rows[0].website || '',
      location: rows[0].location || '',
      categories: rows[0].categories || [],
      skills: rows[0].skills || '',
      completed_count: completed.rows.length,
      completed: completed.rows,
      review_count: reviews.rows[0].count,
      review_average: reviews.rows[0].average,
      reviews: recentReviews.rows,
      portfolio: await publicPortfolio(id),
      reputation: await workerReputation(id),
      verified_assessments: (await pool.query(
        `SELECT a.title, a.category, a.difficulty, wa.reviewed_at
         FROM worker_assessments wa JOIN assessments a ON a.id = wa.assessment_id
         WHERE wa.worker_id = $1 AND wa.status = 'verified' ORDER BY wa.reviewed_at DESC`, [id]
      )).rows
    });
  } catch (err) { next(err); }
});

module.exports = router;