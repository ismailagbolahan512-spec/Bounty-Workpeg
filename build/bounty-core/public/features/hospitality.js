// Hospitality services: a business describes what is wrong and what is needed, sets a price, drops
// the location on a map and types the address. Providers within reach send quotes. The business
// accepts one, both sides confirm the visit, the address opens to the provider only then, and the
// two talk in a thread where the provider can send "on the way". Backed by /api/services
// (see routes/services.js). Loaded after core.js and before bounty.js. Uses window.BountyKit.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function route() { return K().currentRoute(); }
    function role() { return K().getRole(); }

    var UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    var DEFAULT_CENTRE = { lat: 6.5244, lng: 3.3792 }; // Lagos, until the person picks a place
    var STATUS_LABEL = { on_the_way: 'On the way', arrived: 'Arrived', started: 'Started the work', finished: 'Finished the work' };
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

    // ------------------------------------------------------------------ map pin
    // A Leaflet map with one draggable pin. Tiles are OpenStreetMap, shown with attribution. No
    // geocoding: the person types the address and drops the pin themselves.
    function mapPicker(el, start, onMove) {
        var centre = start || DEFAULT_CENTRE;
        if (!window.L) {
            el.innerHTML = '<p class="small muted">The map could not load. Enter the latitude and longitude below.</p>';
            return null;
        }
        var map = window.L.map(el).setView([centre.lat, centre.lng], start ? 15 : 12);
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
        var marker = window.L.marker([centre.lat, centre.lng], { draggable: true }).addTo(map);
        if (!start) marker.setOpacity(0.5);
        function moved(ll) {
            marker.setOpacity(1);
            marker.setLatLng(ll);
            onMove({ lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) });
        }
        map.on('click', function(e) { moved(e.latlng); });
        marker.on('dragend', function() { moved(marker.getLatLng()); });
        return { invalidate: function() { map.invalidateSize(); } };
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
            app().innerHTML = loading('Loading services near you…');
            return Promise.all([
                K().api('/api/services/provider-area'),
                K().api('/api/services/requests'),
                K().api('/api/services/appointments')
            ]).then(function(res) {
                providerHome(res[0].area, res[1].requests || [], res[1].needs_area, res[2].appointments || [], res[1].work_mode_off);
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
            ? '<div class="empty-state"><h3>No requests yet</h3><p>Describe what is wrong, what is needed and a price. Nearby providers will send quotes.</p></div>'
            : '<ul class="list-plain">' + requests.map(function(q) {
                return '<li class="card-row"><a href="#/services/' + esc(q.id) + '"><strong>' + esc(q.title) + '</strong></a> ' +
                    '<span class="small muted">' + money(q.price, q.currency) + ' · ' + esc(q.area_label) + ' · ' + when(q.local_deadline) +
                    ' · ' + esc(q.pending_quotes) + ' pending quote' + (Number(q.pending_quotes) === 1 ? '' : 's') + '</span></li>';
            }).join('') + '</ul>';
        app().innerHTML = shell(
            '<div class="page-head"><div><p class="eyebrow">Hospitality services</p><h1>Your requests</h1>' +
            '<p class="muted">Ask for the help you need. Providers near the place reply with a price.</p></div>' +
            '<div><a class="btn btn-primary btn-sm" href="#/services/new">New request</a></div></div>' +
            list +
            '<h2 class="h4">Visits</h2>' + visitList(appointments)
        );
    }

    function providerHome(area, requests, needsArea, appointments, workModeOff) {
        var areaBlock = area
            ? '<div class="detail-section"><h2>Your service area</h2><p>' + esc(area.area_label) + ' · within ' + esc(area.radius_km) + ' km' +
              (area.willing_to_travel ? ' · willing to travel further' : '') + '</p>' +
              '<a class="btn btn-sm" href="#/services/new" data-change-area="1">Change area</a></div>'
            : '';
        var list = workModeOff
            ? '<div class="notice">You chose remote work only, so on-site requests are hidden. Change this on your profile to see them.</div>'
            : needsArea
            ? '<div class="notice warning">Set your service area first. Only the area and distance band are shown to businesses, never your exact location.</div>'
            : (requests.length === 0
                ? '<div class="empty-state"><h3>Nothing near you right now</h3><p>New requests inside your area appear here.</p></div>'
                : '<ul class="list-plain">' + requests.map(function(q) {
                    var mine = q.my_quote
                        ? ' · your quote: ' + money(q.my_quote.amount, q.currency) + ' (' + esc(q.my_quote.status) + ')' : '';
                    return '<li class="card-row"><a href="#/services/' + esc(q.id) + '"><strong>' + esc(q.title) + '</strong></a> ' +
                        '<span class="small muted">' + money(q.price, q.currency) + ' · ' + esc(q.distance_band) + ' · ' + when(q.local_deadline) + mine + '</span></li>';
                }).join('') + '</ul>');
        app().innerHTML = shell(
            '<div class="page-head"><div><p class="eyebrow">Hospitality services</p><h1>Near you</h1>' +
            '<p class="muted">Quote on requests in your area. The exact address opens only after both sides confirm.</p></div></div>' +
            areaBlock + (area ? '' : areaForm()) + list +
            '<h2 class="h4">Visits</h2>' + visitList(appointments)
        );
        var change = document.querySelector('[data-change-area]');
        if (change) change.addEventListener('click', function(e) { e.preventDefault(); app().innerHTML = shell(areaForm()); bindAreaForm(); });
        if (!area) bindAreaForm();
    }

    function areaForm() {
        return '<form id="area-form" class="form-card form">' +
            '<div class="field"><label for="area-label">Area you cover</label><input id="area-label" maxlength="120" required placeholder="For example, Yaba"></div>' +
            '<div class="field"><label>Your base on the map (not shown to businesses)</label><div id="area-map" style="height:280px;border-radius:12px"></div>' +
            '<p class="small muted" id="area-latlng">Click the map to place your base.</p></div>' +
            '<div class="field"><label for="area-radius">Radius (km)</label><input id="area-radius" type="number" min="1" max="200" step="1" value="10" required></div>' +
            '<div class="field"><label><input id="area-travel" type="checkbox"> I will travel beyond my radius for the right job</label></div>' +
            '<p class="form-error" id="area-error" hidden></p>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" id="area-save" type="submit">Save my area</button></div></form>';
    }

    function bindAreaForm() {
        var form = document.getElementById('area-form');
        if (!form) return;
        var point = null;
        var picker = mapPicker(document.getElementById('area-map'), null, function(ll) {
            point = ll;
            document.getElementById('area-latlng').textContent = 'Base set at ' + ll.lat + ', ' + ll.lng + '.';
        });
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            var error = document.getElementById('area-error');
            error.hidden = true;
            if (!point) return setError(error, null, 'Click the map to place your base.');
            var button = document.getElementById('area-save');
            button.disabled = true;
            K().api('/api/services/provider-area', { method: 'PUT', body: {
                area_label: document.getElementById('area-label').value,
                lat: point.lat, lng: point.lng,
                radius_km: Number(document.getElementById('area-radius').value),
                willing_to_travel: document.getElementById('area-travel').checked
            } }).then(function() {
                K().toast('Service area saved', 'success');
                K().go('services');
            }).catch(function(error2) {
                button.disabled = false;
                setError(document.getElementById('area-error'), error2, 'Could not save your area.');
            });
        });
        if (picker) picker.invalidate();
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

    var MAX_SERVICES = 10;

    function requestForm(regions, industries, currentIndustry) {
        var byCode = {};
        regions.forEach(function(r) { byCode[r.code] = r; });
        var byKey = {};
        industries.forEach(function(i) { byKey[i.key] = i; });
        var picked = [];
        var industry = byKey[currentIndustry] ? currentIndustry : '';

        app().innerHTML = shell(
            '<div class="page-head"><div><p class="eyebrow">Hospitality services</p><h1>Request a service</h1>' +
            '<p class="muted">Say what is wrong and what is needed, set a price, and drop the place on the map. The exact address is shared only with the provider you choose, after you both confirm.</p></div></div>' +
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
            '<div class="field"><label for="req-area">Area</label><input id="req-area" maxlength="120" required placeholder="For example, Victoria Island"></div>' +
            '<div class="field"><label for="req-address">Service address</label><input id="req-address" minlength="5" maxlength="500" required placeholder="Street, building, landmark"></div>' +
            '<div class="field"><label>Drop the location on the map</label><div id="req-map" style="height:320px;border-radius:12px"></div>' +
            '<p class="small muted" id="req-latlng">Click the map where the service is needed.</p></div>' +
            '<div class="field"><label for="req-deadline">Needed by (local time at the place)</label><input id="req-deadline" type="datetime-local" required></div>' +
            '<p class="form-error" id="req-error" hidden></p>' +
            '<div class="form-actions"><a class="btn btn-sm" href="#/services">Cancel</a><button class="btn btn-primary btn-sm" id="req-submit" type="submit">Post request</button></div>' +
            '</form>'
        );

        var point = null;
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

        var picker = mapPicker(document.getElementById('req-map'), null, function(ll) {
            point = ll;
            document.getElementById('req-latlng').textContent = 'Pin at ' + ll.lat + ', ' + ll.lng + '.';
        });

        document.getElementById('req-form').addEventListener('submit', function(e) {
            e.preventDefault();
            var error = document.getElementById('req-error');
            error.hidden = true;
            if (!industry) return setError(error, null, 'Choose the industry you run.');
            if (picked.length === 0) return setError(error, null, 'Tick at least one service, or type the service you need.');
            if (!point) return setError(error, null, 'Drop the location on the map.');
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
                lat: point.lat, lng: point.lng,
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
        if (picker) picker.invalidate();
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
            ? '<p><strong>Address:</strong> ' + esc(q.address || 'removed') + '</p>' +
              (q.lat != null ? '<p class="small muted">Pin: ' + esc(q.lat) + ', ' + esc(q.lng) + '</p>' : '')
            : (q.address
                ? '<p><strong>Address:</strong> ' + esc(q.address) + '</p>'
                : '<p class="small muted">Area: ' + esc(q.area_label) + ' · ' + esc(q.distance_band || '') + '. The exact address opens after both sides confirm.</p>');
        var header = '<div class="page-head"><div><p class="eyebrow">Hospitality services</p><h1>' + esc(q.title) + '</h1>' + facts + '</div></div>';
        var body = '<div class="detail-section"><h2>What is wrong</h2><p>' + when(q.problem) + '</p>' +
            '<h2>What is needed</h2><p>' + when(q.needs) + '</p>' +
            (q.services && q.services.length ? '<p><strong>Services:</strong> ' + q.services.map(esc).join(', ') + '</p>' : '') +
            placeBlock + '</div>';

        body += owner ? quotesBlock(q, quotes) : providerBlock(q, quotes);
        body += '<div id="appt-slot"></div>';
        app().innerHTML = shell(header + body);

        bindQuoteForms(q);
        if (q.appointment) mountAppointment(q.appointment, q, owner);
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
                var hrs = qt.provider_hours
                    ? ' <span class="small muted">· available ' + esc(qt.provider_hours.from) + ' to ' + esc(qt.provider_hours.to) + ' (' + esc(qt.provider_hours.zone) + ')</span>' : '';
                return '<li class="card-row"><strong>' + esc(qt.provider_name) + '</strong> · ' + money(qt.amount, q.currency) +
                    ' <span class="small muted">' + esc(qt.status) + '</span>' + hrs + accept +
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

    function threadLine(m, mine) {
        var who = esc(m.author_name);
        var text = m.kind === 'status'
            ? '<em>' + esc(STATUS_LABEL[m.status_code] || m.status_code) + '</em>'
            : when(m.body);
        return '<div class="card-row"><span class="small muted">' + who + ' · ' + esc(K().dateText(m.created_at)) + '</span><p>' + text + '</p></div>';
    }

    function loadThread(apptId, mine) {
        var node = document.getElementById('thread');
        if (!node) return;
        K().api('/api/services/appointments/' + encodeURIComponent(apptId) + '/messages').then(function(res) {
            node.innerHTML = res.messages.length === 0
                ? '<p class="small muted">No messages yet.</p>'
                : res.messages.map(function(m) { return threadLine(m, mine); }).join('');
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
            loadThread(apptId, mine);
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
    // kind of work they take and when they are free. Both can be left for later.
    function promptBox(id, title, intro, inner, onSave) {
        if (document.getElementById(id)) return;
        var box = document.createElement('div');
        box.id = id;
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:100;padding:16px';
        box.innerHTML = '<div class="form-card form ux-modal-card"><h2 class="ux-mt0">' + esc(title) + '</h2>' +
            '<p class="small muted">' + esc(intro) + '</p>' + inner +
            '<p class="form-error" data-prompt-error hidden></p>' +
            '<div class="ux-actions-end"><button class="btn" type="button" data-later>Later</button>' +
            '<button class="btn btn-primary" type="button" data-save>Save</button></div></div>';
        document.body.appendChild(box);
        function close() { if (box.parentNode) box.parentNode.removeChild(box); }
        box.querySelector('[data-later]').addEventListener('click', close);
        box.querySelector('[data-save]').addEventListener('click', function() {
            var button = box.querySelector('[data-save]');
            var error = box.querySelector('[data-prompt-error]');
            error.hidden = true;
            var problem = onSave(box);
            if (problem) { error.textContent = problem; error.hidden = false; return; }
            button.disabled = true;
            var body = box.__body;
            K().api('/api/profile/me', { method: 'PATCH', body: body }).then(function() {
                K().toast('Saved', 'success');
                close();
            }).catch(function(e) {
                button.disabled = false;
                error.textContent = K().friendlyApiError(e, 'Could not save.');
                error.hidden = false;
            });
        });
        return box;
    }

    function showIndustryPrompt() {
        K().api('/api/services/catalogue').then(function(res) {
            var options = res.industries.map(function(i) { return '<option value="' + esc(i.key) + '">' + esc(i.label) + '</option>'; }).join('');
            var box = promptBox('industry-prompt', 'What industry do you run?',
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
        promptBox('availability-prompt', 'Where do you work, and when are you free?',
            'Tell us the kind of work you take and the hours you are free. Your hours are in your own time zone.',
            '<div class="field"><span class="field-label">Kind of work</span>' +
            '<label class="card-row"><input type="checkbox" id="ap-onsite"> On-site jobs</label>' +
            '<label class="card-row"><input type="checkbox" id="ap-remote"> Remote jobs</label></div>' +
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
                b.__body = { work_modes: modes, available_start: from, available_end: to, timezone: z };
                return '';
            });
    }

    F.afterSignIn = function(me) {
        if (!me || !K().isAuthenticated()) return;
        if (me.role === 'business' && !me.industry) return showIndustryPrompt();
        if (me.role === 'worker' && (!me.work_modes || me.work_modes.length === 0)) return showAvailabilityPrompt();
    };

})();
