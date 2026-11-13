// services/hospitality.js — pure rules for hospitality services (onsite tasks). No database here,
// so every rule can be unit tested. Routes in routes/services.js apply these rules to real rows.
//
//   * Times a person types are local to the place of the service. They become UTC once, here.
//   * A provider sees the area, the distance band and the request. The exact address comes later,
//     only after both sides confirm the appointment (see canSeeAddress).
//   * Chat is open only once an appointment is confirmed, and a message that looks like a street
//     address is flagged, not hidden.

const { httpError } = require('../middleware/auth');
const { resolveTimeZone, currencyForRegion, validateTaskCurrency, isCountry } = require('./regions');
const loc = require('./location');

const CATEGORY = 'hospitality';
const DEADLINE_MIN_HOURS = 1;
const DEADLINE_MAX_DAYS = 90;
const TITLE_MIN = 3;
const TITLE_MAX = 200;
const PROBLEM_MIN = 10;
const PROBLEM_MAX = 2000;
const NEEDS_MIN = 3;
const NEEDS_MAX = 2000;
const PRICE_MAX = 9999999999.99;
const NOTE_MAX = 1000;
const MESSAGE_MAX = 1000;
const RADIUS_MIN = 1;
const RADIUS_MAX = 200;
const WINDOW_MAX_HOURS = 24;

const STATUS_CODES = ['on_the_way', 'arrived', 'started', 'finished'];
const PROVIDER_STATUS_CODES = STATUS_CODES;

// --------------------------------------------------------------- time zones

// The offset of `zone` at the instant `date`, in minutes east of UTC.
function zoneOffsetMinutes(zone, date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - date.getTime()) / 60000);
}

// Converts a wall-clock time at a place ("2026-11-14T14:00", in `zone`) to a UTC Date.
// Two passes handle the offset changing across the boundary.
function localToUtc(localText, zone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(localText || ''));
    if (!m) throw httpError(400, 'Times must look like 2026-11-14T14:00 (the time at the place of the service)');
    const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    let guess = wall - zoneOffsetMinutes(zone, new Date(wall)) * 60000;
    guess = wall - zoneOffsetMinutes(zone, new Date(guess)) * 60000;
    const check = new Date(guess);
    if (Number.isNaN(check.getTime())) throw httpError(400, 'That time is not valid');
    return check;
}

// How a UTC instant reads at the place of the service, for people to read.
function formatLocal(date, zone) {
    const text = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(date);
    return `${text} (${zone})`;
}

// ------------------------------------------------------------- request input

function trimmed(value, min, max, label) {
    if (typeof value !== 'string') throw httpError(400, `${label} is required`);
    const t = value.trim();
    if (t.length < min || t.length > max) throw httpError(400, `${label} must be ${min} to ${max} characters`);
    return t;
}

function parsePrice(value) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > PRICE_MAX) {
        throw httpError(400, 'Price must be a number above zero');
    }
    return Math.round(n * 100) / 100;
}

// Checks a business's request. Returns a clean object; throws 400 with a plain message otherwise.
// `now` is passed in so the deadline rule can be tested.
function validateRequest(body, now) {
    const b = body || {};
    const title = trimmed(b.title, TITLE_MIN, TITLE_MAX, 'Title');
    const problem = trimmed(b.problem, PROBLEM_MIN, PROBLEM_MAX, 'Describe what is wrong');
    const needs = trimmed(b.needs, NEEDS_MIN, NEEDS_MAX, 'Describe what is needed');
    const price = parsePrice(b.price);
    if (!isCountry(b.region)) throw httpError(400, 'Choose the region of the service');
    const currency = validateTaskCurrency(b.currency === undefined ? currencyForRegion(b.region) : b.currency, [b.region]);
    const timeZone = resolveTimeZone(b.region, b.time_zone);
    const address = loc.validateAddress(b.address);
    const coords = loc.validateCoordinates(Number(b.lat), Number(b.lng));
    const areaLabel = loc.validateAreaLabel(b.area_label);
    const deadline = localToUtc(b.deadline, timeZone);
    const hours = (deadline.getTime() - now.getTime()) / 3600000;
    if (hours < DEADLINE_MIN_HOURS) throw httpError(400, `The deadline must be at least ${DEADLINE_MIN_HOURS} hour from now`);
    if (hours > DEADLINE_MAX_DAYS * 24) throw httpError(400, `The deadline must be within ${DEADLINE_MAX_DAYS} days`);
    return {
        title, problem, needs, price, currency, region: b.region, timeZone,
        address, lat: coords.lat, lng: coords.lng, areaLabel, deadline,
    };
}

function validateQuote(body) {
    const b = body || {};
    const amount = parsePrice(b.amount);
    let note = null;
    if (b.note !== undefined && b.note !== null && b.note !== '') {
        note = trimmed(b.note, 1, NOTE_MAX, 'Note');
    }
    return { amount, note };
}

