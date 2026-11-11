// services/showcase/sync.js
// Pushes stale showcase rows to the publisher, and records the result in PostgreSQL.
// Run on demand by an admin action (Workpeg has no scheduler). Safe to run repeatedly.
//
// Concurrency: a row is set to 'published' only if showcase_version is unchanged since it was read.
// If the bounty changed during the publish, the trigger in migration 021 bumped the version, so the
// row stays stale and the next run publishes the newer data.

const { STATE } = require('./publish');

async function syncShowcase(db, publisher, { limit = 50 } = {}) {
    const { rows } = await db.query(
        `SELECT id, title, category, reward_amount, deadline, status, public_summary, updated_at,
                public_showcase, showcase_version
           FROM bounties
          WHERE showcase_state = 'stale'
          ORDER BY updated_at ASC
          LIMIT $1`,
        [limit]
    );

    const report = { examined: rows.length, published: 0, withdrawn: 0, failed: 0, superseded: 0 };

    for (const row of rows) {
        if (!row.public_showcase) {
            const result = await publisher.withdrawBounty(row.id);
            if (result.state === STATE.OFF) {
                const r = await db.query(
                    `UPDATE bounties SET showcase_state = 'off', showcase_synced_at = NOW()
                      WHERE id = $1 AND showcase_version = $2 AND showcase_state = 'stale'`,
                    [row.id, row.showcase_version]
                );
                if (r.rowCount === 1) report.withdrawn++; else report.superseded++;
            } else {
                report.failed++;
            }
            continue;
        }

        const result = await publisher.publishBounty(row);
        if (result.state === STATE.PUBLISHED) {
            const r = await db.query(
                `UPDATE bounties SET showcase_state = 'published', showcase_synced_at = NOW()
                  WHERE id = $1 AND showcase_version = $2`,
                [row.id, row.showcase_version]
            );
            if (r.rowCount === 1) report.published++; else report.superseded++;
        } else {
            report.failed++;
        }
    }

    return report;
}

module.exports = { syncShowcase };
