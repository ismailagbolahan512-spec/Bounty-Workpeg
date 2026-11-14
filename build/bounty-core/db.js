// db.js — shared PostgreSQL pool
// Requires env var: DATABASE_URL (Neon connection string)
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon requires SSL. Set DATABASE_SSL=false only for a local test database.
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 10, // connection pool size
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
    // Idle client error — log, don't crash silently
    console.error('Unexpected PostgreSQL pool error:', err);
});

module.exports = { pool };