function validateProviderArea(body) {
    const b = body || {};
    const areaLabel = loc.validateAreaLabel(b.area_label);
    const coords = loc.validateCoordinates(Number(b.lat), Number(b.lng));
    const radius = Number(b.radius_km);
    if (!Number.isInteger(radius) || radius < RADIUS_MIN || radius > RADIUS_MAX) {
        throw httpError(400, `Service radius must be a whole number from ${RADIUS_MIN} to ${RADIUS_MAX} km`);
    }
    return {
        areaLabel, lat: coords.lat, lng: coords.lng, radiusKm: radius,
        willingToTravel: b.willing_to_travel === true,
    };
}

// The window the business proposes for the visit. Both ends are local to the place of the service.
function validateWindow(startsLocal, endsLocal, timeZone, deadline) {
    const starts = localToUtc(startsLocal, timeZone);
    const ends = localToUtc(endsLocal, timeZone);
    if (ends.getTime() <= starts.getTime()) throw httpError(400, 'The visit must end after it starts');
    if ((ends.getTime() - starts.getTime()) / 3600000 > WINDOW_MAX_HOURS) {
        throw httpError(400, `A visit window can be at most ${WINDOW_MAX_HOURS} hours`);
    }
    if (deadline && ends.getTime() > new Date(deadline).getTime()) {
        throw httpError(400, 'The visit must end before the request deadline');
    }
    return { starts, ends };
}

// ------------------------------------------------------------- visibility

// A provider may see an open request when it is inside their radius, or when they are willing to
// travel beyond it. Distance is measured from the exact pin, on the server.
function providerCanSee(distanceKm, area) {
    if (!area) return false;
    if (distanceKm === null || distanceKm === undefined) return false;
    if (distanceKm <= area.radius_km) return true;
    return area.willing_to_travel === true;
}

// Only the distance band leaves the server for a provider. Never the pin or the address.
function publicDistance(distanceKm) {
    return loc.distanceBand(distanceKm);
}

// The exact address is visible to the business that owns the request, and to the provider only when
// the appointment is confirmed by both parties.
function canSeeAddress(viewer, request, appointment) {
    if (!viewer || !request) return false;
    if (String(viewer.id) === String(request.business_id)) return true;
    return Boolean(
        appointment && appointment.status === 'confirmed' &&
        String(viewer.id) === String(appointment.provider_id) &&
        appointment.provider_confirmed_at && appointment.business_confirmed_at
    );
}

// ------------------------------------------------------------- appointments

const APPOINTMENT_TRANSITIONS = {
    proposed: ['confirmed', 'superseded', 'cancelled'],
    confirmed: ['superseded', 'cancelled'],
    superseded: [],
    cancelled: [],
};

function assertTransition(from, to) {
    const allowed = APPOINTMENT_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) throw httpError(409, `An appointment that is ${from} cannot become ${to}`);
}

// The side a user is on for an appointment, or null when they are neither party.
function partyOf(userId, appointment, requestBusinessId) {
    if (!userId || !appointment) return null;
    if (String(userId) === String(appointment.provider_id)) return 'provider';
    if (String(userId) === String(requestBusinessId)) return 'business';
    return null;
}

// Chat rule: messages only once the appointment is confirmed. Status lines are provider-only.
function assertCanChat(appointment, party, input) {
    if (!appointment || appointment.status !== 'confirmed') {
        throw httpError(409, 'Chat opens once both sides have confirmed the appointment');
    }
    if (!party) throw httpError(403, 'Only the provider and the business can chat on this appointment');
    if (input.kind === 'status') {
        if (party !== 'provider') throw httpError(403, 'Only the provider sends status updates');
        if (!PROVIDER_STATUS_CODES.includes(input.status_code)) throw httpError(400, 'Choose a status from the list');
    }
}

function validateChatInput(body) {
    const b = body || {};
    if (b.kind === 'status') {
        if (!STATUS_CODES.includes(b.status_code)) throw httpError(400, 'Choose a status from the list');
        return { kind: 'status', status_code: b.status_code, body: null };
    }
    if (b.kind !== 'message') throw httpError(400, 'A chat line is either a message or a status');
    const text = trimmed(b.body, 1, MESSAGE_MAX, 'Message');
    return { kind: 'message', body: text, status_code: null };
}

// A rough check for a street address typed into chat. It flags, it does not block, so it will miss
// some addresses and may flag a few harmless lines. Used for a warning shown to the sender.
const ADDRESS_LIKE = /\b\d{1,5}[a-z]?\s+[a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*)?\s+(?:street|st|road|rd|avenue|ave|close|crescent|cres|way|lane|ln|drive|dr|estate|boulevard|blvd)\b/i;
function looksLikeAddress(text) {
    return ADDRESS_LIKE.test(String(text || ''));
}

// The plain-language line for each status, for the other side's feed.
const STATUS_TEXT = {
    on_the_way: 'is on the way',
    arrived: 'has arrived',
    started: 'has started the work',
    finished: 'has finished the work',
};

module.exports = {
    CATEGORY, STATUS_CODES, STATUS_TEXT, ADDRESS_LIKE,
    zoneOffsetMinutes, localToUtc, formatLocal,
    validateRequest, validateQuote, validateProviderArea, validateWindow, validateChatInput,
    providerCanSee, publicDistance, canSeeAddress,
    APPOINTMENT_TRANSITIONS, assertTransition, partyOf, assertCanChat, looksLikeAddress,
};
