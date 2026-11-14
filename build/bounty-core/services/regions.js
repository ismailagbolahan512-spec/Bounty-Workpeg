// services/regions.js — global opportunity access: which countries exist in the catalogue, which
// currency and time zones each one uses, and who may see a task that is limited to some regions.
//
// Honesty rules
//   * A task is priced in the currency of its region. Choosing a region offers that region's
//     currency; a task may not use a currency from a region it does not cover.
//   * A time zone is never typed by a person. It comes from the region of the task's location, and
//     a region with more than one zone asks the business to pick one of them.
//   * Payout methods are not confirmed for any region. Eligibility here describes what the
//     person has declared, never a guarantee that a payment method exists or that a payment was made.
//     Pricing in a currency does not mean that money can be paid in it.
//   * A task with no region limit is visible everywhere. A task with a region limit is visible to
//     its business and to signed-in people whose declared country is on the list.

const { httpError } = require('../middleware/auth');

const REGIONS = [
    { code: 'NG', name: 'Nigeria', currency: 'NGN', zones: ['Africa/Lagos'] },
    { code: 'GH', name: 'Ghana', currency: 'GHS', zones: ['Africa/Accra'] },
    { code: 'KE', name: 'Kenya', currency: 'KES', zones: ['Africa/Nairobi'] },
    { code: 'ZA', name: 'South Africa', currency: 'ZAR', zones: ['Africa/Johannesburg'] },
    { code: 'GB', name: 'United Kingdom', currency: 'GBP', zones: ['Europe/London'] },
    { code: 'IE', name: 'Ireland', currency: 'EUR', zones: ['Europe/Dublin'] },
    {
        code: 'US', name: 'United States', currency: 'USD',
        zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
    },
    {
        code: 'CA', name: 'Canada', currency: 'CAD',
        zones: ['America/Toronto', 'America/Winnipeg', 'America/Edmonton', 'America/Vancouver'],
    },
    { code: 'DE', name: 'Germany', currency: 'EUR', zones: ['Europe/Berlin'] },
    { code: 'FR', name: 'France', currency: 'EUR', zones: ['Europe/Paris'] },
    { code: 'IN', name: 'India', currency: 'INR', zones: ['Asia/Kolkata'] },
];
const CODES = new Set(REGIONS.map((r) => r.code));
const MAX_TASK_REGIONS = 10;

const CURRENCY_NAMES = {
    NGN: 'Nigerian naira', GHS: 'Ghanaian cedi', KES: 'Kenyan shilling', ZAR: 'South African rand',
    GBP: 'British pound', EUR: 'Euro', USD: 'US dollar', CAD: 'Canadian dollar', INR: 'Indian rupee',
};
// Every currency a region uses. A currency is listed once, however many regions use it.
const CURRENCIES = [...new Set(REGIONS.map((r) => r.currency))].map((code) => ({
    code,
    name: CURRENCY_NAMES[code],
    status: 'supported',
    note: 'Prices can be set in this currency. Payouts in it are not confirmed yet.',
}));

const PAYOUT_NOTE = 'Payout methods for this region are not confirmed yet. Delivering work does not by itself mean that a payment has been made. A payment is only shown as made once the payment system confirms it.';


function regionFor(code) {
    return REGIONS.find((r) => r.code === code) || null;
}

// The currency a region prices in, or null for an unknown region.
function currencyForRegion(code) {
    const r = regionFor(code);
    return r ? r.currency : null;
}

// The time zones of a region. A location never has to name one of them when the region has one.
function zonesForRegion(code) {
    const r = regionFor(code);
    return r ? r.zones.slice() : [];
}

// Resolves the time zone of a location from its region. A region with one zone uses it, and a
// different zone from the person is refused. A region with several zones needs one of them named.
function resolveTimeZone(regionCode, requested) {
    const zones = zonesForRegion(regionCode);
    if (zones.length === 0) throw httpError(400, 'Choose a supported region for this location');
    if (zones.length === 1) {
        if (requested !== undefined && requested !== null && requested !== zones[0]) {
            throw httpError(400, `The time zone for ${regionName(regionCode)} is ${zones[0]}`);
        }
        return zones[0];
    }
    if (typeof requested !== 'string' || !zones.includes(requested)) {
        throw httpError(400, `Choose the time zone for this location: ${zones.join(', ')}`);
    }
    return requested;
}

// A task's currency. It must be supported, and it must be a currency of one of the task's regions
// when the task names any. With no regions named, any supported currency is accepted.
function validateTaskCurrency(currency, regionCodes) {
    const code = currency === undefined || currency === null ? 'NGN' : currency;
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
        throw httpError(400, 'Currency must be a three-letter code such as NGN');
    }
    if (!CURRENCIES.some((c) => c.code === code)) {
        throw httpError(400, `Currency ${code} is not supported`);
    }
    const regions = Array.isArray(regionCodes) ? regionCodes : [];
    if (regions.length > 0 && !regions.some((r) => currencyForRegion(r) === code)) {
        throw httpError(400, `Currency ${code} is not used in the regions this task covers`);
    }
    return code;
}

function isCountry(code) {
    return typeof code === 'string' && CODES.has(code);
}

function regionName(code) {
    const r = REGIONS.find((x) => x.code === code);
    return r ? r.name : null;
}

// Cleans a list of region codes from a request. An empty list means the task is open to every region.
function parseTaskRegions(input) {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw httpError(400, 'Regions must be a list of country codes');
    const codes = [...new Set(input.map((c) => String(c).trim().toUpperCase()))];
    if (codes.some((c) => !CODES.has(c))) throw httpError(400, 'One of the regions is not in the supported list');
    if (codes.length > MAX_TASK_REGIONS) throw httpError(400, `Choose up to ${MAX_TASK_REGIONS} regions`);
    return codes;
}

// Whether a viewer may see a task. `viewer` is { id, country } or null for anonymous visitors.
function canSeeTask(task, viewer) {
    const limited = Array.isArray(task.regions) && task.regions.length > 0;
    if (!limited) return true;
    if (viewer && String(viewer.id) === String(task.business_id)) return true;
    return Boolean(viewer && viewer.country && task.regions.includes(viewer.country));
}

// Plain-language eligibility for a person in a region. Never claims a payment method exists.
function eligibilityFor(country) {
    if (!country) {
        return { country: null, region_name: null, message: 'Set your country in your profile to see region-specific information.' };
    }
    return {
        country,
        region_name: regionName(country),
        currency: currencyForRegion(country),
        payout_status: 'not_confirmed',
        message: PAYOUT_NOTE,
    };
}

module.exports = {
    REGIONS, CURRENCIES, MAX_TASK_REGIONS, PAYOUT_NOTE, isCountry, regionName, parseTaskRegions, canSeeTask, eligibilityFor,
    currencyForRegion, zonesForRegion, resolveTimeZone, validateTaskCurrency,
};
