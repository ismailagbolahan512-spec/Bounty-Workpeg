// middleware/signin-limit.js — limits guessing on sign-in. In memory: resets on restart, per instance.
//
// Two limits, both counting failed sign-ins only:
//   1. Per account AND network (email + IP): SIGNIN_MAX_FAILURES (default 10) in 15 minutes.
//      One attacker on their own network can lock only their own attempts. The account owner, on
//      another network, can still sign in.
//   2. Per account, any network: SIGNIN_MAX_PER_EMAIL (default 50) in an hour. This stops guessing
//      spread across many networks. Its cost: a determined attacker can delay one account for an hour.
// A successful sign-in clears the count for that account and network.
// The per-IP cap for all of /api/auth lives in index.js (AUTH_IP_LIMIT).

const WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_FAILURES = Number(process.env.SIGNIN_MAX_FAILURES) || 10;
const MAX_EMAIL_FAILURES = Number(process.env.SIGNIN_MAX_PER_EMAIL) || 50;
const byPair = new Map();  // "email|ip" -> { count, reset }
const byEmail = new Map(); // "email"    -> { count, reset }

function keyOf(email) {
    return String(email || '').trim().toLowerCase();
}

function live(map, key, now) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.reset <= now) { map.delete(key); return null; }
    return entry;
}

function bump(map, key, windowMs, now) {
    let entry = live(map, key, now);
    if (!entry) {
        entry = { count: 0, reset: now + windowMs };
        map.set(key, entry);
    }
    entry.count += 1;
}

// Seconds until sign-in is allowed again for this account from this network, or 0 if not locked.
function lockedSeconds(email, ip) {
    const now = Date.now();
    const k = keyOf(email);
    const pair = live(byPair, k + '|' + (ip || 'unknown'), now);
    if (pair && pair.count >= MAX_FAILURES) return Math.ceil((pair.reset - now) / 1000);
    const all = live(byEmail, k, now);
    if (all && all.count >= MAX_EMAIL_FAILURES) return Math.ceil((all.reset - now) / 1000);
    return 0;
}

function recordFailure(email, ip) {
    const now = Date.now();
    const k = keyOf(email);
    bump(byPair, k + '|' + (ip || 'unknown'), WINDOW_MS, now);
    bump(byEmail, k, HOUR_MS, now);
}

function clearFailures(email, ip) {
    byPair.delete(keyOf(email) + '|' + (ip || 'unknown'));
}

// Keeps memory bounded: expired windows are dropped.
const sweep = setInterval(() => {
    const now = Date.now();
    for (const map of [byPair, byEmail]) {
        for (const [k, entry] of map) {
            if (entry.reset <= now) map.delete(k);
        }
    }
}, WINDOW_MS);
sweep.unref();

module.exports = { lockedSeconds, recordFailure, clearFailures, MAX_FAILURES, MAX_EMAIL_FAILURES };
