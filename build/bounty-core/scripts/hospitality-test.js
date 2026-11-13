// scripts/hospitality-test.js — the hospitality services flow, end to end, against a running server.
//
// Usage (the run-tests harness starts the server and sets BASE):
//   BASE=http://localhost:3100 node scripts/hospitality-test.js
// Exits with code 1 on the first failed check. Creates its own accounts with unique emails.
//
// The flow: a business posts a request with a problem, what is needed, a price and a location.
// A provider within reach sees it (distance band only, never the address), quotes, is accepted,
// both sides confirm, the address opens to the provider only then, chat opens, the provider sends
// "on my way", the business is notified, a reschedule resets confirmations, and the address can be removed.

const BASE = process.env.BASE || 'http://localhost:3100';

let passed = 0;
function check(label, condition, detail) {
    if (!condition) {
        console.error(`✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
        process.exit(1);
    }
    passed += 1;
    console.log(`✓ ${label}`);
}

async function api(method, path, body, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, body: data };
}

const stamp = Date.now();
const PASSWORD = 'password123';

async function signUp(role, label) {
    const email = `hosp-${label}+${stamp}@test.com`;
    const r = await api('POST', '/api/auth/signup', { email, password: PASSWORD, name: `Hosp ${label}`, role });
    check(`${label} signs up as ${role}`, r.status === 201, r.body);
    return { token: r.body.token, id: r.body.id, name: r.body.name };
}

// A local wall-clock time in Lagos (UTC+1, no daylight saving): "YYYY-MM-DDTHH:mm".
function lagosLocal(daysFromNow, hour, minute) {
    const d = new Date(Date.now() + daysFromNow * 86400000 + 3600000);
    const iso = d.toISOString().slice(0, 10);
    return `${iso}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// The Lagos wall-clock time `minutes` from now.
function lagosFromNow(minutes) {
    const d = new Date(Date.now() + minutes * 60000 + 3600000);
    return `${d.toISOString().slice(0, 10)}T${d.toISOString().slice(11, 16)}`;
}

async function main() {
    // -------------------------------------------------------------- accounts
    const hotel = await signUp('business', 'hotel');
    const agreed = await api('POST', '/api/protection/agreements/accept', { kind: 'creator_protection_business' }, hotel.token);
    check('the hotel accepts the business agreement', agreed.status < 300, agreed.body);

    const near = await signUp('worker', 'laundry');
    const far = await signUp('worker', 'faraway');
    const second = await signUp('worker', 'second');

    // -------------------------------------------------------------- provider areas
    const areaNear = await api('PUT', '/api/services/provider-area',
        { area_label: 'Ikoyi', lat: 6.4531, lng: 3.4360, radius_km: 10, willing_to_travel: false }, near.token);
    check('a provider sets a private service area', areaNear.status === 200 && areaNear.body.area.radius_km === 10, areaNear.body);

    const areaFar = await api('PUT', '/api/services/provider-area',
        { area_label: 'Abuja', lat: 9.0765, lng: 7.3986, radius_km: 10, willing_to_travel: false }, far.token);
    check('a provider far away sets an area too', areaFar.status === 200, areaFar.body);

    const areaSecond = await api('PUT', '/api/services/provider-area',
        { area_label: 'Lekki', lat: 6.4478, lng: 3.4723, radius_km: 15, willing_to_travel: false }, second.token);
    check('a second nearby provider sets an area', areaSecond.status === 200, areaSecond.body);

    const badArea = await api('PUT', '/api/services/provider-area',
        { area_label: 'Yaba', lat: 6.5, lng: 3.3, radius_km: 0 }, near.token);
    check('a radius of 0 is refused', badArea.status === 400, badArea.body);

    const businessArea = await api('PUT', '/api/services/provider-area',
        { area_label: 'Yaba', lat: 6.5, lng: 3.3, radius_km: 5 }, hotel.token);
    check('a business cannot set a provider area', businessArea.status === 403, businessArea.body);

    // -------------------------------------------------------------- the request
    const requestBody = {
        title: 'Emergency clean linen before 2 PM',
        problem: 'We are running low on clean bedsheets and towels, and guests check in this afternoon.',
        needs: 'Collect the dirty linen and deliver 40 sheets and 60 towels before 2 PM.',
        price: 25000,
        region: 'NG',
        address: '12 Adeola Odeku Street, Victoria Island, Lagos',
        lat: 6.4281,
        lng: 3.4219,
        area_label: 'Victoria Island',
        deadline: lagosLocal(2, 14, 0),
    };
    const posted = await api('POST', '/api/services/requests', requestBody, hotel.token);
    check('the hotel posts a request with a price and a location', posted.status === 201, posted.body);
    check('the request is priced in naira and runs on Lagos time', posted.body.currency === 'NGN' && posted.body.time_zone === 'Africa/Lagos', posted.body);
    const requestId = posted.body.id;

    const badCurrency = await api('POST', '/api/services/requests', { ...requestBody, currency: 'GBP' }, hotel.token);
    check('a request cannot be priced in a currency from another region', badCurrency.status === 400, badCurrency.body);

    const badZone = await api('POST', '/api/services/requests', { ...requestBody, time_zone: 'Asia/Tokyo' }, hotel.token);
    check('a time zone that does not match the location is refused', badZone.status === 400, badZone.body);

    const tooSoon = await api('POST', '/api/services/requests', { ...requestBody, deadline: lagosFromNow(30) }, hotel.token);
    check('a deadline less than an hour away is refused', tooSoon.status === 400, tooSoon.body);

    const worker = await api('POST', '/api/services/requests', requestBody, near.token);
    check('a provider cannot post a request', worker.status === 403, worker.body);

    // -------------------------------------------------------------- what a provider sees
    const listNear = await api('GET', '/api/services/requests', null, near.token);
    const seen = listNear.body.requests.find((r) => r.id === requestId);
    check('a provider within reach sees the request', Boolean(seen), listNear.body);
    check('the provider sees the distance band, not the address or pin',
        seen.distance_band === 'under 5 km' && !('address' in seen) && !('lat' in seen) && !('lng' in seen), seen);
    check('the provider sees the problem, the needs, the price and the local deadline',
        seen.problem === requestBody.problem && seen.needs === requestBody.needs && seen.price === 25000 &&
        String(seen.local_deadline).includes('Africa/Lagos'), seen);

    const listFar = await api('GET', '/api/services/requests', null, far.token);
    check('a provider outside the radius does not see it', !listFar.body.requests.some((r) => r.id === requestId), listFar.body);

    const boardLinks = await api('GET', '/api/bounties?limit=50', null, null);
    check('the general bounty board does not show onsite services',
        !(boardLinks.body.bounties || []).some((b) => b.id === requestId), boardLinks.status);

    const notQuoted = await api('GET', `/api/services/requests/${requestId}`, null, near.token);
    check('a provider who has not quoted cannot open the request', notQuoted.status === 404, notQuoted.body);

    // -------------------------------------------------------------- quotes
    const quote = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 25000, note: 'Can collect at 10 AM' }, near.token);
    check('a provider quotes the price', quote.status === 201 && quote.body.quote.amount === 25000, quote.body);
    const quoteId = quote.body.quote.id;

    const dup = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 24000 }, near.token);
    check('a second pending quote from the same provider is refused', dup.status === 409, dup.body);

    const farQuote = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 20000 }, far.token);
    check('a provider outside the radius cannot quote', farQuote.status === 403, farQuote.body);

    const second1 = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 26000 }, second.token);
    check('a second provider quotes too', second1.status === 201, second1.body);
    const secondQuoteId = second1.body.quote.id;

    const hotelQuotes = await api('GET', `/api/services/requests/${requestId}/quotes`, null, hotel.token);
    check('the hotel sees both quotes', hotelQuotes.body.quotes.length === 2, hotelQuotes.body);

    const hotelView = await api('GET', `/api/services/requests/${requestId}`, null, hotel.token);
    check('the hotel sees the exact address on its own request', hotelView.body.request.address === requestBody.address, hotelView.body);

    // -------------------------------------------------------------- accept
    const window = { starts_local: lagosLocal(1, 9, 0), ends_local: lagosLocal(1, 12, 0) };
    const late = await api('POST', `/api/services/quotes/${quoteId}/accept`, { starts_local: lagosLocal(1, 9, 0), ends_local: lagosLocal(3, 12, 0) }, hotel.token);
    check('a visit window that runs past 24 hours is refused', late.status === 400, late.body);

    const accepted = await api('POST', `/api/services/quotes/${quoteId}/accept`, window, hotel.token);
    check('the hotel accepts the quote and proposes a window', accepted.status === 201 && accepted.body.appointment.status === 'proposed', accepted.body);
    const appointmentId = accepted.body.appointment.id;

    const quotesAfter = await api('GET', `/api/services/requests/${requestId}/quotes`, null, hotel.token);
    const statuses = Object.fromEntries(quotesAfter.body.quotes.map((q) => [q.id, q.status]));
    check('the accepted quote is marked accepted and the other is declined',
        statuses[quoteId] === 'accepted' && statuses[secondQuoteId] === 'declined', statuses);

    const quoteAfterAccept = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 22000 }, second.token);
    check('nobody can quote once a provider is chosen', quoteAfterAccept.status === 409, quoteAfterAccept.body);

    // -------------------------------------------------------------- before confirmation
    const addressEarly = await api('GET', `/api/services/appointments/${appointmentId}/address`, null, near.token);
    check('the address stays hidden before both confirm', addressEarly.status === 403 && !addressEarly.body.address, addressEarly.body);

    const chatEarly = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'message', body: 'Hi' }, near.token);
    check('chat is closed before both confirm', chatEarly.status === 409, chatEarly.body);

    const providerConfirm = await api('POST', `/api/services/appointments/${appointmentId}/confirm`, null, near.token);
    check('the provider confirms, and the appointment waits for the hotel', providerConfirm.body.appointment.status === 'proposed', providerConfirm.body);

    const hotelConfirm = await api('POST', `/api/services/appointments/${appointmentId}/confirm`, null, hotel.token);
    check('the hotel confirms, and the appointment is confirmed', hotelConfirm.body.appointment.status === 'confirmed', hotelConfirm.body);

    // -------------------------------------------------------------- after confirmation
    const addressOpen = await api('GET', `/api/services/appointments/${appointmentId}/address`, null, near.token);
    check('the provider sees the exact address once both confirm',
        addressOpen.status === 200 && addressOpen.body.address.address_text === requestBody.address, addressOpen.body);

    const addressOther = await api('GET', `/api/services/appointments/${appointmentId}/address`, null, second.token);
    check('another provider cannot read the address', addressOther.status === 403, addressOther.body);

    const chatOpen = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'message', body: 'Please leave the linen at the back door.' }, near.token);
    check('chat opens after confirmation', chatOpen.status === 201 && chatOpen.body.warning === null, chatOpen.body);

    const addressLine = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'message', body: 'Come to 12 Adeola Odeku Street, the blue gate' }, hotel.token);
    check('a message with a street address is flagged, not blocked',
        addressLine.status === 201 && typeof addressLine.body.warning === 'string', addressLine.body);

    const hotelStatus = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'status', status_code: 'on_the_way' }, hotel.token);
    check('only the provider sends status lines', hotelStatus.status === 403, hotelStatus.body);

    const onWay = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'status', status_code: 'on_the_way' }, near.token);
    check('the provider sends "on the way"', onWay.status === 201 && onWay.body.message.status_code === 'on_the_way', onWay.body);

    const badStatus = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'status', status_code: 'teleported' }, near.token);
    check('an unknown status line is refused', badStatus.status === 400, badStatus.body);

    const memo = await api('GET', '/api/notifications', null, hotel.token);
    const memoList = Array.isArray(memo.body) ? memo.body : (memo.body && memo.body.notifications) || [];
    check('the hotel gets the memo that the provider is on the way',
        memoList.some((n) => /is on the way/.test(n.message)), memoList.slice(0, 3));

    const thread = await api('GET', `/api/services/appointments/${appointmentId}/messages`, null, hotel.token);
    check('both parties can read the thread', thread.status === 200 && thread.body.messages.length === 3 && thread.body.open === true, thread.body);

    const outsiderThread = await api('GET', `/api/services/appointments/${appointmentId}/messages`, null, second.token);
    check('an outsider cannot read the thread', outsiderThread.status === 404, outsiderThread.body);

    const removeWhileConfirmed = await api('DELETE', `/api/services/requests/${requestId}/address`, null, hotel.token);
    check('the address cannot be removed while a visit is confirmed', removeWhileConfirmed.status === 409, removeWhileConfirmed.body);

    // -------------------------------------------------------------- reschedule
    const change = await api('POST', `/api/services/appointments/${appointmentId}/change`,
        { starts_local: lagosLocal(1, 13, 0), ends_local: lagosLocal(1, 15, 0) }, hotel.token);
    check('the hotel proposes a new window', change.status === 201 && change.body.appointment.status === 'proposed', change.body);
    const newAppointmentId = change.body.appointment.id;

    const chatAfterChange = await api('POST', `/api/services/appointments/${newAppointmentId}/messages`, { kind: 'message', body: 'Still on?' }, near.token);
    check('a rescheduled visit needs fresh confirmations before chat', chatAfterChange.status === 409, chatAfterChange.body);

    const addressAfterChange = await api('GET', `/api/services/appointments/${newAppointmentId}/address`, null, near.token);
    check('the address closes again after a reschedule', addressAfterChange.status === 403, addressAfterChange.body);

    const oldConfirm = await api('POST', `/api/services/appointments/${appointmentId}/confirm`, null, near.token);
    check('the superseded appointment cannot be confirmed', oldConfirm.status === 409, oldConfirm.body);

    await api('POST', `/api/services/appointments/${newAppointmentId}/confirm`, null, near.token);
    const reconfirmed = await api('POST', `/api/services/appointments/${newAppointmentId}/confirm`, null, hotel.token);
    check('both confirm the new window again', reconfirmed.body.appointment.status === 'confirmed', reconfirmed.body);

    // -------------------------------------------------------------- address removal
    const cancelledCheck = await api('GET', '/api/services/appointments', null, hotel.token);
    check('the hotel lists its live appointments', cancelledCheck.status === 200 && cancelledCheck.body.appointments.length >= 1, cancelledCheck.body);

    const removeFinal = await api('DELETE', `/api/services/requests/${requestId}/address`, null, hotel.token);
    check('the address cannot be removed while the rescheduled visit is confirmed', removeFinal.status === 409, removeFinal.body);

    const notOwner = await api('DELETE', `/api/services/requests/${requestId}/address`, null, near.token);
    check('only the business can remove the address', notOwner.status === 403, notOwner.body);

    console.log(`\n${passed} hospitality checks passed`);
}

main().catch((err) => {
    console.error('✗ hospitality test crashed:', err);
    process.exit(1);
});
