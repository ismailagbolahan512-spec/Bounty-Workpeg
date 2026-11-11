// services/showcase/publish.js
// Publishes one bounty to the Workpeg showcase, with the failure rules from
// docs/integration-architecture.md, section 6:
//   - PostgreSQL is written first and never rolled back here.
//   - A failed or refused publish is reported as "stale", so the caller can record it.
//   - Nothing retries on a timer: Bounty has no scheduler.
//
// The HTTP client is injected. This slice ships with no client, so every publish reports
// "stale" with reason "not_configured" until the Workpeg Tables API call is confirmed (open
// question 2 in the architecture doc). No credential is read or stored in this module.

const { toShowcaseTask, validateShowcaseTask } = require('./contract');

const STATE = Object.freeze({ PUBLISHED: 'published', STALE: 'stale' });

// client: { upsertTask(task) => Promise } or null.
// now: injectable clock for tests.
function createShowcasePublisher({ client = null, now = () => new Date() } = {}) {
    if (client !== null && typeof client.upsertTask !== 'function') {
        throw new TypeError('showcase client must provide upsertTask(task)');
    }

    async function publishBounty(row) {
        let task;
        try {
            task = toShowcaseTask(row);
        } catch (err) {
            return { state: STATE.STALE, reason: 'invalid_row', problems: [err.message] };
        }

        const problems = validateShowcaseTask(task);
        if (problems.length > 0) {
            return { state: STATE.STALE, reason: 'invalid_task', problems };
        }

        if (client === null) {
            return { state: STATE.STALE, reason: 'not_configured', problems: [] };
        }

        try {
            await client.upsertTask(task);
            return { state: STATE.PUBLISHED, published_at: now().toISOString(), problems: [] };
        } catch (err) {
            // Keep the message short and never echo request headers or credentials.
            const message = typeof err?.message === 'string' ? err.message.slice(0, 200) : 'unknown error';
            return { state: STATE.STALE, reason: 'publish_failed', problems: [message] };
        }
    }

    return { publishBounty };
}

module.exports = { STATE, createShowcasePublisher };
