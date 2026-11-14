// routes/payments-webhook.js — Pandascrow webhooks.
//
// Each request is checked before anything is parsed or stored:
//   1. The signature is HMAC-SHA256 of the raw body, keyed with the secret key, compared in constant time.
//   2. The timestamp is within five minutes of this server's clock.
//   3. Only known event types are recorded, once per event id (resends are ignored).
// Recording an event does NOT move money or unlock any file. Those decisions need a separate server-side
// status check against Pandascrow, which is not built yet.
//
// Mounted in index.js before express.json, so the raw bytes are still available for the signature.
// Required environment variable: PANDASCROW_SECRET_KEY (starts with sklive or sktest).

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');

const router = express.Router();
const TOLERANCE_SECONDS = 300;
const EVENT_TYPES = new Set([
    'escrow.paid', 'escrow.completed', 'invoice.paid', 'wallet.deposit.success', 'escrow.created',
    'escrow.dispute.opened', 'escrow.payout.completed', 'escrow.dispute.resolved',
]);

function environmentOf(secret) {
    if (secret.startsWith('sklive')) return 'live';
    if (secret.startsWith('sktest')) return 'test';
    return null;
}

router.post('/', express.raw({ type: () => true, limit: '64kb' }), async(req, res) => {
    try {
        const secret = process.env.PANDASCROW_SECRET_KEY || '';
        const environment = environmentOf(secret);
        if (!environment) return res.status(503).json({ message: 'Payment webhooks are not configured' });

        const raw = req.body;
        if (!Buffer.isBuffer(raw) || raw.length === 0) return res.status(400).json({ message: 'Empty body' });

        const signature = req.get('x-pandascrow-signature') || '';
        if (!/^[0-9a-f]{64}$/.test(signature)) return res.status(401).json({ message: 'Invalid signature' });

        const timestamp = Number(req.get('x-pandascrow-timestamp'));
        if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) {
            return res.status(401).json({ message: 'Timestamp outside the allowed window' });
        }

        const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            return res.status(401).json({ message: 'Invalid signature' });
        }

        const eventType = req.get('x-pandascrow-event') || '';
        let event;
        try { event = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ message: 'Body is not JSON' }); }

        // Unknown event types are acknowledged so the provider stops resending them, but are not stored.
        if (!EVENT_TYPES.has(eventType)) return res.status(200).json({ received: true, recorded: false });

        if (!event || typeof event.id !== 'string' || !/^evt_\S{1,100}$/.test(event.id)) {
            return res.status(400).json({ message: 'Event has no valid id' });
        }

        const result = await pool.query(
            `INSERT INTO payment_webhook_events (id, event_type, environment, payload)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO NOTHING`,
            [event.id, eventType, environment, event]
        );
        res.status(200).json({ received: true, recorded: result.rowCount === 1 });
    } catch (err) {
        console.error('✗ Webhook error:', err.message);
        res.status(500).json({ message: 'Could not record the event' });
    }
});

module.exports = router;
