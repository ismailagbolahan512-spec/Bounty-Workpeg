// middleware/ratelimit.js — fixed-window limiter, keyed by client IP.
// In-memory: counts reset on restart and are per instance. Fine for one
// Render instance; move to a shared store (Redis/Postgres) if you scale out.
// Requires app.set('trust proxy', 1) so req.ip is the real client, not Render's proxy.

function rateLimit({ windowMs, max, message }) {
    const hits = new Map();

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.reset <= now) hits.delete(key);
        }
    }, windowMs);
    sweep.unref();

    return function(req, res, next) {
        const key = req.ip || 'unknown';
        const now = Date.now();

        let entry = hits.get(key);
        if (!entry || entry.reset <= now) {
            entry = { count: 0, reset: now + windowMs };
            hits.set(key, entry);
        }

        entry.count += 1;
        if (entry.count > max) {
            res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
            return res.status(429).json({ message: message || 'Too many requests. Try again shortly.' });
        }
        next();
    };
}

module.exports = { rateLimit };
