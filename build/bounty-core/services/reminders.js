// services/reminders.js — hourly reminders, 24 hours before a task deadline or a confirmed visit.
//
// Each reminder is sent once. The notification text is the dedupe key: if the same reminder
// already exists for that person and link, nothing is sent again.
// Reminder failures are logged and never stop the server.

const { pool } = require('../db');
const { createNotification } = require('../routes/notifications');

const HOUR_MS = 60 * 60 * 1000;
const WINDOW = "INTERVAL '24 hours'";

async function sendOnce(userId, message, link) {
    const { rows } = await pool.query(
        'SELECT 1 FROM notifications WHERE user_id = $1 AND message = $2 AND link IS NOT DISTINCT FROM $3 LIMIT 1',
        [userId, message, link]
    );
    if (rows.length > 0) return false;
    await createNotification(userId, message, link);
    return true;
}

// Workers on open tasks who have not submitted, with the deadline inside the window.
async function taskReminders() {
    const { rows } = await pool.query(
        `SELECT bp.worker_id, b.id AS bounty_id, b.title
         FROM bounty_participants bp
         JOIN bounties b ON b.id = bp.bounty_id
         WHERE bp.status = 'active' AND b.status = 'open'
           AND b.deadline > NOW() AND b.deadline <= NOW() + ${WINDOW}
           AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.bounty_id = b.id AND s.worker_id = bp.worker_id)`
    );
    let sent = 0;
    for (const r of rows) {
        const message = `Reminder: "${r.title}" is due within 24 hours. Submit your work before the deadline.`;
        if (await sendOnce(r.worker_id, message, '#/bounties/' + r.bounty_id)) sent += 1;
    }
    return sent;
}

// Confirmed hospitality visits starting inside the window: the provider and the business.
async function visitReminders() {
    const { rows } = await pool.query(
        `SELECT a.id, a.bounty_id, a.provider_id, b.business_id, b.title
         FROM appointments a
         JOIN bounties b ON b.id = a.bounty_id
         WHERE a.status = 'confirmed'
           AND a.starts_at > NOW() AND a.starts_at <= NOW() + ${WINDOW}`
    );
    let sent = 0;
    for (const r of rows) {
        const providerMsg = `Reminder: your visit for "${r.title}" starts within 24 hours.`;
        if (await sendOnce(r.provider_id, providerMsg, '#/services/appointments/' + r.id)) sent += 1;
        const businessMsg = `Reminder: the visit for "${r.title}" starts within 24 hours.`;
        if (await sendOnce(r.business_id, businessMsg, '#/services/' + r.bounty_id)) sent += 1;
    }
    return sent;
}

async function runOnce() {
    try {
        const tasks = await taskReminders();
        const visits = await visitReminders();
        if (tasks + visits > 0) console.log(`✓ reminders: ${tasks} task, ${visits} visit`);
    } catch (err) {
        console.error('✗ reminders failed:', err.message);
    }
}

// Starts the hourly job. Runs once shortly after boot, then every hour.
function start() {
    setTimeout(runOnce, 30 * 1000);
    setInterval(runOnce, HOUR_MS);
}

module.exports = { start, runOnce };
