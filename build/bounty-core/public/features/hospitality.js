// Hospitality services: a business describes what is wrong and what is needed, sets a price, and
// types the address. Providers in the same region send quotes. The business accepts one, both
// sides confirm the visit, the address opens to the provider only then, and the two talk in a
// thread where the provider can send "on the way". Backed by /api/services (routes/services.js).
// Loaded after core.js and before bounty.js. Uses window.BountyKit.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function route() { return K().currentRoute(); }
    function role() { return K().getRole(); }

    var UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    var STATUS_LABEL = { on_the_way: 'On the way', arrived: 'Arrived', started: 'Started the work', finished: 'Finished the work' };
    var MAX_SERVICES = 10;
    var timer = null;

    function money(amount, currency) {
        return esc(currency || '') + ' ' + Number(amount || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 });
    }
    function when(text) { return esc(text || ''); }
    function setError(node, error, fallback) {
        node.textContent = K().friendlyApiError(error, fallback);
        node.hidden = false;
    }
    function need() {
        if (!K().isAuthenticated()) { K().go('auth/login'); return false; }
        return true;
    }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
    function shell(body) {
        return '<section class="page"><div class="container">' + body + '</div></section>';
    }
    function loading(label) {
        return shell('<div class="loading-line"><span class="spinner"></span> ' + esc(label) + '</div>');
    }
    function failed(error, fallback) {
        return shell('<div class="notice warning">' + esc(K().friendlyApiError(error, fallback)) + '</div>');
    }

    // ------------------------------------------------------------------ routes
    F.routes.push({
        match: function(r) {
            return r === 'services' || r === 'services/new' ||
                new RegExp('^services/' + UUID + '$', 'i').test(r) ||
                new RegExp('^services/appointments/' + UUID + '$', 'i').test(r);
        },
        render: function() {
            stopTimer();
            var r = route();
            if (r === 'services') return home();
            if (r === 'services/new') return newRequest();
            var appt = /^services\/appointments\/(.+)$/.exec(r);
            if (appt) return openAppointment(appt[1]);
            var id = /^services\/(.+)$/.exec(r)[1];
            return detail(id);
        }
    });

    // ------------------------------------------------------------------ hero
    // A warm welcome for the page. Colours are fixed (terracotta and cream) so the white text
    // keeps 5.8:1 contrast in light and dark modes. Counts come from data the page already loads.
    function greeting() {
        var h = new Date().getHours();
        return h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
    }
    function stat(value, label) {
        return '<div class="hosp-stat"><strong>' + esc(value) + '</strong><span>' + esc(label) + '</span></div>';
    }
    function hero(eyebrow, title, lead, stats, cta) {
        return '<header class="hosp-hero"><div class="hosp-hero-text">' +
            '<p class="hosp-eyebrow">' + esc(greeting()) + ' · ' + esc(eyebrow) + '</p>' +
            '<h1>' + esc(title) + '</h1><p class="hosp-lead">' + esc(lead) + '</p>' +
            (cta || '') + '</div>' +
            '<div class="hosp-stats">' + stats.join('') + '</div></header>';
    }

    // ------------------------------------------------------------------ home
    function home() {
        if (!need()) return;
        var r = role();
        if (r === 'business') {
            app().innerHTML = loading('Loading your requests…');
            return Promise.all([K().api('/api/services/requests?mine=1'), K().api('/api/services/appointments')]).then(function(res) {
                businessHome(res[0].requests || [], res[1].appointments || []);
            }).catch(function(error) { app().innerHTML = failed(error, 'Could not load your requests.'); });
        }
        if (r === 'worker') {
            app().innerHTML = loading('Loading services…');
            return Promise.all([
                K().api('/api/profile/me'),
                K().api('/api/services/requests'),
                K().api('/api/services/appointments')
            ]).then(function(res) {
                providerHome(res[0], res[1].requests || [], res[1].needs_area, res[1].work_mode_off, res[2].appointments || []);
            }).catch(function(error) { app().innerHTML = failed(error, 'Could not load services.'); });
        }
        app().innerHTML = shell('<div class="empty-state"><h3>Hospitality services</h3><p>This page is for business and provider accounts.</p></div>');
    }

    function visitList(appointments) {
        if (appointments.length === 0) return '<p class="small muted">No visits yet.</p>';
        return '<ul class="list-plain">' + appointments.map(function(a) {
            return '<li class="card-row"><a href="#/services/' + esc(a.bounty_id) + '"><strong>' + esc(a.title) + '</strong></a> ' +
                '<span class="small muted">' + when(a.local_starts) + ' · ' + esc(a.status) + '</span></li>';
        }).join('') + '</ul>';
    }

    function businessHome(requests, appointments) {
        var list = requests.length === 0
            ? '<div class="empty-state"><h3>No requests yet</h3><p>Describe what is wrong, what is needed and a price. Providers in your region will send quotes.</p></div>'
            : '<ul class="list-plain">' + requests.map(function(q) {
                return '<li class="card-row">' + (q.urgent ? '<span class="badge badge-signal">Guest waiting</span> ' : '') +
                    '<a href="#/services/' + esc(q.id) + '"><strong>' + esc(q.title) + '</strong></a> ' +
                    '<span class="small muted">' + money(q.price, q.currency) + ' · ' + esc(q.area_label) + ' · ' + when(q.local_deadline) +
                    ' · ' + esc(q.pending_quotes) + ' pending quote' + (Number(q.pending_quotes) === 1 ? '' : 's') + '</span></li>';
            }).join('') + '</ul>';
        var pending = requests.reduce(function(sum, q) { return sum + Number(q.pending_quotes || 0); }, 0);
        app().innerHTML = shell('<div class="hosp-page">' +
            hero('Hospitality services', 'Get help for your guests, quickly',
                'Describe what is needed and the price you will pay. Nearby providers send quotes, and the address opens only after you both confirm.',
                [stat(requests.length, 'open requests'), stat(pending, 'quotes to review'), stat(appointments.length, 'visits')],
                '<a class="hosp-cta" href="#/services/new">Start a new request</a>') +
            '<div class="hosp-section"><h2 class="h4">Your requests</h2>' + list + '</div>' +
            '<div class="hosp-section"><h2 class="h4">Visits</h2>' + visitList(appointments) + '</div></div>'
        );
    }

    function providerHome(me, requests, needsArea, workModeOff, appointments) {
        var profileNote = me.service_area
            ? '<p class="small muted">Areas you serve: ' + esc(me.service_area) + '. <a class="inline-link" href="#/profile">Change</a></p>'
            : '<p class="small muted">You have not listed the areas you cover. <a class="inline-link" href="#/profile">Add them</a> so businesses know.</p>';
        var list = workModeOff
            ? '<div class="notice">You chose remote work only, so on-site requests are hidden. <a class="inline-link" href="#/profile">Turn on on-site</a> to see them.</div>'
            : needsArea
            ? '<div class="notice warning">Choose on-site or remote on <a class="inline-link" href="#/profile">your profile</a> before requests show here.</div>'
            : (requests.length === 0
                ? '<div class="empty-state"><h3>No open requests right now</h3><p>New on-site requests appear here. The exact address opens after both sides confirm the visit.</p></div>'
                : '<ul class="list-plain">' + requests.map(function(q) {
                    var mine = q.my_quote
                        ? ' · your quote: ' + money(q.my_quote.amount, q.currency) + ' (' + esc(q.my_quote.status) + ')' : '';
                    var tag = q.urgent ? '<span class="badge badge-signal">Guest waiting</span> ' : '';
                    return '<li class="card-row">' + tag + '<a href="#/services/' + esc(q.id) + '"><strong>' + esc(q.title) + '</strong></a> ' +
                        '<span class="small muted">' + money(q.price, q.currency) + ' · ' + esc(q.area_label) + ' · ' + when(q.local_deadline) + mine + '</span></li>';
                }).join('') + '</ul>');
        app().innerHTML = shell('<div class="hosp-page">' +
            hero('Hospitality services', 'Work close to home',
                'Read the area for each request and quote if you can reach it. The exact address opens only after both sides confirm.',
                [stat(requests.length, 'open requests nearby'), stat(appointments.length, 'your visits')], '') +
            '<div class="hosp-section">' + profileNote + '</div>' +
            '<div class="hosp-section"><h2 class="h4">Open requests</h2>' + list + '</div>' +
            '<div class="hosp-section"><h2 class="h4">Visits</h2>' + visitList(appointments) + '</div></div>'
        );
    }

    // ------------------------------------------------------------------ new request (business)
    function newRequest() {
        if (!need()) return;
        if (role() !== 'business') {
            app().innerHTML = shell('<div class="empty-state"><h3>Only businesses post requests</h3></div>');
            return;
        }
        app().innerHTML = loading('Opening the request form…');
        Promise.all([K().api('/api/global/regions'), K().api('/api/services/catalogue'), K().api('/api/profile/me')]).then(function(res) {
            requestForm(res[0].regions || [], res[1].industries || [], res[2].industry || '');
        }).catch(function(error) { app().innerHTML = failed(error, 'Could not open the form.'); });
    }

    function regionOptions(regions) {
        return regions.map(function(r) {
            return '<option value="' + esc(r.code) + '"' + (r.code === 'NG' ? ' selected' : '') + '>' + esc(r.name) + '</option>';
        }).join('');
    }

    function zoneOptions(region) {
        return region.zones.map(function(z) { return '<option value="' + esc(z) + '">' + esc(z) + '</option>'; }).join('');
    }

    function requestForm(regions, industries, currentIndustry) {
        var byCode = {};
        regions.forEach(function(r) { byCode[r.code] = r; });
        var byKey = {};
        industries.forEach(function(i) { byKey[i.key] = i; });
        var picked = [];
        var industry = byKey[currentIndustry] ? currentIndustry : '';

        app().innerHTML = shell(
            '<div class="page-head"><div><p class="eyebrow">Hospitality services</p><h1>Request a service</h1>' +
            '<p class="muted">Say what is wrong and what is needed, set a price, and give the address. The exact address is shared only with the provider you choose, after you both confirm.</p></div></div>' +
            '<form id="req-form" class="form-card form">' +
            '<div class="field"><label for="req-industry">What industry do you run?</label>' +
            '<select id="req-industry"><option value="">Choose your industry</option>' +
            industries.map(function(i) { return '<option value="' + esc(i.key) + '"' + (i.key === industry ? ' selected' : '') + '>' + esc(i.label) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="field" id="req-services-block" hidden><span class="field-label">What services do you need? Tick what applies.</span>' +
            '<div id="req-services" class="list-plain"></div>' +
            '<label for="req-service-other">Not on the list? Type the service you need</label>' +
            '<div class="form-row"><input id="req-service-other" maxlength="120" placeholder="For example, Fumigation of the kitchen">' +
            '<button class="btn btn-sm" type="button" id="req-service-add">Add</button></div>' +
            '<p class="small muted" id="req-service-count"></p></div>' +
            '<div class="field"><label for="req-title">Title</label><input id="req-title" maxlength="200" required placeholder="For example, Emergency clean linen before 2 PM"></div>' +
            '<div class="field"><label for="req-problem">What is wrong</label><textarea id="req-problem" rows="3" maxlength="2000" required placeholder="We are running low on clean bedsheets and towels."></textarea></div>' +
            '<div class="field"><label for="req-needs">What is needed</label><textarea id="req-needs" rows="3" maxlength="2000" required placeholder="Collect the dirty linen and deliver 40 sheets and 60 towels."></textarea></div>' +
            '<div class="field"><label for="req-region">Region</label><select id="req-region">' + regionOptions(regions) + '</select></div>' +
            '<div class="field"><label for="req-zone" id="req-zone-label">Time zone</label><select id="req-zone"></select>' +
            '<p class="small muted" id="req-zone-note"></p></div>' +
            '<div class="field"><label for="req-price">Price</label><div class="form-row"><span class="small muted" id="req-currency"></span>' +
            '<input id="req-price" type="number" min="1" step="0.01" required placeholder="25000"></div></div>' +
            '<div class="field"><label for="req-area">Area</label><input id="req-area" maxlength="120" required placeholder="For example, Victoria Island">' +
            '<p class="small muted">The area providers see while deciding whether to quote. The street address below opens only after both sides confirm.</p></div>' +
            '<div class="field"><label for="req-address">Service address</label><input id="req-address" minlength="5" maxlength="500" required placeholder="Street, building, landmark">' +
            '<p class="small muted">Shared only with the provider you choose, after you both confirm the visit.</p></div>' +
            '<div class="field"><label for="req-notes">What the worker needs to know</label><textarea id="req-notes" rows="3" maxlength="500" placeholder="Gate code, parking, who to ask for at reception, anything they must bring."></textarea>' +
            '<p class="small muted">Shared with the same provider, after you both confirm. Up to 500 characters.</p></div>' +
            '<div class="field"><label class="check-row"><input id="req-urgent" type="checkbox"> A guest is waiting. Providers see this request first.</label></div>' +
            '<div class="field"><label for="req-deadline">Needed by (local time at the place)</label><input id="req-deadline" type="datetime-local" required></div>' +
            '<p class="form-error" id="req-error" hidden></p>' +
            '<div class="form-actions"><a class="btn btn-sm" href="#/services">Cancel</a><button class="btn btn-primary btn-sm" id="req-submit" type="submit">Post request</button></div>' +
            '</form>'
        );

        var region = document.getElementById('req-region');
        var zone = document.getElementById('req-zone');
        var industrySelect = document.getElementById('req-industry');
        var servicesBox = document.getElementById('req-services');
        var otherInput = document.getElementById('req-service-other');
        var count = document.getElementById('req-service-count');

        function drawServices() {
            var block = document.getElementById('req-services-block');
            block.hidden = !industry;
            if (!industry) return;
            var list = byKey[industry] ? byKey[industry].services : [];
            var html = list.map(function(label) {
                var on = picked.indexOf(label) !== -1;
                return '<label class="card-row"><input type="checkbox" data-svc="' + esc(label) + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
            }).join('');
            var typed = picked.filter(function(label) { return list.indexOf(label) === -1; });
            html += typed.map(function(label) {
                return '<div class="card-row"><input type="checkbox" data-svc="' + esc(label) + '" checked> ' + esc(label) + ' <span class="small muted">(typed)</span></div>';
            }).join('');
            servicesBox.innerHTML = html;
            count.textContent = picked.length + ' of ' + MAX_SERVICES + ' chosen';
        }

        industrySelect.addEventListener('change', function() {
            industry = industrySelect.value;
            picked = [];
            drawServices();
        });

        servicesBox.addEventListener('change', function(e) {
            var label = e.target.getAttribute('data-svc');
            if (!label) return;
            if (e.target.checked) {
                if (picked.length >= MAX_SERVICES) { e.target.checked = false; return K().toast('Choose up to ' + MAX_SERVICES + ' services', 'warning'); }
                if (picked.indexOf(label) === -1) picked.push(label);
            } else {
                picked = picked.filter(function(x) { return x !== label; });
            }
            drawServices();
        });

        document.getElementById('req-service-add').addEventListener('click', function() {
            var text = otherInput.value.trim().replace(/\s+/g, ' ');
            if (text.length < 2) return K().toast('Type the service you need', 'warning');
            if (picked.length >= MAX_SERVICES) return K().toast('Choose up to ' + MAX_SERVICES + ' services', 'warning');
            if (!picked.some(function(x) { return x.toLowerCase() === text.toLowerCase(); })) picked.push(text);
            otherInput.value = '';
            drawServices();
        });

        function refreshRegion() {
            var r = byCode[region.value];
            document.getElementById('req-currency').textContent = 'Priced in ' + r.currency;
            zone.innerHTML = zoneOptions(r);
            var multi = r.zones.length > 1;
            document.getElementById('req-zone-label').hidden = !multi;
            zone.hidden = !multi;
            document.getElementById('req-zone-note').textContent = multi
                ? 'This region has more than one time zone. Choose the one where the service is.'
                : 'The time zone of this place is ' + r.zones[0] + '.';
        }
        region.addEventListener('change', refreshRegion);
        refreshRegion();
        drawServices();

        document.getElementById('req-form').addEventListener('submit', function(e) {
            e.preventDefault();
            var error = document.getElementById('req-error');
            error.hidden = true;
            if (!industry) return setError(error, null, 'Choose the industry you run.');
            if (picked.length === 0) return setError(error, null, 'Tick at least one service, or type the service you need.');
            var r = byCode[region.value];
            var body = {
                industry: industry,
                services: picked,
                title: document.getElementById('req-title').value,
                problem: document.getElementById('req-problem').value,
                needs: document.getElementById('req-needs').value,
                price: document.getElementById('req-price').value,
                region: r.code,
                currency: r.currency,
                address: document.getElementById('req-address').value,
                worker_notes: document.getElementById('req-notes').value,
                urgent: document.getElementById('req-urgent').checked,
                area_label: document.getElementById('req-area').value,
                deadline: document.getElementById('req-deadline').value
            };
            if (r.zones.length > 1) body.time_zone = zone.value;
            var button = document.getElementById('req-submit');
            button.disabled = true;
            K().api('/api/services/requests', { method: 'POST', body: body }).then(function(res) {
                K().toast('Request posted', 'success');
                K().go('services/' + res.id);
            }).catch(function(error2) {
                button.disabled = false;
                setError(document.getElementById('req-error'), error2, 'Could not post the request.');
            });
        });
    }

    // ------------------------------------------------------------------ one request
    function detail(id) {
        if (!need()) return;
        app().innerHTML = loading('Loading the request…');
        Promise.all([K().api('/api/services/requests/' + encodeURIComponent(id)),
            K().api('/api/services/requests/' + encodeURIComponent(id) + '/quotes')]).then(function(res) {
            renderDetail(res[0].request, res[1].quotes || []);
        }).catch(function(error) { app().innerHTML = failed(error, 'Could not open this request.'); });
    }

    function renderDetail(q, quotes) {
        var owner = q.viewer_role === 'business';
        var facts = '<p class="small muted">' + money(q.price, q.currency) + ' · ' + esc(q.area_label) + ' · ' + when(q.local_deadline) + ' · ' + esc(q.status) + '</p>';
        var placeBlock = owner
            ? '<p><strong>Address:</strong> ' + esc(q.address || 'removed') + '</p>'
            : (q.address
                ? '<p><strong>Address:</strong> ' + esc(q.address) + '</p>'
                : '<p class="small muted">Area: ' + esc(q.area_label) + '. The exact address opens after both sides confirm the visit.</p>');
        var header = '<div class="page-head"><div>' + (q.urgent ? '<p><span class="badge badge-signal">Guest waiting</span></p>' : '') +
            '<p class="eyebrow">Hospitality services</p><h1>' + esc(q.title) + '</h1>' + facts + '</div></div>';
        var notesBlock = q.worker_notes
            ? '<p><strong>What the worker needs to know:</strong> ' + when(q.worker_notes) + '</p>' : '';
        var body = '<div class="detail-section"><h2>What is wrong</h2><p>' + when(q.problem) + '</p>' +
            '<h2>What is needed</h2><p>' + when(q.needs) + '</p>' +
            (q.services && q.services.length ? '<p><strong>Services:</strong> ' + q.services.map(esc).join(', ') + '</p>' : '') +
            placeBlock + notesBlock + '</div>';

        body += owner ? quotesBlock(q, quotes) : providerBlock(q, quotes);
        body += '<div id="visit-slot"></div><div id="appt-slot"></div>';
        app().innerHTML = shell(header + body);

        bindQuoteForms(q);
        if (q.appointment) mountAppointment(q.appointment, q, owner);
        loadVisit(q);
    }

    // ------------------------------------------------------------------ visit progress and reviews
    var VISIT_STEPS = [
        ['confirmed', 'Confirmed'], ['on_the_way', 'On the way'], ['arrived', 'Arrived'],
        ['started', 'Started'], ['finished', 'Finished'],
    ];

    function progressHTML(codes) {
        var reached = VISIT_STEPS.filter(function(step) { return codes.indexOf(step[0]) !== -1; });
        var last = reached.length ? reached[reached.length - 1][0] : 'confirmed';
        var items = VISIT_STEPS.map(function(step) {
            var done = step[0] === 'confirmed' || codes.indexOf(step[0]) !== -1;
            var current = step[0] === last;
            return '<li class="visit-step' + (done ? ' done' : '') + '"' + (current ? ' aria-current="step"' : '') + '>' +
                '<span class="visit-dot" aria-hidden="true"></span><span>' + esc(step[1]) + '</span></li>';
        }).join('');
        return '<div class="detail-section"><h2>Visit progress</h2><ol class="visit-progress">' + items + '</ol></div>';
    }

    function reviewHTML(appointmentId, finished, reviews) {
        if (!finished) return '';
        var mine = reviews.mine;
        var theirs = reviews.theirs;
        var theirsText = theirs
            ? '<p class="small"><strong>Their review:</strong> ' + stars(theirs.rating) + (theirs.note ? ' · ' + when(theirs.note) : '') + '</p>'
            : '<p class="small muted">The other side has not reviewed this visit yet.</p>';
        if (mine) {
            return '<div class="detail-section"><h2>Your review</h2><p>' + stars(mine.rating) + (mine.note ? ' · ' + when(mine.note) : '') + '</p>' + theirsText + '</div>';
        }
        return '<div class="detail-section"><h2>Review this visit</h2>' +
            '<form id="review-form" class="form-card form" data-appointment="' + esc(appointmentId) + '">' +
            '<div class="field"><label for="review-rating">Rating</label><select id="review-rating" required>' +
            '<option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Fine</option>' +
            '<option value="2">2 · Poor</option><option value="1">1 · Very poor</option></select></div>' +
            '<div class="field"><label for="review-note">A short note (optional)</label><textarea id="review-note" rows="2" maxlength="500"></textarea></div>' +
            '<p class="form-error" id="review-error" hidden></p>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" id="review-submit" type="submit">Send review</button></div></form>' +
            theirsText + '</div>';
    }

    function stars(n) {
        var v = Math.max(1, Math.min(5, Number(n) || 0));
        return '<span aria-label="' + v + ' out of 5">' + '★'.repeat(v) + '☆'.repeat(5 - v) + '</span>';
    }

    function loadVisit(q) {
        var a = q.appointment;
        var slot = document.getElementById('visit-slot');
        if (!slot || !a || a.status !== 'confirmed') return;
        Promise.all([K().api('/api/services/appointments/' + encodeURIComponent(a.id) + '/messages'),
            K().api('/api/services/appointments/' + encodeURIComponent(a.id) + '/reviews')]).then(function(res) {
            var codes = (res[0].messages || []).filter(function(m) { return m.kind === 'status'; }).map(function(m) { return m.status_code; });
            var finished = codes.indexOf('finished') !== -1;
            slot.innerHTML = progressHTML(codes) + reviewHTML(a.id, finished, res[1]);
            bindReview(q.id);
        }).catch(function() { /* the rest of the page still works without the progress strip */ });
    }

    function bindReview(requestId) {
        var form = document.getElementById('review-form');
        if (!form) return;
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            var error = document.getElementById('review-error');
            var button = document.getElementById('review-submit');
            button.disabled = true;
            K().api('/api/services/appointments/' + encodeURIComponent(form.getAttribute('data-appointment')) + '/review', {
                method: 'POST',
                body: { rating: Number(document.getElementById('review-rating').value), note: document.getElementById('review-note').value }
            }).then(function() {
                K().toast('Thank you for the review', 'success');
                detail(requestId);
            }).catch(function(err) {
                button.disabled = false;
                setError(error, err, 'Could not send the review.');
            });
        });
    }

    function quotesBlock(q, quotes) {
        var rows = quotes.length === 0
            ? '<p class="small muted">No quotes yet.</p>'
            : '<ul class="list-plain">' + quotes.map(function(qt) {
                var accept = (qt.status === 'pending' && !q.appointment)
                    ? ' <button class="btn btn-sm btn-primary" data-accept="' + esc(qt.id) + '">Accept</button>' : '';
                var acceptForm = '<div id="accept-' + esc(qt.id) + '" hidden class="form-card form">' +
                    '<div class="field"><label for="ws-' + esc(qt.id) + '">Visit starts (local time)</label><input id="ws-' + esc(qt.id) + '" type="datetime-local" required></div>' +
                    '<div class="field"><label for="we-' + esc(qt.id) + '">Visit ends (local time)</label><input id="we-' + esc(qt.id) + '" type="datetime-local" required></div>' +
                    '<p class="form-error" id="ae-' + esc(qt.id) + '" hidden></p>' +
                    '<div class="form-actions"><button class="btn btn-primary btn-sm" data-confirm-accept="' + esc(qt.id) + '">Choose this provider</button></div></div>';
                var areaText = qt.provider_area ? ' · covers ' + esc(qt.provider_area) : '';
                var hrs = qt.provider_hours
                    ? ' · available ' + esc(qt.provider_hours.from) + ' to ' + esc(qt.provider_hours.to) + ' (' + esc(qt.provider_hours.zone) + ')' : '';
                return '<li class="card-row"><strong>' + esc(qt.provider_name) + '</strong> · ' + money(qt.amount, q.currency) +
                    ' <span class="small muted">' + esc(qt.status) + areaText + hrs + '</span> ' + accept +
                    (qt.note ? '<p class="small">' + when(qt.note) + '</p>' : '') + acceptForm + '</li>';
            }).join('') + '</ul>';
        return '<div class="detail-section"><h2>Quotes</h2>' + rows + '</div>';
    }

    function providerBlock(q, quotes) {
        var quoted = q.my_quote_status;
        var open = q.status === 'open' && !q.appointment;
        if (quoted) {
            return '<div class="detail-section"><h2>Your quote</h2><p>Status: ' + esc(quoted) + '.</p></div>';
        }
        if (!open) return '<div class="detail-section"><p class="small muted">This request is no longer taking quotes.</p></div>';
        return '<div class="detail-section"><h2>Send a quote</h2>' +
            '<form id="quote-form" class="form-card form">' +
            '<div class="field"><label for="quote-amount">Your price (' + esc(q.currency) + ')</label><input id="quote-amount" type="number" min="1" step="0.01" required></div>' +
            '<div class="field"><label for="quote-note">A short note (optional)</label><textarea id="quote-note" rows="2" maxlength="1000"></textarea></div>' +
            '<p class="form-error" id="quote-error" hidden></p>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" id="quote-submit" type="submit">Send quote</button></div></form></div>';
    }

    function bindQuoteForms(q) {
        Array.prototype.forEach.call(document.querySelectorAll('[data-accept]'), function(btn) {
            btn.addEventListener('click', function() {
                var box = document.getElementById('accept-' + btn.getAttribute('data-accept'));
                box.hidden = !box.hidden;
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-confirm-accept]'), function(btn) {
            btn.addEventListener('click', function() {
                var id = btn.getAttribute('data-confirm-accept');
                var error = document.getElementById('ae-' + id);
                error.hidden = true;
                var starts = document.getElementById('ws-' + id).value;
                var ends = document.getElementById('we-' + id).value;
                if (!starts || !ends) return setError(error, null, 'Choose the start and end of the visit.');
                btn.disabled = true;
                K().api('/api/services/quotes/' + encodeURIComponent(id) + '/accept', { method: 'POST', body: { starts_local: starts, ends_local: ends } })
                    .then(function() { K().toast('Provider chosen. Both sides now confirm the visit.', 'success'); detail(q.id); })
                    .catch(function(error2) { btn.disabled = false; setError(error, error2, 'Could not accept this quote.'); });
            });
        });
        var quoteForm = document.getElementById('quote-form');
        if (quoteForm) {
            quoteForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var error = document.getElementById('quote-error');
                error.hidden = true;
                var button = document.getElementById('quote-submit');
                button.disabled = true;
                K().api('/api/services/requests/' + encodeURIComponent(q.id) + '/quotes', { method: 'POST', body: {
                    amount: document.getElementById('quote-amount').value,
                    note: document.getElementById('quote-note').value
                } }).then(function() {
                    K().toast('Quote sent', 'success');
                    detail(q.id);
                }).catch(function(error2) {
                    button.disabled = false;
                    setError(document.getElementById('quote-error'), error2, 'Could not send your quote.');
                });
            });
        }
    }

    // ------------------------------------------------------------------ the visit
    function mountAppointment(a, q, owner) {
        var slot = document.getElementById('appt-slot');
        if (!slot) return;
        var mine = owner ? 'business' : 'provider';
        var myConfirmed = owner ? a.business_confirmed : a.provider_confirmed;
        var status = a.status === 'confirmed'
            ? '<p class="notice">Visit confirmed. Chat is open.</p>'
            : '<p class="small muted">Waiting for both sides to confirm. The provider confirmed: ' + (a.provider_confirmed ? 'yes' : 'not yet') +
              ' · The business confirmed: ' + (a.business_confirmed ? 'yes' : 'not yet') + '.</p>';
        var confirmBtn = (a.status === 'proposed' && !myConfirmed)
            ? '<button class="btn btn-primary btn-sm" id="appt-confirm">Confirm this visit</button> ' : '';
        var changeBtn = a.status !== 'superseded' && a.status !== 'cancelled'
            ? '<button class="btn btn-sm" id="appt-change-open">Propose another time</button>' : '';
        var removeBtn = owner
            ? ' <button class="btn btn-sm" id="addr-remove">Remove the address</button>' : '';
        var changeForm = '<div id="appt-change" hidden class="form-card form">' +
            '<div class="field"><label for="cs">New start (local time)</label><input id="cs" type="datetime-local"></div>' +
            '<div class="field"><label for="ce">New end (local time)</label><input id="ce" type="datetime-local"></div>' +
            '<p class="form-error" id="appt-error" hidden></p>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" id="appt-change-save">Propose this time</button></div></div>';
        var chat = a.status === 'confirmed'
            ? '<div class="detail-section"><h2>Chat</h2><div id="thread" class="list-plain"></div>' +
              '<p class="form-error" id="chat-warning" hidden></p>' +
              '<form id="chat-form" class="form"><div class="field"><textarea id="chat-body" rows="2" maxlength="1000" placeholder="Write a message"></textarea></div>' +
              '<div class="form-actions"><button class="btn btn-sm btn-primary" type="submit">Send</button></div></form>' +
              (mine === 'provider' ? '<p class="small muted">Send a status line:</p><div class="form-actions">' +
                Object.keys(STATUS_LABEL).map(function(k) {
                    return '<button class="btn btn-sm" data-status="' + k + '">' + esc(STATUS_LABEL[k]) + '</button>';
                }).join(' ') + '</div>' : '') + '</div>'
            : '<div class="detail-section"><p class="small muted">Chat opens when both sides confirm the visit.</p></div>';
        var address = (mine === 'provider' && a.status === 'confirmed' && q.address)
            ? '<p><strong>Address:</strong> ' + esc(q.address) + '</p>' : '';

        slot.innerHTML = '<div class="detail-section"><h2>The visit</h2>' +
            '<p><strong>' + esc(a.local_starts) + '</strong> to ' + esc(a.local_ends) + '</p>' + status + address +
            '<div class="form-actions">' + confirmBtn + changeBtn + removeBtn + '</div>' + changeForm + '</div>' + chat;

        var c = document.getElementById('appt-confirm');
        if (c) c.addEventListener('click', function() {
            K().api('/api/services/appointments/' + encodeURIComponent(a.id) + '/confirm', { method: 'POST', body: {} })
                .then(function() { K().toast('Confirmed', 'success'); detail(q.id); })
                .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not confirm.'), 'danger'); });
        });
        var open = document.getElementById('appt-change-open');
        if (open) open.addEventListener('click', function() { document.getElementById('appt-change').hidden = false; });
        var save = document.getElementById('appt-change-save');
        if (save) save.addEventListener('click', function() {
            var error = document.getElementById('appt-error');
            error.hidden = true;
            K().api('/api/services/appointments/' + encodeURIComponent(a.id) + '/change', { method: 'POST', body: {
                starts_local: document.getElementById('cs').value, ends_local: document.getElementById('ce').value
            } }).then(function() {
                K().toast('New time proposed. Both sides confirm it again.', 'success');
                detail(q.id);
            }).catch(function(error2) { setError(document.getElementById('appt-error'), error2, 'Could not propose that time.'); });
        });
        var remove = document.getElementById('addr-remove');
        if (remove) remove.addEventListener('click', function() {
            if (!window.confirm('Remove the stored address? You can add it again by posting a new request.')) return;
            K().api('/api/services/requests/' + encodeURIComponent(q.id) + '/address', { method: 'DELETE' })
                .then(function() { K().toast('Address removed', 'success'); detail(q.id); })
                .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not remove the address.'), 'danger'); });
        });

        if (a.status === 'confirmed') {
            loadThread(a.id, mine);
            var form = document.getElementById('chat-form');
            form.addEventListener('submit', function(e) {
                e.preventDefault();
                var body = document.getElementById('chat-body').value;
                sendChat(a.id, { kind: 'message', body: body }, mine);
            });
            Array.prototype.forEach.call(document.querySelectorAll('[data-status]'), function(btn) {
                btn.addEventListener('click', function() {
                    sendChat(a.id, { kind: 'status', status_code: btn.getAttribute('data-status') }, mine);
                });
            });
            timer = setInterval(function() { loadThread(a.id, mine); }, 20000);
        }
    }

    function threadLine(m) {
        var who = esc(m.author_name);
        var text = m.kind === 'status'
            ? '<em>' + esc(STATUS_LABEL[m.status_code] || m.status_code) + '</em>'
            : when(m.body);
        return '<div class="card-row"><span class="small muted">' + who + ' · ' + esc(K().dateText(m.created_at)) + '</span><p>' + text + '</p></div>';
    }

    function loadThread(apptId) {
        var node = document.getElementById('thread');
        if (!node) return;
        K().api('/api/services/appointments/' + encodeURIComponent(apptId) + '/messages').then(function(res) {
            var html = res.messages.length === 0
                ? '<p class="small muted">No messages yet.</p>'
                : res.messages.map(threadLine).join('');
            // Redraw only when something changed, so the list does not jump every refresh.
            if (node.getAttribute('data-html-key') !== html) {
                node.setAttribute('data-html-key', html);
                node.innerHTML = html;
            }
        }).catch(function() {});
    }

    function sendChat(apptId, payload, mine) {
        var warning = document.getElementById('chat-warning');
        if (payload.kind === 'message' && !String(payload.body).trim()) return;
        K().api('/api/services/appointments/' + encodeURIComponent(apptId) + '/messages', { method: 'POST', body: payload }).then(function(res) {
            var box = document.getElementById('chat-body');
            if (box) box.value = '';
            if (warning) {
                warning.hidden = !res.warning;
                warning.textContent = res.warning || '';
            }
            loadThread(apptId);
        }).catch(function(error) {
            K().toast(K().friendlyApiError(error, 'Could not send.'), 'danger');
        });
    }

    // Notifications link to /services/appointments/:id. Find the visit and open its request.
    function openAppointment(apptId) {
        if (!need()) return;
        app().innerHTML = loading('Opening the visit…');
        K().api('/api/services/appointments').then(function(res) {
            var found = (res.appointments || []).filter(function(a) { return a.id === apptId; })[0];
            if (!found) {
                app().innerHTML = shell('<div class="empty-state"><h3>This visit is no longer live</h3><p>It may have been changed. Check your visits.</p>' +
                    '<a class="btn btn-sm" href="#/services">Back to services</a></div>');
                return;
            }
            K().go('services/' + found.bounty_id);
        }).catch(function(error) { app().innerHTML = failed(error, 'Could not open this visit.'); });
    }

    // ------------------------------------------------------------------ after sign-in prompts
    // Asked once per sign-in until answered: a business names its industry, a worker says what
    // kind of work they take, where they cover, and when they are free. Both can be left for later.
    // Setup questions open as a side drawer, not a centred dialog: the person can read the page
    // behind it, and "Later" or Escape always closes it without saving.
    // Dismissed prompts stay away for this browser session, so they never return on each page load.
    function laterKey(id) { return "bounty_prompt_later:" + id; }
    function promptBox(id, title, intro, inner, onSave) {
        if (document.getElementById(id)) return;
        try { if (sessionStorage.getItem(laterKey(id))) return; } catch (e) { /* storage unavailable: show it */ }
        var box = document.createElement("aside");
        box.id = id;
        box.className = "drawer";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");
        box.setAttribute("aria-labelledby", id + "-title");
        box.innerHTML = "<div class=\"drawer-head\"><div><p class=\"eyebrow\" style=\"margin-bottom:4px\"><span class=\"eyebrow-dot\"></span> Set up your profile</p>" +
            "<h2 id=\"" + id + "-title\">" + esc(title) + "</h2></div>" +
            "<button class=\"icon-button\" type=\"button\" data-later aria-label=\"Close\">&times;</button></div>" +
            "<div class=\"drawer-body stack-md\"><p class=\"small muted\">" + esc(intro) + "</p>" + inner +
            "<p class=\"form-error\" data-prompt-error hidden></p></div>" +
            "<div class=\"drawer-foot\"><button class=\"btn\" type=\"button\" data-later>Later</button>" +
            "<button class=\"btn btn-primary\" type=\"button\" data-save>Save</button></div>";
        // No backdrop: the page stays usable behind the drawer.
        document.body.appendChild(box);
        function onKey(e) { if (e.key === "Escape") later(); }
        function close() {
            if (box.parentNode) box.parentNode.removeChild(box);
            document.removeEventListener("keydown", onKey);
        }
        function later() {
            try { sessionStorage.setItem(laterKey(id), "1"); } catch (e) { /* ignore */ }
            close();
        }
        document.addEventListener("keydown", onKey);
        box.querySelectorAll("[data-later]").forEach(function(btn) { btn.addEventListener("click", later); });
        box.querySelector("[data-save]").addEventListener("click", function() {
            var button = box.querySelector("[data-save]");
            var error = box.querySelector("[data-prompt-error]");
            error.hidden = true;
            var problem = onSave(box);
            if (problem) { error.textContent = problem; error.hidden = false; return; }
            button.disabled = true;
            var body = box.__body;
            K().api("/api/profile/me", { method: "PATCH", body: body }).then(function() {
                K().toast("Saved", "success");
                close();
            }).catch(function(e) {
                button.disabled = false;
                error.textContent = K().friendlyApiError(e, "Could not save.");
                error.hidden = false;
            });
        });
        return box;
    }

    function showIndustryPrompt() {
        K().api('/api/services/catalogue').then(function(res) {
            var options = res.industries.map(function(i) { return '<option value="' + esc(i.key) + '">' + esc(i.label) + '</option>'; }).join('');
            promptBox('industry-prompt', 'What industry do you run?',
                'This shows the services you usually need, so posting a request takes a minute.',
                '<div class="field"><label for="ip-industry">Industry</label><select id="ip-industry"><option value="">Choose one</option>' + options + '</select></div>',
                function(b) {
                    var v = b.querySelector('#ip-industry').value;
                    if (!v) return 'Choose the industry you run.';
                    b.__body = { industry: v };
                    return '';
                });
        }).catch(function() {});
    }

    function showAvailabilityPrompt() {
        var zone = '';
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { zone = ''; }
        promptBox('availability-prompt', 'How do you work, and when are you free?',
            'Tell us the kind of work you take, the areas you cover and the hours you are free. Your hours are in your own time zone.',
            '<div class="field"><span class="field-label">Kind of work</span>' +
            '<label class="card-row"><input type="checkbox" id="ap-onsite"> On-site jobs</label>' +
            '<label class="card-row"><input type="checkbox" id="ap-remote"> Remote jobs</label></div>' +
            '<div class="field"><label for="ap-area">Areas you cover (optional)</label><input id="ap-area" maxlength="240" placeholder="For example, Victoria Island, Lekki, Ikoyi"></div>' +
            '<div class="field"><label for="ap-from">Available from</label><input id="ap-from" type="time" value="09:00"></div>' +
            '<div class="field"><label for="ap-to">Available until</label><input id="ap-to" type="time" value="17:00"></div>' +
            '<div class="field"><label for="ap-zone">Your time zone</label><input id="ap-zone" maxlength="64" value="' + esc(zone) + '" placeholder="For example, Africa/Lagos"></div>',
            function(b) {
                var modes = [];
                if (b.querySelector('#ap-onsite').checked) modes.push('onsite');
                if (b.querySelector('#ap-remote').checked) modes.push('remote');
                if (modes.length === 0) return 'Choose on-site, remote, or both.';
                var from = b.querySelector('#ap-from').value;
                var to = b.querySelector('#ap-to').value;
                if (!from || !to) return 'Give the start and end of your hours.';
                var z = b.querySelector('#ap-zone').value.trim();
                if (!z) return 'Give your time zone.';
                b.__body = { work_modes: modes, service_area: b.querySelector('#ap-area').value,
                    available_start: from, available_end: to, timezone: z };
                return '';
            });
    }

    // Setup questions do not open by themselves. A banner at the top of the page offers them, and
    // "Later" hides it for this browser session.
    var pendingSetup = null;
    function setupDismissed() {
        try { return !!sessionStorage.getItem("bounty_setup_later"); } catch (e) { return false; }
    }
    function placeSetupBanner() {
        var old = document.getElementById("setup-banner");
        if (old) old.parentNode.removeChild(old);
        if (!pendingSetup || setupDismissed() || !K().isAuthenticated()) return;
        var app = K().app;
        if (!app) return;
        var banner = document.createElement("div");
        banner.id = "setup-banner";
        banner.className = "notice";
        banner.setAttribute("role", "region");
        banner.setAttribute("aria-label", "Finish setting up your profile");
        banner.style.cssText = "margin:16px auto 0;max-width:1120px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap";
        var text = pendingSetup === "industry"
            ? "Tell us what industry you run, so posting a request takes a minute."
            : "Tell us how and when you work, so matching fits your hours.";
        banner.innerHTML = "<span>" + esc(text) + "</span><span style=\"display:flex;gap:8px\">" +
            "<button class=\"btn btn-sm btn-primary\" type=\"button\" data-setup-open>Set up now</button>" +
            "<button class=\"btn btn-sm\" type=\"button\" data-setup-later>Later</button></span>";
        app.insertBefore(banner, app.firstChild);
        banner.querySelector("[data-setup-open]").addEventListener("click", function() {
            var kind = pendingSetup;
            banner.parentNode.removeChild(banner);
            if (kind === "industry") showIndustryPrompt(); else showAvailabilityPrompt();
        });
        banner.querySelector("[data-setup-later]").addEventListener("click", function() {
            try { sessionStorage.setItem("bounty_setup_later", "1"); } catch (e) { /* ignore */ }
            placeSetupBanner();
        });
    }
    F.afterSignIn = function(me) {
        if (!me || !K().isAuthenticated()) return;
        if (me.role === "business" && !me.industry) pendingSetup = "industry";
        else if (me.role === "worker" && (!me.work_modes || me.work_modes.length === 0)) pendingSetup = "availability";
        else pendingSetup = null;
        placeSetupBanner();
    };
    // Called by the shell after each page renders, so the banner survives navigation.
    F.afterRender = placeSetupBanner;

})();
