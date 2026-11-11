// services/reputation.js — proof-of-work reputation, computed from completed work.
//
// Nothing here is self-declared. Indicators come from approved submissions, reviews from
// clients, and revision history. They are reported per industry, never as one global number.
//
// Anti-inflation rules:
//   - Only approved submissions count.
//   - At most SAME_CLIENT_CAP tasks per industry count from any one client, so a friendly
//     client cannot build a reputation alone.
//   - Each task is weighted by its reward, so larger work counts for more. The weight is
//     capped so one very large task cannot dominate.
// Dispute history (only where the worker was the respondent, and only once a decision is recorded):
//   - Claims a worker raised are never counted against them, and never counted for them.
//   - An upheld complaint against the worker is recorded and prevents the trusted band.
//   - Open disputes are shown as open and do not count against the worker until decided.
// Band thresholds are product decisions and are listed in BANDS for review.

const SAME_CLIENT_CAP = 3;
const REWARD_WEIGHT_CAP = 5000;

const BANDS = {
    established: { min_verified: 5, min_on_time: 0.8 },
    trusted: { min_verified: 15, min_on_time: 0.85, min_rating: 4.2, min_ratings: 5 },
};

// rows: one per approved submission with its facts:
// { industry, business_id, reward, submitted_at, deadline, revised, rating }
// disputes: one per dispute where the worker was the respondent:
// { decision_outcome, status }
function summariseDisputes(disputes) {
    const history = { decided: 0, upheld_against: 0, partial: 0, no_action: 0, upheld_for: 0, open: 0 };
    for (const d of disputes) {
        if (d.status !== 'resolved' || !d.decision_outcome) {
            history.open += 1;
            continue;
        }
        history.decided += 1;
        if (d.decision_outcome === 'upheld_raiser') history.upheld_against += 1;
        else if (d.decision_outcome === 'partial') history.partial += 1;
        else if (d.decision_outcome === 'upheld_respondent') history.upheld_for += 1;
        else if (d.decision_outcome === 'no_action') history.no_action += 1;
    }
    return history;
}

function summarise(rows, disputes = []) {
    const byIndustry = new Map();
    const perClient = new Map();

    const ordered = [...rows].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    for (const row of ordered) {
        const key = `${row.industry}|${row.business_id}`;
        const count = perClient.get(key) || 0;
        if (count >= SAME_CLIENT_CAP) continue;
        perClient.set(key, count + 1);

        if (!byIndustry.has(row.industry)) {
            byIndustry.set(row.industry, { verified: 0, weighted: 0, on_time: 0, revised: 0, ratings: [] });
        }
        const agg = byIndustry.get(row.industry);
        agg.verified += 1;
        agg.weighted += 1 + Math.min(Number(row.reward) || 0, REWARD_WEIGHT_CAP) / REWARD_WEIGHT_CAP;
        if (row.deadline && new Date(row.submitted_at) <= new Date(row.deadline)) agg.on_time += 1;
        if (row.revised) agg.revised += 1;
        if (row.rating !== null && row.rating !== undefined) agg.ratings.push(Number(row.rating));
    }

    const disputeHistory = summariseDisputes(disputes);
    const industries = [...byIndustry.entries()].map(([industry, a]) => {
        const avgRating = a.ratings.length ? a.ratings.reduce((s, r) => s + r, 0) / a.ratings.length : null;
        const onTime = a.verified ? a.on_time / a.verified : null;
        return {
            industry,
            verified_completed: a.verified,
            weighted_score: Math.round(a.weighted * 10) / 10,
            on_time_rate: onTime === null ? null : Math.round(onTime * 100) / 100,
            average_rating: avgRating === null ? null : Math.round(avgRating * 10) / 10,
            rating_count: a.ratings.length,
            revision_rate: a.verified ? Math.round((a.revised / a.verified) * 100) / 100 : null,
            band: bandFor({ verified: a.verified, onTime, avgRating, ratings: a.ratings.length, upheldAgainst: disputeHistory.upheld_against }),
        };
    });
    industries.sort((x, y) => y.weighted_score - x.weighted_score || x.industry.localeCompare(y.industry));
    return {
        industries,
        total_verified: industries.reduce((s, i) => s + i.verified_completed, 0),
        dispute_history: disputeHistory,
        notes: [
            `At most ${SAME_CLIENT_CAP} tasks per industry count from any one client.`,
            'Only disputes where this worker was the respondent and a decision was recorded are counted.',
            'An upheld complaint against this worker prevents the trusted band.',
        ],
    };
}

function bandFor({ verified, onTime, avgRating, ratings, upheldAgainst = 0 }) {
    const t = BANDS.trusted;
    const e = BANDS.established;
    if (upheldAgainst === 0 && verified >= t.min_verified && onTime !== null && onTime >= t.min_on_time &&
        avgRating !== null && avgRating >= t.min_rating && ratings >= t.min_ratings) return 'trusted';
    if (verified >= e.min_verified && onTime !== null && onTime >= e.min_on_time) return 'established';
    return 'emerging';
}

module.exports = { summarise, summariseDisputes, bandFor, SAME_CLIENT_CAP, REWARD_WEIGHT_CAP, BANDS };
