// services/location-matching.js — ranking for physical (onsite) requests. Pure scoring, no database access.
// Design: docs/location-services-plan.md, section 6.2. The digital matcher is services/matching.js and is unchanged.
//
// Factors (weights sum to 1). Each input is 0..1, or null when unknown:
//   fit           category and skill fit, supplied by the caller from matching.js          0.35
//   distance      1 - distance / radius, clamped; willing-to-travel beyond the radius      0.25
//                 gets at most 0.3
//   availability  overlap with the request window; unknown scores neutral                 0.25
//   history       share of past work completed and reviewed well; new providers neutral   0.15
//
// A missing value scores neutral (0.5), never negative, so a provider is not penalised for
// withholding information. Location is used only here, for ranking. It is never shown with a
// provider's exact position: callers show the reasons and distance bands from location.js.

const WEIGHTS = { fit: 0.35, distance: 0.25, availability: 0.25, history: 0.15 };
const NEUTRAL = 0.5;
const TRAVEL_CAP = 0.3;

function clamp01(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
}

function orNeutral(v) {
    const c = clamp01(v);
    return c === null ? NEUTRAL : c;
}

// distanceKm: straight-line distance from the provider's base to the request, or null when unknown.
// radiusKm: the provider's own service radius. willingToTravel: beyond the radius, the provider
// accepts at most TRAVEL_CAP, so a distant request never outranks a local one on distance alone.
function distanceScore({ distanceKm, radiusKm, willingToTravel }) {
    if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0) return NEUTRAL;
    if (typeof radiusKm !== 'number' || !Number.isFinite(radiusKm) || radiusKm <= 0) return NEUTRAL;
    if (distanceKm <= radiusKm) return clamp01(1 - distanceKm / radiusKm);
    if (willingToTravel === true) return TRAVEL_CAP;
    return 0;
}

// Returns { score: 0..100, parts, reasons }. Reasons are plain sentences shown to the customer.
function scoreProvider(input) {
    const parts = {
        fit: orNeutral(input.fit),
        distance: distanceScore(input),
        availability: orNeutral(input.availability),
        history: orNeutral(input.history),
    };
    const raw = Object.keys(WEIGHTS).reduce((sum, k) => sum + WEIGHTS[k] * parts[k], 0);
    const reasons = [];
    if (clamp01(input.fit) !== null && parts.fit >= 0.7) reasons.push('Matches the type of work requested');
    if (parts.distance >= 0.7) reasons.push('Close to the service address');
    else if (input.willingToTravel === true && parts.distance === TRAVEL_CAP) reasons.push('Willing to travel beyond their usual area');
    if (clamp01(input.availability) !== null && parts.availability >= 0.7) reasons.push('Available in the requested window');
    if (clamp01(input.history) !== null && parts.history >= 0.7) reasons.push('Has completed similar work well');
    return { score: Math.round(raw * 100), parts, reasons };
}

// Sorts candidates best first. Ties keep their original order, so the result is stable.
function rankProviders(candidates) {
    return candidates
        .map((c, i) => ({ ...c, _i: i, ...scoreProvider(c) }))
        .sort((a, b) => (b.score - a.score) || (a._i - b._i))
        .map(({ _i, ...rest }) => rest);
}

module.exports = { WEIGHTS, NEUTRAL, TRAVEL_CAP, distanceScore, scoreProvider, rankProviders };
