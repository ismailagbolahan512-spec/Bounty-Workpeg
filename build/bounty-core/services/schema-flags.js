// services/schema-flags.js — one-shot, cached check for which new columns exist on this database.
// Lets the routes keep working before migrations 027–035 are applied. A column that is not there
// is treated as absent (not read, not written); once the migration goes in and the server restarts,
// the flag flips to true and the full feature works.
const { pool } = require('../db');

let cached = null;

async function readFlags() {
    const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'service_area')::int AS u_service_area,
          (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'work_modes')::int AS u_work_modes,
          (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'industry')::int AS u_industry,
          (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'available_start')::int AS u_available_start,
          (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'service_locations')::int AS t_service_locations
    `);
    const r = rows[0];
    return {
        userServiceArea: r.u_service_area > 0,
        userWorkModes: r.u_work_modes > 0,
        userIndustry: r.u_industry > 0,
        userHours: r.u_available_start > 0,
        serviceLocations: r.t_service_locations > 0,
    };
}

// Reads the flags the first time; every call after returns the cached result. Routes call this and
// drop columns the database does not yet have.
async function flags() {
    if (cached) return cached;
    try {
        cached = await readFlags();
    } catch (err) {
        // On any trouble reading the catalogue, assume none of the new columns are present.
        cached = { userServiceArea: false, userWorkModes: false, userIndustry: false, userHours: false, serviceLocations: false };
    }
    return cached;
}

// Lets tests reset the cache between runs.
function _reset() { cached = null; }

module.exports = { flags, _reset };
