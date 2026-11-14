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

    // -------------------------------------------------------------- provider work modes
    // Workers turn on on-site before they can quote on hospitality requests.
    const nearModes = await api('PATCH', '/api/profile/me', { work_modes: ['onsite'], service_area: 'Victoria Island, Ikoyi' }, near.token);
    check('a provider turns on on-site and names the areas they cover', nearModes.status === 200 && nearModes.body.work_modes.includes('onsite'), nearModes.body);

    const farModes = await api('PATCH', '/api/profile/me', { work_modes: ['onsite'] }, far.token);
    check('a provider far away also turns on on-site', farModes.status === 200, farModes.body);

    const secondModes = await api('PATCH', '/api/profile/me', { work_modes: ['onsite'] }, second.token);
    check('a second provider turns on on-site', secondModes.status === 200, secondModes.body);

    const longArea = await api('PATCH', '/api/profile/me', { service_area: 'x'.repeat(300) }, near.token);
    check('a service-area string over 240 characters is refused', longArea.status === 400, longArea.body);

    // -------------------------------------------------------------- the request
    const requestBody = {
        title: 'Emergency clean linen before 2 PM',
        problem: 'We are running low on clean bedsheets and towels, and guests check in this afternoon.',
        needs: 'Collect the dirty linen and deliver 40 sheets and 60 towels before 2 PM.',
        price: 25000,
        region: 'NG',
        address: '12 Adeola Odeku Street, Victoria Island, Lagos',
        area_label: 'Victoria Island',
        deadline: lagosLocal(2, 14, 0),
        industry: 'hotel',
        services: ['Linen laundry and change', 'Pest control'],
        worker_notes: 'Gate code 4471. Ask for Bisi at reception. Bring a trolley.',
        urgent: true,
    };
    const noIndustry = await api('POST', '/api/services/requests', { ...requestBody, industry: undefined }, hotel.token);
    check('a request without an industry is refused', noIndustry.status === 400, noIndustry.body);
    const noServices = await api('POST', '/api/services/requests', { ...requestBody, services: [] }, hotel.token);
    check('a request with no services ticked or typed is refused', noServices.status === 400, noServices.body);
    const badIndustry = await api('POST', '/api/services/requests', { ...requestBody, industry: 'space_station' }, hotel.token);
    check('an industry that is not on the list is refused', badIndustry.status === 400, badIndustry.body);
    const catalogue = await api('GET', '/api/services/catalogue', null, hotel.token);
    check('the catalogue lists industries with services', catalogue.status === 200 && catalogue.body.industries.length >= 5, catalogue.body);
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
    const flagged = listNear.body.requests.find((q) => q.id === requestId);
    check('the provider sees the guest-waiting flag on the list', flagged && flagged.urgent === true, listNear.body);
    const seen = listNear.body.requests.find((r) => r.id === requestId);
    check('a provider with on-site turned on sees the open request', Boolean(seen), listNear.body);
    check('the provider sees the area label, never the address, lat or lng',
        seen.area_label === 'Victoria Island' && !('address' in seen) && !('lat' in seen) && !('lng' in seen), seen);
    check('the provider sees the problem, the needs, the price and the local deadline',
        seen.problem === requestBody.problem && seen.needs === requestBody.needs && seen.price === 25000 &&
        String(seen.local_deadline).includes('Africa/Lagos'), seen);

    const boardLinks = await api('GET', '/api/bounties?limit=50', null, null);
    check('the general bounty board does not show onsite services',
        !(boardLinks.body.bounties || []).some((b) => b.id === requestId), boardLinks.status);

    const remoteOnly = await api('PATCH', '/api/profile/me', { work_modes: ['remote'] }, second.token);
    check('a worker can choose remote work only', remoteOnly.status === 200 && remoteOnly.body.work_mode_off === undefined, remoteOnly.body);
    const secondNear = await api('GET', '/api/services/requests', null, second.token);
    check('a remote-only worker sees no on-site requests', secondNear.status === 200 && secondNear.body.work_mode_off === true && secondNear.body.requests.length === 0, secondNear.body);
    await api('PATCH', '/api/profile/me', { work_modes: ['onsite'] }, second.token);

    const notQuoted = await api('GET', `/api/services/requests/${requestId}`, null, near.token);
    check('a provider who has not quoted cannot open the request', notQuoted.status === 404, notQuoted.body);

    // -------------------------------------------------------------- quotes
    const quote = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 25000, note: 'Can collect at 10 AM' }, near.token);
    check('a provider quotes the price', quote.status === 201 && quote.body.quote.amount === 25000, quote.body);
    const quoteId = quote.body.quote.id;

    const dup = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 24000 }, near.token);
    check('a second pending quote from the same provider is refused', dup.status === 409, dup.body);

    // A worker who has not turned on on-site cannot quote. second has on-site; make a new one.
    const remoteOnlyQuote = await signUp('worker', 'remote');
    await api('PATCH', '/api/profile/me', { work_modes: ['remote'] }, remoteOnlyQuote.token);
    const notEligible = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 20000 }, remoteOnlyQuote.token);
    check('a worker who has not turned on on-site cannot quote', notEligible.status === 422, notEligible.body);

    const second1 = await api('POST', `/api/services/requests/${requestId}/quotes`, { amount: 26000 }, second.token);
    check('a second provider quotes too', second1.status === 201, second1.body);
    const secondQuoteId = second1.body.quote.id;

    const hotelQuotes = await api('GET', `/api/services/requests/${requestId}/quotes`, null, hotel.token);
    check('the hotel sees both quotes', hotelQuotes.body.quotes.length === 2, hotelQuotes.body);

    const hotelView = await api('GET', `/api/services/requests/${requestId}`, null, hotel.token);
    check('the hotel sees the exact address on its own request', hotelView.body.request.address === requestBody.address, hotelView.body);

    // -------------------------------------------------------------- provider hours
    const nearHours = await api('PATCH', '/api/profile/me', {
        work_modes: ['onsite'], available_start: '08:00', available_end: '18:00', timezone: 'Africa/Lagos',
    }, near.token);
    check('a worker saves on-site work and hours', nearHours.status === 200 && nearHours.body.available_start === '08:00', nearHours.body);
    const badHours = await api('PATCH', '/api/profile/me', { available_start: '08:00' }, near.token);
    check('hours need both a start and an end', badHours.status === 400, badHours.body);
    const outsideHours = await api('POST', `/api/services/quotes/${quoteId}/accept`,
        { starts_local: lagosLocal(1, 17, 0), ends_local: lagosLocal(1, 19, 0) }, hotel.token);
    check('a visit that runs past the provider hours is refused', outsideHours.status === 409, outsideHours.body);
    const quotedHours = await api('GET', `/api/services/requests/${requestId}/quotes`, null, hotel.token);
    const nearRow = quotedHours.body.quotes.find((q) => q.id === quoteId);
    check('the business sees the provider hours on the quote', nearRow && nearRow.provider_hours && nearRow.provider_hours.from === '08:00', quotedHours.body);

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
    check('the worker notes stay hidden before both confirm', addressEarly.status === 403 && !addressEarly.body.worker_notes, addressEarly.body);
    const hotelFlag = await api('GET', `/api/services/requests/${requestId}`, null, hotel.token);
    check('the business sees the guest-waiting flag and its own notes', hotelFlag.body.request.urgent === true && hotelFlag.body.request.worker_notes === requestBody.worker_notes, hotelFlag.body);
    const nearBeforeConfirm = await api('GET', `/api/services/requests/${requestId}`, null, near.token);
    check('the provider does not see the worker notes on the request before confirmation', nearBeforeConfirm.body.request && nearBeforeConfirm.body.request.worker_notes === undefined, nearBeforeConfirm.body);


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
    check('the provider sees the worker notes with the address once both confirm',
        addressOpen.body.address.worker_notes === requestBody.worker_notes, addressOpen.body);

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

    // -------------------------------------------------------------- payment made (no escrow)
    const paidOutsider = await api('POST', `/api/services/appointments/${appointmentId}/payment`, null, second.token);
    check('a stranger cannot record payment on the visit', paidOutsider.status === 403, paidOutsider.body);

    const paidByHotel = await api('POST', `/api/services/appointments/${appointmentId}/payment`, null, hotel.token);
    check('the business marks the payment as made', paidByHotel.status === 200 && paidByHotel.body.payment.business_paid === true, paidByHotel.body);
    check('one side alone does not confirm payment', paidByHotel.body.payment.confirmed === false, paidByHotel.body);

    const paidAgain = await api('POST', `/api/services/appointments/${appointmentId}/payment`, null, hotel.token);
    check('marking payment twice changes nothing', paidAgain.status === 200 && paidAgain.body.payment.business_paid === true, paidAgain.body);

    const receivedByProvider = await api('POST', `/api/services/appointments/${appointmentId}/payment`, null, near.token);
    check('the provider confirms receipt, and the visit is paid by both', receivedByProvider.status === 200 && receivedByProvider.body.payment.confirmed === true, receivedByProvider.body);

    const paidView = await api('GET', `/api/services/requests/${requestId}`, null, hotel.token);
    check('the request shows payment confirmed by both', paidView.body.request.appointment && paidView.body.request.appointment.payment.confirmed === true, paidView.body);

    // -------------------------------------------------------------- reviews
    const reviewEarly = await api('POST', `/api/services/appointments/${appointmentId}/review`, { rating: 5 }, hotel.token);
    check('a visit cannot be reviewed before the provider marks it finished', reviewEarly.status === 409, reviewEarly.body);

    const finishedLine = await api('POST', `/api/services/appointments/${appointmentId}/messages`, { kind: 'status', status_code: 'finished' }, near.token);
    check('the provider marks the visit finished', finishedLine.status === 201, finishedLine.body);

    const badRating = await api('POST', `/api/services/appointments/${appointmentId}/review`, { rating: 9 }, hotel.token);
    check('a rating outside 1 to 5 is refused', badRating.status === 400, badRating.body);

    const hotelReview = await api('POST', `/api/services/appointments/${appointmentId}/review`, { rating: 4, note: 'On time and tidy.' }, hotel.token);
    check('the business reviews a finished visit', hotelReview.status === 201 && hotelReview.body.review.rating === 4, hotelReview.body);

    const hotelAgain = await api('POST', `/api/services/appointments/${appointmentId}/review`, { rating: 2 }, hotel.token);
    check('a second review from the same side is refused', hotelAgain.status === 409, hotelAgain.body);

    const providerReview = await api('POST', `/api/services/appointments/${appointmentId}/review`, { rating: 5 }, near.token);
    check('the provider reviews the business', providerReview.status === 201, providerReview.body);

    const hotelReviews = await api('GET', `/api/services/appointments/${appointmentId}/reviews`, null, hotel.token);
    check('each side sees its own review and the other side\'s',
        hotelReviews.body.mine && hotelReviews.body.mine.rating === 4 && hotelReviews.body.theirs && hotelReviews.body.theirs.rating === 5, hotelReviews.body);

    const outsiderReviews = await api('GET', `/api/services/appointments/${appointmentId}/reviews`, null, second.token);
    check('an outsider cannot read the reviews', outsiderReviews.status === 403, outsiderReviews.body);

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
