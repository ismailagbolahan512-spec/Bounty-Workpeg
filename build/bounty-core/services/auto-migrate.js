// services/auto-migrate.js — runs idempotent schema changes at server startup, so a deploy does
// not need a separate database step. All changes are ALTER TABLE ... IF NOT EXISTS and similar,
// so running them on every boot is safe: the second pass is a no-op.
//
// If anything fails, the server still starts. The schema-flags module decides what features are
// ready based on what columns and tables actually exist; the routes degrade to a plain 503
// ("feature not ready") until the migration goes through.
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const schemaFlags = require('./schema-flags');

const BUNDLE = path.join(__dirname, '..', 'docs', 'hospitality-migrations.sql');

async function run() {
    let sql;
    try {
        sql = fs.readFileSync(BUNDLE, 'utf8');
    } catch (err) {
        console.warn('auto-migrate: bundle not found at', BUNDLE, '-', err.message);
        return { applied: false, reason: 'bundle not found' };
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        // Clear the cached schema flags so the running process picks up the new columns.
        schemaFlags._reset();
        console.log('✓ auto-migrate: hospitality schema is in place');
        return { applied: true };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('✗ auto-migrate: could not apply hospitality schema -', err.message);
        console.error('  The server will keep running. Hospitality features will say "not ready" until this is resolved.');
        return { applied: false, reason: err.message };
    } finally {
        client.release();
    }
}

module.exports = { run };
