require('dotenv').config();
const express = require('express');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const { rateLimit } = require('./middleware/ratelimit');

// Refuse to start in production with a weak or missing signing key. Tokens signed with a
// guessable secret can be forged, which would bypass every login.
const isProduction = process.env.NODE_ENV === 'production';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    const message = 'JWT_SECRET must be set and at least 32 characters long.';
    if (isProduction) throw new Error(message);
    console.warn('⚠ ' + message + ' Tokens will not be safe outside development.');
}

const app = express();
// Render sits behind a proxy; without this every user shares one IP for rate limits.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers. The page has no inline scripts or event-handler attributes, so scripts
// are limited to this origin. Inline style attributes are still used, so styles allow
// 'unsafe-inline'; fonts come from Google Fonts only.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
// Payment webhooks are mounted before the JSON parser: the signature must be checked against the exact bytes sent.
app.use('/api/payments/pandascrow/webhook', require('./routes/payments-webhook'));

app.use(express.json({ limit: '100kb' }));

app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));
// Many users share one IP on mobile networks, so these limits are generous.
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_IP_LIMIT) || 300, message: 'Too many attempts. Try again in 15 minutes.' }));
app.use('/api/auth/forgot', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many reset requests. Try again in an hour.' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/bounties', require('./routes/bounties'));
app.use('/api/classification', require('./routes/classification'));
app.use('/api/verification', require('./routes/verification'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api/reputation', require('./routes/reputation'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/duplicates', require('./routes/duplicates'));
app.use('/api/budget', require('./routes/budget'));
app.use('/api/matching', require('./routes/matching'));
app.use('/api/assessments', require('./routes/assessments'));
app.use('/api/workspace', require('./routes/workspace'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/global', require('./routes/global'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/submissions', require('./routes/files'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/portfolio', require('./routes/portfolio'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/protection', require('./routes/protection'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/integration-tokens', require('./routes/integration-tokens'));
app.use('/api/peg', require('./routes/peg'));

app.use(express.static(require('path').join(__dirname, 'public')));

app.use(notFound);
app.use(errorHandler);

app.listen(process.env.PORT || 3000, () => {
    console.log('✓ Server running on port', process.env.PORT || 3000);
});

module.exports = { notFound, errorHandler }