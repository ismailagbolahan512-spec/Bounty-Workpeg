// middleware/errorHandler.js — centralized error handling
// Register AFTER all routes:  app.use(notFound); app.use(errorHandler);

function notFound(req, res, next) {
    res.status(404).json({ message: 'Route not found: ' + req.method + ' ' + req.originalUrl });
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    // err.expose marks an expected, user-facing failure (for example "AI planning is not configured").
    const shown = status < 500 || err.expose;
    if (status >= 500 && !err.expose) console.error('✗ Server error:', err);
    const body = { message: shown ? err.message : 'Internal server error' };
    if (shown && err.details) Object.assign(body, err.details);
    res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
