// services/location.js — coordinates for physical (onsite) tasks. Pure functions, no database access.
// Design: docs/location-services-plan.md, sections 3 and 6.3.
//
// Rules this module enforces:
//   - Coordinates come from the client only as a pin, and are range-checked here.
//   - Public coordinates are rounded to two decimal places (about one kilometre) on the server.
//   - Distance is straight-line (haversine). It is never presented as travel time.
//   - Users see distance bands, never exact distances from a provider's base.

const EARTH_RADIUS_KM = 6371;
const PUBLIC_DECIMALS = 2;
const AREA_LABEL_MAX = 120;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 500;

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// Accepts numbers only (not numeric strings), so a client cannot slip in odd input.
function validateCoordinates(lat, lng) {
    if (!isFiniteNumber(lat) || lat < -90 || lat > 90) throw httpError(400, 'Latitude must be between -90 and 90');
    if (!isFiniteNumber(lng) || lng < -180 || lng > 180) throw httpError(400, 'Longitude must be between -180 and 180');
    return { lat, lng };
}

// Rounds to the public precision. Applied on the server, whatever precision the client sent.
function roundPublic(value) {
    const factor = 10 ** PUBLIC_DECIMALS;
    return Math.round(value * factor) / factor;
}

function publicCoordinates(lat, lng) {
    const c = validateCoordinates(lat, lng);
    return { lat: roundPublic(c.lat), lng: roundPublic(c.lng) };
}

// Area label is free text the business types (for example "Victoria Island, Lagos").
function validateAreaLabel(label) {
    if (typeof label !== 'string') throw httpError(400, 'An area is required for onsite tasks');
    const trimmed = label.trim();
    if (trimmed.length < 1 || trimmed.length > AREA_LABEL_MAX) {
        throw httpError(400, `Area must be 1 to ${AREA_LABEL_MAX} characters`);
    }
    return trimmed;
}

// The typed service address. Stored as text, never geocoded, never shown in logs.
function validateAddress(text) {
    if (typeof text !== 'string') throw httpError(400, 'A service address is required');
    const trimmed = text.trim();
    if (trimmed.length < ADDRESS_MIN || trimmed.length > ADDRESS_MAX) {
        throw httpError(400, `Address must be ${ADDRESS_MIN} to ${ADDRESS_MAX} characters`);
    }
    return trimmed;
}

function toRadians(deg) {
    return (deg * Math.PI) / 180;
}

// Great-circle distance in kilometres between two points.
function haversineKm(a, b) {
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Coarse bands, so a provider's exact position cannot be worked out from repeated queries.
// Boundaries: under 5 km; 5 to 15 km; over 15 km (plan section 13, item 6).
function distanceBand(km) {
    if (!isFiniteNumber(km) || km < 0) return null;
    if (km < 5) return 'under 5 km';
    if (km <= 15) return '5 to 15 km';
    return 'over 15 km';
}

// A bounding box that contains every point within radiusKm of the centre. Used as a cheap SQL
// prefilter before the exact haversine check in application code.
function boundingBox(center, radiusKm) {
    const latDelta = radiusKm / 111.2;
    const lngDelta = radiusKm / (111.2 * Math.max(Math.cos(toRadians(center.lat)), 0.01));
    return {
        minLat: Math.max(-90, center.lat - latDelta),
        maxLat: Math.min(90, center.lat + latDelta),
        minLng: Math.max(-180, center.lng - lngDelta),
        maxLng: Math.min(180, center.lng + lngDelta),
    };
}

module.exports = {
    EARTH_RADIUS_KM, PUBLIC_DECIMALS, AREA_LABEL_MAX, ADDRESS_MIN, ADDRESS_MAX,
    validateCoordinates, roundPublic, publicCoordinates, validateAreaLabel, validateAddress,
    haversineKm, distanceBand, boundingBox,
};
