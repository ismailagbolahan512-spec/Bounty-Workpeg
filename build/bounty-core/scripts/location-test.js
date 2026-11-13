// scripts/location-test.js — pure tests for services/location.js and services/location-matching.js.
// No database and no server. Run: npm run test:location
// Design: docs/location-services-plan.md, sections 3, 6 and 10 (items 2 and 4).

const test = require('node:test');
const assert = require('node:assert/strict');
const loc = require('../services/location');
const match = require('../services/location-matching');

test('coordinates must be finite numbers in range', () => {
    assert.deepEqual(loc.validateCoordinates(6.4281, 3.4219), { lat: 6.4281, lng: 3.4219 });
    assert.throws(() => loc.validateCoordinates('6.4', 3.4), /Latitude/);
    assert.throws(() => loc.validateCoordinates(91, 3.4), /Latitude/);
    assert.throws(() => loc.validateCoordinates(6, 181), /Longitude/);
    assert.throws(() => loc.validateCoordinates(NaN, 3), /Latitude/);
    assert.throws(() => loc.validateCoordinates(6, Infinity), /Longitude/);
    assert.throws(() => loc.validateCoordinates(null, null), /Latitude/);
});

test('public coordinates are rounded to two decimals on the server', () => {
    assert.deepEqual(loc.publicCoordinates(6.428123, 3.421987), { lat: 6.43, lng: 3.42 });
    assert.deepEqual(loc.publicCoordinates(-33.91234, -151.2099), { lat: -33.91, lng: -151.21 });
});

test('public coordinates still validate the input range', () => {
    assert.throws(() => loc.publicCoordinates(200, 0), /Latitude/);
});

test('area label and address are trimmed and length-checked', () => {
    assert.equal(loc.validateAreaLabel('  Victoria Island, Lagos  '), 'Victoria Island, Lagos');
    assert.throws(() => loc.validateAreaLabel('   '), /Area/);
    assert.throws(() => loc.validateAreaLabel('x'.repeat(121)), /Area/);
    assert.equal(loc.validateAddress(' 12 Adeola Odeku St '), '12 Adeola Odeku St');
    assert.throws(() => loc.validateAddress('abc'), /Address/);
    assert.throws(() => loc.validateAddress(undefined), /address/i);
});

test('haversine gives a sensible straight-line distance in Lagos', () => {
    const victoriaIsland = { lat: 6.4281, lng: 3.4219 };
    const ikeja = { lat: 6.6018, lng: 3.3515 };
    const km = loc.haversineKm(victoriaIsland, ikeja);
    assert.ok(km > 19 && km < 22, `expected about 20 km, got ${km}`);
    assert.equal(loc.haversineKm(ikeja, ikeja), 0);
    assert.ok(Math.abs(loc.haversineKm(victoriaIsland, ikeja) - loc.haversineKm(ikeja, victoriaIsland)) < 1e-9);
});

test('distance bands use the approved boundaries', () => {
    assert.equal(loc.distanceBand(0), 'under 5 km');
    assert.equal(loc.distanceBand(4.99), 'under 5 km');
    assert.equal(loc.distanceBand(5), '5 to 15 km');
    assert.equal(loc.distanceBand(15), '5 to 15 km');
    assert.equal(loc.distanceBand(15.01), 'over 15 km');
    assert.equal(loc.distanceBand(-1), null);
    assert.equal(loc.distanceBand(NaN), null);
});

test('bounding box contains every point inside the radius', () => {
    const center = { lat: 6.4281, lng: 3.4219 };
    const box = loc.boundingBox(center, 10);
    // A point about 5.5 km north and 5.5 km east (about 7.8 km away) is inside the 10 km radius.
    const probe = { lat: center.lat + 0.05, lng: center.lng + 0.05 };
    assert.ok(loc.haversineKm(center, probe) < 10);
    assert.ok(probe.lat >= box.minLat && probe.lat <= box.maxLat);
    assert.ok(probe.lng >= box.minLng && probe.lng <= box.maxLng);
});

test('local providers score higher than distant ones when all else is equal', () => {
    const near = match.scoreProvider({ fit: 0.8, distanceKm: 1, radiusKm: 10 });
    const far = match.scoreProvider({ fit: 0.8, distanceKm: 9, radiusKm: 10 });
    assert.ok(near.score > far.score);
});

test('a qualified, available provider slightly farther away can outrank a nearby one of unknown availability', () => {
    // 2 km against 6 km within a 10 km radius costs 0.1 of distance credit; known availability
    // against unknown adds 0.5 of availability credit, so the farther provider wins at these weights.
    const nearbyUnknown = match.scoreProvider({ fit: 0.8, distanceKm: 2, radiusKm: 10, availability: null, history: null });
    const availableFarther = match.scoreProvider({ fit: 0.8, distanceKm: 6, radiusKm: 10, availability: 1, history: null });
    assert.ok(availableFarther.score > nearbyUnknown.score);
});

test('willing-to-travel providers beyond their radius are capped', () => {
    const beyond = match.distanceScore({ distanceKm: 40, radiusKm: 10, willingToTravel: true });
    assert.equal(beyond, match.TRAVEL_CAP);
    assert.equal(match.distanceScore({ distanceKm: 40, radiusKm: 10, willingToTravel: false }), 0);
});

test('missing data scores neutral, never negative', () => {
    const empty = match.scoreProvider({});
    assert.equal(empty.parts.fit, match.NEUTRAL);
    assert.equal(empty.parts.distance, match.NEUTRAL);
    assert.equal(empty.parts.availability, match.NEUTRAL);
    assert.equal(empty.parts.history, match.NEUTRAL);
    assert.ok(empty.score >= 0 && empty.score <= 100);
    assert.deepEqual(empty.reasons, []);
});

test('scores are bounded 0 to 100 even with out-of-range inputs', () => {
    const high = match.scoreProvider({ fit: 9, distanceKm: 0, radiusKm: 5, availability: 3, history: 2 });
    const low = match.scoreProvider({ fit: -4, distanceKm: 99, radiusKm: 5, availability: -1, history: -2 });
    assert.ok(high.score <= 100 && high.score >= 0);
    assert.ok(low.score <= 100 && low.score >= 0);
});

test('weights sum to 1', () => {
    const sum = Object.values(match.WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('ranking is best first and stable for ties', () => {
    const ranked = match.rankProviders([
        { id: 'a', fit: 0.5, distanceKm: 3, radiusKm: 10 },
        { id: 'b', fit: 0.9, distanceKm: 1, radiusKm: 10, availability: 1, history: 1 },
        { id: 'c', fit: 0.5, distanceKm: 3, radiusKm: 10 },
    ]);
    assert.equal(ranked[0].id, 'b');
    assert.equal(ranked[1].id, 'a');
    assert.equal(ranked[2].id, 'c');
});

test('reasons never contain coordinates or distances', () => {
    const r = match.scoreProvider({ fit: 1, distanceKm: 0.5, radiusKm: 10, availability: 1, history: 1, willingToTravel: true });
    for (const reason of r.reasons) {
        assert.doesNotMatch(reason, /\d/, `reason leaks a number: ${reason}`);
    }
});
