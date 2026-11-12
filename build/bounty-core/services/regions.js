// services/regions.js — global opportunity access: which countries exist in the catalogue, which
// currencies Bounty actually supports, and who may see a task that is limited to some regions.
//
// Honesty rules
//   * Rewards are priced in naira (NGN). No other currency is listed as supported.
//   * Payout methods are not confirmed for any region. Eligibility here describes what the
//     person has declared, never a guarantee that a payment method exists or that a payment was made.
//   * A task with no region limit is visible everywhere. A task with a region limit is visible to
//     its business and to signed-in people whose declared country is on the list.

const { httpError } = require('../middleware/auth');

const REGIONS = [
    { code: 'NG', name: 'Nigeria' },
    { code: 'GH', name: 'Ghana' },
    { code: 'KE', name: 'Kenya' },
    { code: 'ZA', name: 'South Africa' },
    { code: 'GB', name: 'United Kingdom' },
    { code: 'IE', name: 'Ireland' },
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
    { code: 'DE', name: 'Germany' },
    { code: 'FR', name: 'France' },
    { code: 'IN', name: 'India' },
];
const CODES = new Set(REGIONS.map((r) => r.code));
const MAX_TASK_REGIONS = 10;

const CURRENCIES = [
    { code: 'NGN', name: 'Nigerian naira', status: 'supported', note: 'Every reward on Bounty is priced in naira.' },
    { code: 'USD', name: 'US dollar', status: 'not_supported', note: 'Not supported yet. Rewards are not priced in this currency.' },
    { code: 'GBP', name: 'British pound', status: 'not_supported', note: 'Not supported yet. Rewards are not priced in this currency.' },
    { code: 'EUR', name: 'Euro', status: 'not_supported', note: 'Not supported yet. Rewards are not priced in this currency.' },
];

const PAYOUT_NOTE = 'Payout methods for this region are not confirmed yet. Delivering work does not by itself mean that a payment has been made. A payment is only shown as made once the payment system confirms it.';

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
        currency: 'NGN',
        payout_status: 'not_confirmed',
        message: PAYOUT_NOTE,
    };
}

module.exports = { REGIONS, CURRENCIES, MAX_TASK_REGIONS, PAYOUT_NOTE, isCountry, regionName, parseTaskRegions, canSeeTask, eligibilityFor };
