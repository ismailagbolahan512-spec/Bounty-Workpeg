// services/duplicates.js — duplicate and overlapping submission detection.
//
// A flag is a prompt for the business to look at two submissions together. It is never a
// finding of misconduct, and it never changes a submission's status. Signals are explained
// in plain words so the reviewer can check them.
//
// Signals:
//   text   share of five-word phrases in common (Jaccard similarity of title and description)
//   link   both point to the same address (host and path, ignoring case and trailing slash)
//   urls   both cite the same evidence addresses in the text
//   time   how far apart the two submissions were made
// For security work, matching wording can mean the same underlying issue was reported.
// The flag says so, and asks the reviewer to check whether each worker found it independently.

const FLAG_THRESHOLD = 0.5;
const SHINGLE_SIZE = 5;
const MAX_COMPARE = 200;

function words(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function shingles(text) {
    const w = words(text);
    if (w.length === 0) return new Set();
    if (w.length < SHINGLE_SIZE) return new Set([w.join(' ')]);
    const set = new Set();
    for (let i = 0; i <= w.length - SHINGLE_SIZE; i++) set.add(w.slice(i, i + SHINGLE_SIZE).join(' '));
    return set;
}

function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

function normalizeLink(url) {
    if (!url) return null;
    try {
        const u = new URL(String(url).trim());
        return (u.host + u.pathname).toLowerCase().replace(/\/+$/, '');
    } catch (e) {
        return null;
    }
}

function urlsIn(text) {
    const found = String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
    return new Set(found.map(normalizeLink).filter(Boolean));
}

function minutesApart(a, b) {
    const x = new Date(a).getTime();
    const y = new Date(b).getTime();
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return Math.round(Math.abs(x - y) / 60000);
}

// Pure. a and b: { title, description, github_link, submitted_at }. Returns the score, the
// signals, whether the pair is flagged, and the explanation shown to the reviewer.
function compareSubmissions(a, b, { security = false } = {}) {
    const text = jaccard(shingles(`${a.title || ''} ${a.description || ''}`), shingles(`${b.title || ''} ${b.description || ''}`));
    const linkA = normalizeLink(a.github_link);
    const linkB = normalizeLink(b.github_link);
    const link = Boolean(linkA && linkA === linkB);

    const urlsA = urlsIn(a.description);
    const urlsB = urlsIn(b.description);
    let urlOverlap = 0;
    if (urlsA.size && urlsB.size) {
        let inter = 0;
        for (const u of urlsA) if (urlsB.has(u)) inter += 1;
        urlOverlap = inter / (urlsA.size + urlsB.size - inter);
    }
    const minutes = minutesApart(a.submitted_at, b.submitted_at);

    const score = Math.round((0.6 * text + (link ? 0.25 : 0) + 0.15 * urlOverlap) * 1000) / 1000;
    const flagged = link || score >= FLAG_THRESHOLD;

    const explanation = [];
    if (link) explanation.push('Both submissions point to the same link.');
    if (text > 0) explanation.push(`About ${Math.round(text * 100)}% of the wording is the same.`);
    if (urlOverlap > 0) explanation.push('Both cite the same evidence address.');
    if (minutes !== null && minutes <= 60) explanation.push(`The two were submitted ${minutes} minute${minutes === 1 ? '' : 's'} apart.`);
    if (security) {
        explanation.push('This is security work. Matching wording can mean the same underlying issue was reported. Check whether each worker found it independently, using their evidence and steps.');
    }
    explanation.push('This is a prompt for review, not a finding of misconduct.');

    return {
        flagged,
        score,
        signals: {
            text: Math.round(text * 1000) / 1000,
            link,
            urls: Math.round(urlOverlap * 1000) / 1000,
            minutes_apart: minutes,
        },
        explanation,
    };
}

// Canonical pair order, so each pair is stored once.
function orderedPair(idA, idB) {
    return idA < idB ? [idA, idB] : [idB, idA];
}

// Compares one submission with the others in its bounty and stores any flags. Idempotent.
async function scanNewSubmission(db, bountyId, submissionId, { security }) {
    const { rows: others } = await db.query(
        `SELECT id, title, description, github_link, submitted_at FROM submissions
         WHERE bounty_id = $1 AND id <> $2 ORDER BY submitted_at DESC LIMIT $3`, [bountyId, submissionId, MAX_COMPARE]
    );
    const { rows: [self] } = await db.query(
        'SELECT id, title, description, github_link, submitted_at FROM submissions WHERE id = $1', [submissionId]
    );
    let created = 0;
    for (const other of others) {
        const result = compareSubmissions(self, other, { security });
        if (!result.flagged) continue;
        const [first, second] = orderedPair(self.id, other.id);
        const r = await db.query(
            `INSERT INTO submission_overlaps (bounty_id, submission_id, related_submission_id, score, signals, security)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (submission_id, related_submission_id) DO NOTHING`,
            [bountyId, first, second, result.score, JSON.stringify({ ...result.signals, explanation: result.explanation }), security]
        );
        created += r.rowCount;
    }
    return created;
}

// Re-compares every pair in the bounty. Existing reviews are kept.
async function scanBounty(db, bountyId, { security }) {
    const { rows } = await db.query(
        'SELECT id, title, description, github_link, submitted_at FROM submissions WHERE bounty_id = $1 ORDER BY submitted_at DESC LIMIT $2',
        [bountyId, MAX_COMPARE]
    );
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const result = compareSubmissions(rows[i], rows[j], { security });
            if (!result.flagged) continue;
            const [first, second] = orderedPair(rows[i].id, rows[j].id);
            const r = await db.query(
                `INSERT INTO submission_overlaps (bounty_id, submission_id, related_submission_id, score, signals, security)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (submission_id, related_submission_id) DO NOTHING`,
                [bountyId, first, second, result.score, JSON.stringify({ ...result.signals, explanation: result.explanation }), security]
            );
            created += r.rowCount;
        }
    }
    return created;
}

module.exports = { compareSubmissions, scanNewSubmission, scanBounty, normalizeLink, shingles, jaccard, FLAG_THRESHOLD };
