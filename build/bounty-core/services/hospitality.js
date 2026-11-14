// services/hospitality.js — pure rules for hospitality services (onsite tasks). No database here,
// so every rule can be unit tested. Routes in routes/services.js apply these rules to real rows.
//
//   * Times a person types are local to the place of the service. They become UTC once, here.
//   * A provider sees the area label of the request. The exact address comes later, only after
//     both sides confirm the appointment (see canSeeAddress).
//   * Chat is open only once an appointment is confirmed, and a message that looks like a street
//     address is flagged, not hidden.

const { httpError } = require('../middleware/auth');
const { resolveTimeZone, currencyForRegion, validateTaskCurrency, isCountry } = require('./regions');
const loc = require('./location');
const catalogue = require('./hospitality-catalogue');

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
const SERVICE_AREA_MAX = 240;
const WORKER_NOTES_MAX = 500;
const REVIEW_NOTE_MAX = 500;
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
    const areaLabel = loc.validateAreaLabel(b.area_label);
    const deadline = localToUtc(b.deadline, timeZone);
    const hours = (deadline.getTime() - now.getTime()) / 3600000;
    if (hours < DEADLINE_MIN_HOURS) throw httpError(400, `The deadline must be at least ${DEADLINE_MIN_HOURS} hour from now`);
    if (hours > DEADLINE_MAX_DAYS * 24) throw httpError(400, `The deadline must be within ${DEADLINE_MAX_DAYS} days`);
    if (!catalogue.validIndustry(b.industry)) throw httpError(400, 'Choose the industry you run');
    const serviceLabels = catalogue.validateServiceLabels(b.services);
    const workerNotes = validateWorkerNotes(b.worker_notes);
    const urgent = b.urgent === true;
    return {
        industry: b.industry, serviceLabels,
        title, problem, needs, price, currency, region: b.region, timeZone,
        address, areaLabel, deadline, workerNotes, urgent,
    };
}

// Anything the worker needs to know to get in and do the job: gate codes, parking, who to ask
// for. Stored with the address and shown to the provider only once both sides have confirmed.
function validateWorkerNotes(text) {
    if (text === null || text === undefined || text === '') return null;
    if (typeof text !== 'string') throw httpError(400, 'What the worker needs to know must be text');
    const t = text.trim();
    if (t.length === 0) return null;
    if (t.length > WORKER_NOTES_MAX) throw httpError(400, `What the worker needs to know must be ${WORKER_NOTES_MAX} characters or fewer`);
    return t;
}

// A review: a star rating from 1 to 5 and an optional short note.
function validateReview(body) {
    const b = body || {};
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw httpError(400, 'Choose a rating from 1 to 5');
    let note = null;
    if (b.note !== undefined && b.note !== null && b.note !== '') {
        if (typeof b.note !== 'string') throw httpError(400, 'The review note must be text');
        const t = b.note.trim();
        if (t.length > REVIEW_NOTE_MAX) throw httpError(400, `The review note must be ${REVIEW_NOTE_MAX} characters or fewer`);
        note = t.length ? t : null;
    }
    return { rating, note };
}

// What the worker tells the business about the areas they cover: free text, up to 240 chars.
// This is for display only — matching is by region, so a provider does not have to list every
// street. "Victoria Island, Lekki, Ikoyi" is a fine answer.
function validateServiceArea(text) {
    if (text === null || text === '' || text === undefined) return null;
    if (typeof text !== 'string') throw httpError(400, 'The areas you cover must be text');
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length === 0) return null;
    if (t.length > SERVICE_AREA_MAX) throw httpError(400, `The areas you cover must be ${SERVICE_AREA_MAX} characters or fewer`);
    return t;
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

// Work modes a worker can take: on-site hospitality jobs, remote Bounty tasks, or both.
const WORK_MODES = ['onsite', 'remote'];
function validateWorkModes(modes) {
    if (!Array.isArray(modes)) throw httpError(400, 'Choose on-site, remote or both');
    const set = [...new Set(modes.map((m) => String(m)))];
    if (set.length === 0 || set.some((m) => !WORK_MODES.includes(m))) throw httpError(400, 'Choose on-site, remote or both');
    return WORK_MODES.filter((m) => set.includes(m));
}

// A clock time of day, HH:MM, 24-hour.
function validateClock(text, label) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(text || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw httpError(400, `${label} must look like 09:00 (24-hour clock)`);
    return Number(m[1]) * 60 + Number(m[2]);
}

// Minutes after midnight, on the clock of the zone, for an instant.
function minutesOfDay(date, zone) {
    const offset = zoneOffsetMinutes(zone, date);
    const local = Math.floor(date.getTime() / 60000) + offset;
    return ((local % 1440) + 1440) % 1440;
}

// True when a visit fits inside the hours a provider gave. Hours may run past midnight
// (22:00 to 06:00). A visit that starts inside the hours and ends before they stop is inside.
function visitFitsHours(startsAt, endsAt, zone, startHHMM, endHHMM) {
    const from = validateClock(startHHMM, 'Start of hours');
    const to = validateClock(endHHMM, 'End of hours');
    const windowLen = ((to - from) + 1440) % 1440 || 1440;
    const offsetStart = ((minutesOfDay(startsAt, zone) - from) + 1440) % 1440;
    const duration = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000);
    return offsetStart + duration <= windowLen;
}

module.exports = {
    WORK_MODES, validateWorkModes, validateClock, visitFitsHours, validateServiceArea,
    CATEGORY, STATUS_CODES, STATUS_TEXT, ADDRESS_LIKE,
    zoneOffsetMinutes, localToUtc, formatLocal,
    validateRequest, validateQuote, validateWindow, validateChatInput, validateWorkerNotes, validateReview,
    canSeeAddress,
    APPOINTMENT_TRANSITIONS, assertTransition, partyOf, assertCanChat, looksLikeAddress,
};
