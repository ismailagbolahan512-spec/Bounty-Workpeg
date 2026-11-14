// middleware/peg-cors.js — lets a Workpeg peg's browser call /api/peg, and nothing else.
//
// The peg is served from <namespace>.workpeg.com, so its calls are cross-origin. Only the
// Bearer integration token (bnt_wp_...) authenticates these calls. The Workpeg SDK's http.*
// always sets credentials: 'include' on its fetches, so we respond with
// Access-Control-Allow-Credentials: true to satisfy the browser's preflight. Any cookies the
// browser does send are ignored on the peg API — authenticateIntegration reads only the Bearer
// token and never consults cookies for these routes.
//
// PEG_ORIGINS is a comma-separated list of exact origins, for example
//   https://bounty.workpeg.com,https://bounty.dev.workpeg.com
// Wildcards, paths, query strings and plain http to a non-loopback host are refused, and the
// bad entry is dropped with a log line. An unset or empty list allows no origin.

const PEG_PATH = '/api/peg';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';
const MAX_AGE_SECONDS = 600;

function isLoopback(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// Returns the origin string if it is an exact, safe origin, otherwise null.
function safeOrigin(entry) {
    let url;
    try {
        url = new URL(entry);
    } catch {
        return null;
    }
    const secure = url.protocol === 'https:';
    const loopbackHttp = url.protocol === 'http:' && isLoopback(url.hostname);
    if (!secure && !loopbackHttp) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (entry.includes('*')) return null;
    return url.origin;
}

function parseOrigins(raw) {
    const origins = new Set();
    for (const entry of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const origin = safeOrigin(entry);
        if (origin) origins.add(origin);
        else console.error(`✗ PEG_ORIGINS entry refused: ${entry.slice(0, 120)}`);
    }
    return origins;
}

function pegCors(options = {}) {
    const origins = parseOrigins(options.origins !== undefined ? options.origins : process.env.PEG_ORIGINS);

    return function pegCorsMiddleware(req, res, next) {
        if (req.originalUrl.split('?')[0].indexOf(PEG_PATH) !== 0) return next();
        const origin = req.headers.origin;
        res.vary('Origin');
        if (!origin || !origins.has(origin)) {
            // Not an allowed peg: send no CORS headers, so the browser refuses to read the answer.
            if (req.method === 'OPTIONS') return res.status(403).end();
            return next();
        }
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.set('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
        // The Workpeg SDK's http.* always fetches with credentials: 'include'. Setting this header
        // satisfies the browser's preflight. Any cookies the browser does send are ignored by the
        // integration auth path (authenticateIntegration reads only the Bearer token).
        res.set('Access-Control-Allow-Credentials', 'true');
        if (req.method === 'OPTIONS') return res.status(204).end();
        return next();
    };
}

module.exports = { pegCors, parseOrigins, safeOrigin, PEG_PATH };
