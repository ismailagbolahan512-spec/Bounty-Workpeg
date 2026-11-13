// The industries a business can run and the hospitality services each usually needs.
// A business picks an industry, ticks the services it needs, and can type any service that
// is not on the list. Typed services are stored as written (escaped on display), never as code.
const { httpError } = require('../middleware/auth');

const INDUSTRIES = [
    { key: 'hotel', label: 'Hotel', services: [
        'Room cleaning and housekeeping', 'Linen laundry and change', 'Plumbing repair', 'Electrical repair',
        'Air conditioning service', 'Generator service', 'Pest control', 'Kitchen equipment repair',
        'Painting and touch-up', 'Deep clean after checkout', 'Security cover'] },
    { key: 'short_let', label: 'Guesthouse or short-let', services: [
        'Turnover cleaning between guests', 'Linen supply', 'Emergency repair', 'Pest control',
        'Water tank cleaning', 'Generator fuel and service', 'Furniture repair', 'Photography for listing'] },
    { key: 'restaurant', label: 'Restaurant or café', services: [
        'Kitchen deep clean', 'Extraction and hood cleaning', 'Refrigeration repair', 'Gas and cooker repair',
        'Pest control', 'Waste collection', 'Staff uniform laundry', 'Signage and menu printing',
        'Point-of-sale support', 'Generator service'] },
    { key: 'bar_club', label: 'Bar or nightclub', services: [
        'Bar equipment repair', 'Sound and lighting technician', 'Door security', 'Glassware washing',
        'Pest control', 'Cleaning after events', 'Generator service', 'Air conditioning service'] },
    { key: 'event_venue', label: 'Event venue', services: [
        'Event setup and teardown', 'Stage and lighting crew', 'Sound system and technician', 'Catering staff',
        'Chair and table hire', 'Event cleaning', 'Security for events', 'Photography and video'] },
    { key: 'catering', label: 'Catering company', services: [
        'Event cooking staff', 'Serving staff', 'Equipment hire', 'Van and delivery crew',
        'Dishwashing crew', 'Generator for cooking'] },
    { key: 'spa_wellness', label: 'Spa, gym or wellness', services: [
        'Massage therapist cover', 'Gym equipment repair', 'Towel and linen laundry', 'Water filtration service',
        'Air conditioning service', 'Deep cleaning', 'Pest control'] },
    { key: 'other', label: 'Something else', services: [] },
];

const INDUSTRY_KEYS = new Set(INDUSTRIES.map((i) => i.key));
const MAX_SERVICES = 10;
const SERVICE_MIN = 2;
const SERVICE_MAX = 120;

function industryFor(key) {
    return INDUSTRIES.find((i) => i.key === key) || null;
}

function validIndustry(key) {
    return typeof key === 'string' && INDUSTRY_KEYS.has(key);
}

// The list of service labels for a request: one to ten, each 2 to 120 characters, no repeats
// (ignoring case). Labels from the catalogue and typed ones are both accepted.
function validateServiceLabels(labels) {
    if (!Array.isArray(labels)) throw httpError(400, 'Choose at least one service, or type the service you need');
    const cleaned = [];
    const seen = new Set();
    for (const raw of labels) {
        if (typeof raw !== 'string') throw httpError(400, 'Each service must be text');
        const label = raw.trim().replace(/\s+/g, ' ');
        if (label.length < SERVICE_MIN || label.length > SERVICE_MAX) {
            throw httpError(400, `Each service must be ${SERVICE_MIN} to ${SERVICE_MAX} characters`);
        }
        const k = label.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        cleaned.push(label);
    }
    if (cleaned.length === 0) throw httpError(400, 'Choose at least one service, or type the service you need');
    if (cleaned.length > MAX_SERVICES) throw httpError(400, `Choose up to ${MAX_SERVICES} services`);
    return cleaned;
}

module.exports = { INDUSTRIES, MAX_SERVICES, industryFor, validIndustry, validateServiceLabels };
