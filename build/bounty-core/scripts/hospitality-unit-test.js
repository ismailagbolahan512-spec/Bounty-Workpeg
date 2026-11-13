// scripts/hospitality-unit-test.js — pure rules for hospitality services. No server, no database.
// Run: npm run test:hospitality-unit
const test = require('node:test');
const assert = require('node:assert/strict');
const hs = require('../services/hospitality');
const regions = require('../services/regions');

const NOW = new Date('2026-11-13T12:00:00Z');

test('a local time in Lagos becomes UTC once (UTC+1, no daylight saving)', () => {
    assert.equal(hs.localToUtc('2026-11-14T14:00', 'Africa/Lagos').toISOString(), '2026-11-14T13:00:00.000Z');
});

test('a local time in New York follows the offset of that date (November is EST, UTC-5)', () => {
    assert.equal(hs.localToUtc('2026-11-14T14:00', 'America/New_York').toISOString(), '2026-11-14T19:00:00.000Z');
});

test('a local time in London in summer is UTC+1, in winter UTC+0', () => {
    assert.equal(hs.localToUtc('2026-07-01T09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');
    assert.equal(hs.localToUtc('2026-12-01T09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z');
});

test('a time that is not in the expected shape is refused', () => {
    assert.throws(() => hs.localToUtc('14 Nov 2pm', 'Africa/Lagos'), /look like/);
    assert.throws(() => hs.localToUtc(undefined, 'Africa/Lagos'), /look like/);
});

test('a local time reads back for people with the zone named', () => {
    const text = hs.formatLocal(new Date('2026-11-14T13:00:00Z'), 'Africa/Lagos');
    assert.match(text, /2:00/);
    assert.match(text, /\(Africa\/Lagos\)$/);
});

const goodRequest = {
    title: 'Emergency clean linen',
    problem: 'We are low on clean bedsheets and towels for tonight.',
    needs: '40 sheets and 60 towels, collected and returned before 2 PM.',
    price: '25000',
    region: 'NG',
    address: '12 Adeola Odeku Street, Victoria Island',
    lat: 6.4281,
    lng: 3.4219,
    area_label: 'Victoria Island',
    deadline: '2026-11-14T14:00',
};

test('a good request is accepted, priced in the region currency, on the region zone', () => {
    const r = hs.validateRequest(goodRequest, NOW);
    assert.equal(r.currency, 'NGN');
    assert.equal(r.timeZone, 'Africa/Lagos');
    assert.equal(r.price, 25000);
    assert.equal(r.deadline.toISOString(), '2026-11-14T13:00:00.000Z');
});

test('a price is refused when it is not a positive number', () => {
    assert.throws(() => hs.validateRequest({ ...goodRequest, price: '0' }, NOW), /Price/);
    assert.throws(() => hs.validateRequest({ ...goodRequest, price: 'lots' }, NOW), /Price/);
    assert.throws(() => hs.validateRequest({ ...goodRequest, price: -5 }, NOW), /Price/);
});

test('the description of the problem and of the needs must not be empty', () => {
    assert.throws(() => hs.validateRequest({ ...goodRequest, problem: 'short' }, NOW), /Describe what is wrong/);
    assert.throws(() => hs.validateRequest({ ...goodRequest, needs: '' }, NOW), /Describe what is needed/);
});

test('a region outside the supported list is refused', () => {
    assert.throws(() => hs.validateRequest({ ...goodRequest, region: 'ZZ' }, NOW), /region/);
});

test('a currency from another region is refused for this location', () => {
    assert.throws(() => hs.validateRequest({ ...goodRequest, currency: 'GBP' }, NOW), /not used/);
});

test('a multi-zone region needs one of its zones named', () => {
    const us = { ...goodRequest, region: 'US', address: '1 Main Street, Springfield', lat: 39.8, lng: -89.6, area_label: 'Springfield', deadline: '2026-11-14T14:00' };
    assert.throws(() => hs.validateRequest(us, NOW), /Choose the time zone/);
    const ok = hs.validateRequest({ ...us, time_zone: 'America/Chicago' }, NOW);
    assert.equal(ok.currency, 'USD');
    assert.equal(ok.deadline.toISOString(), '2026-11-14T20:00:00.000Z');
});

test('a single-zone region refuses a different zone from the person', () => {
    assert.throws(() => regions.resolveTimeZone('NG', 'Europe/London'), /is Africa\/Lagos/);
    assert.equal(regions.resolveTimeZone('NG', 'Africa/Lagos'), 'Africa/Lagos');
    assert.equal(regions.resolveTimeZone('NG'), 'Africa/Lagos');
});

test('a deadline under an hour away or over 90 days away is refused', () => {
    assert.throws(() => hs.validateRequest({ ...goodRequest, deadline: '2026-11-13T12:30' }, NOW), /at least 1 hour/);
    assert.throws(() => hs.validateRequest({ ...goodRequest, deadline: '2027-06-01T10:00' }, NOW), /within 90 days/);
});

test('a quote needs a positive amount and an optional short note', () => {
    assert.deepEqual(hs.validateQuote({ amount: 25000 }), { amount: 25000, note: null });
    assert.equal(hs.validateQuote({ amount: 1, note: '  can do it  ' }).note, 'can do it');
    assert.throws(() => hs.validateQuote({ amount: 0 }), /Price/);
});

test('a provider area needs a whole radius from 1 to 200 km and a valid point', () => {
    const base = { area_label: 'Yaba', lat: 6.5, lng: 3.3, radius_km: 10 };
    assert.equal(hs.validateProviderArea(base).radiusKm, 10);
    assert.throws(() => hs.validateProviderArea({ ...base, radius_km: 0 }), /radius/);
    assert.throws(() => hs.validateProviderArea({ ...base, radius_km: 10.5 }), /radius/);
    assert.throws(() => hs.validateProviderArea({ ...base, lat: 120 }), /Latitude/);
});

test('a provider sees a request inside the radius, or beyond it only when willing to travel', () => {
    const area = { radius_km: 10, willing_to_travel: false };
    assert.equal(hs.providerCanSee(4, area), true);
    assert.equal(hs.providerCanSee(12, area), false);
    assert.equal(hs.providerCanSee(12, { radius_km: 10, willing_to_travel: true }), true);
    assert.equal(hs.providerCanSee(4, null), false);
});

test('the distance a provider sees is a band, never a number', () => {
    assert.equal(hs.publicDistance(2.5), 'under 5 km');
    assert.equal(hs.publicDistance(9), '5 to 15 km');
    assert.equal(hs.publicDistance(40), 'over 15 km');
});

test('the address is visible to the business, and to the provider only after both confirm', () => {
    const request = { business_id: 'biz' };
    const confirmed = {
        status: 'confirmed', provider_id: 'pro', provider_confirmed_at: new Date(), business_confirmed_at: new Date(),
    };
    assert.equal(hs.canSeeAddress({ id: 'biz' }, request, null), true);
    assert.equal(hs.canSeeAddress({ id: 'pro' }, request, confirmed), true);
    assert.equal(hs.canSeeAddress({ id: 'pro' }, request, { ...confirmed, status: 'proposed' }), false);
    assert.equal(hs.canSeeAddress({ id: 'pro' }, request, { ...confirmed, business_confirmed_at: null }), false);
    assert.equal(hs.canSeeAddress({ id: 'other' }, request, confirmed), false);
});

test('a visit window must end after it starts, fit in 24 hours and end before the deadline', () => {
    const deadline = new Date('2026-11-14T13:00:00Z');
    assert.throws(() => hs.validateWindow('2026-11-14T10:00', '2026-11-14T09:00', 'Africa/Lagos', deadline), /end after/);
    assert.throws(() => hs.validateWindow('2026-11-13T09:00', '2026-11-15T09:00', 'Africa/Lagos', null), /24 hours/);
    assert.throws(() => hs.validateWindow('2026-11-14T10:00', '2026-11-14T15:00', 'Africa/Lagos', deadline), /before the request deadline/);
    const ok = hs.validateWindow('2026-11-14T09:00', '2026-11-14T11:00', 'Africa/Lagos', deadline);
    assert.equal(ok.starts.toISOString(), '2026-11-14T08:00:00.000Z');
});

test('a status change is allowed only along the appointment path', () => {
    assert.doesNotThrow(() => hs.assertTransition('proposed', 'confirmed'));
    assert.doesNotThrow(() => hs.assertTransition('confirmed', 'superseded'));
    assert.throws(() => hs.assertTransition('superseded', 'confirmed'), /cannot become/);
    assert.throws(() => hs.assertTransition('cancelled', 'proposed'), /cannot become/);
});

test('chat is closed until the appointment is confirmed', () => {
    const msg = { kind: 'message', body: 'hello', status_code: null };
    assert.throws(() => hs.assertCanChat({ status: 'proposed' }, 'provider', msg), /Chat opens/);
    assert.doesNotThrow(() => hs.assertCanChat({ status: 'confirmed' }, 'business', msg));
});

test('only the provider sends status lines, and only from the list', () => {
    const appt = { status: 'confirmed' };
    assert.throws(() => hs.assertCanChat(appt, 'business', { kind: 'status', status_code: 'on_the_way' }), /Only the provider/);
    assert.doesNotThrow(() => hs.assertCanChat(appt, 'provider', { kind: 'status', status_code: 'on_the_way' }));
    assert.throws(() => hs.validateChatInput({ kind: 'status', status_code: 'teleported' }), /Choose a status/);
});

test('a non-party is refused in chat', () => {
    assert.throws(() => hs.assertCanChat({ status: 'confirmed' }, null, { kind: 'message', body: 'hi' }), /Only the provider and the business/);
});

test('a chat message is 1 to 1000 characters', () => {
    assert.throws(() => hs.validateChatInput({ kind: 'message', body: '   ' }), /Message/);
    assert.throws(() => hs.validateChatInput({ kind: 'message', body: 'x'.repeat(1001) }), /Message/);
    assert.equal(hs.validateChatInput({ kind: 'message', body: ' on my way ' }).body, 'on my way');
});

test('a street address typed into chat is flagged, and ordinary chat is not', () => {
    assert.equal(hs.looksLikeAddress('come to 12 Adeola Odeku Street, the blue gate'), true);
    assert.equal(hs.looksLikeAddress('12B Ajose Adeogun Street'), true);
    assert.equal(hs.looksLikeAddress('on my way now'), false);
    assert.equal(hs.looksLikeAddress('I will be there by 2pm'), false);
});

test('currency and region helpers agree with the region table', () => {
    assert.equal(regions.currencyForRegion('GB'), 'GBP');
    assert.equal(regions.currencyForRegion('DE'), 'EUR');
    assert.equal(regions.currencyForRegion('ZZ'), null);
    assert.equal(regions.validateTaskCurrency(undefined, []), 'NGN');
    assert.throws(() => regions.validateTaskCurrency('ngn', []), /three-letter/);
    assert.throws(() => regions.validateTaskCurrency('XYZ', []), /not supported/);
});
