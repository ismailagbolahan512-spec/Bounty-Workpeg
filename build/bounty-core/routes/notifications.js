// routes/notifications.js — in-app notifications, each also sent as an email.
//
// GET   /api/notifications            (signed in) latest 50 notifications
// PATCH /api/notifications/read-all   (signed in) mark all as read
//
// createNotification(userId, message, link) stores the notification and emails it.
// The email is best effort: a failed email never blocks the action that caused it.

const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { sendEmail, appUrl } = require('../services/email');

const router = express.Router();

router.get('/', authenticate, async(req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, message, link, read_at, created_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

router.patch('/read-all', authenticate, async(req, res, next) => {
    try {
        await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

async function emailNotification(userId, message, link) {
    const { rows } = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) return;

    const url = link && link.indexOf('#/') === 0 ? appUrl() + '/' + link : appUrl();
    await sendEmail({
        to: rows[0].email,
        subject: 'Bounty update',
        text: `Hi ${rows[0].name},\n\n${message}\n\nOpen Bounty: ${url}\n\nYou are getting this email because you have an account on Bounty.`,
    });
}

async function createNotification(userId, message, link) {
    await pool.query(
        'INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)', [userId, message, link || null]
    );
    emailNotification(userId, message, link).catch((err) => {
        console.error('✗ Notification email failed:', err.message);
    });
}

module.exports = router;
module.exports.createNotification = createNotification;
