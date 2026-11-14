// Service discovery for businesses: one photographic strip per industry, each listing the
// services that industry usually needs. Opening a strip starts a request already set to that
// industry (#/services/new?industry=<key>). Photos are optional: each strip falls back to a
// tonal panel when its image is missing, so the page never shows a broken image.
// Loaded after hospitality.js. Uses window.BountyKit and reads /api/services/catalogue.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }

    F.routes.push({
        match: function(r) { return r === 'services/discover'; },
        render: function() { return discover(); }
    });

    // The Hospitality home for businesses uses this page.
    F.discoverPage = discover;

    function shell(body) {
        return '<section class="page discover"><div class="container">' + body + '</div></section>';
    }

    function strip(industry, open) {
        var preview = industry.services.slice(0, 4).map(esc).join(' · ');
        var more = industry.services.length > 4 ? ' · and ' + (industry.services.length - 4) + ' more' : '';
        var hasServices = industry.services.length > 0;
        var target = '#/services/new?industry=' + encodeURIComponent(industry.key);
        return '<a class="discover-strip' + (open ? ' is-open' : '') + '" href="' + target + '" data-industry="' + esc(industry.key) + '">' +
            '<span class="discover-photo" aria-hidden="true">' +
                '<img alt="" loading="lazy" decoding="async" src="photos/services/' + esc(industry.key) + '.jpg"></span>' +
            '<span class="discover-body">' +
                '<span class="discover-title">' + esc(industry.label) + '</span>' +
                '<span class="discover-meta">' + (hasServices
                    ? preview + more
                    : 'Type the service you need') + '</span>' +
            '</span>' +
            '<span class="discover-go">Request</span>' +
        '</a>';
    }

    // Shows the business's own requests under the strips, so nothing is lost when this page is the Hospitality home.
    function loadMine() {
        var box = app().querySelector('.discover-mine');
        if (!box) return;
        K().api('/api/services/requests?mine=1').then(function(res) {
            var rows = res.requests || [];
            var html = rows.length === 0
                ? '<div class="empty-state"><h3>No requests yet</h3><p>Pick an area above to post your first one.</p></div>'
                : '<ul class="list-plain">' + rows.map(function(q) {
                    return '<li class="card-row"><a href="#/services/' + esc(q.id) + '"><strong>' + esc(q.title) + '</strong></a> ' +
                        '<span class="small muted">' + esc(q.area_label) + ' · ' + esc(q.pending_quotes) + ' pending quote' +
                        (Number(q.pending_quotes) === 1 ? '' : 's') + '</span></li>';
                }).join('') + '</ul>';
            box.innerHTML = '<h2 class="h4">Your requests</h2>' + html;
        }).catch(function() {
            box.innerHTML = '<h2 class="h4">Your requests</h2><p class="small muted">Could not load your requests.</p>';
        });
    }

    function discover() {
        if (!K().isAuthenticated()) { K().go('auth/login'); return; }
        if (K().getRole() !== 'business') {
            app().innerHTML = shell('<div class="empty-state"><h3>Only businesses browse services</h3></div>');
            return;
        }
        app().innerHTML = shell('<div class="loading-line"><span class="spinner"></span> Loading services…</div>');
        K().api('/api/services/catalogue').then(function(res) {
            var industries = res.industries || [];
            app().innerHTML = shell(
                '<header class="page-head"><div>' +
                    '<p class="eyebrow">Hospitality services</p>' +
                    '<h1>What does your business need done?</h1>' +
                    '<p class="muted">Choose the area. Each one lists the work teams like yours usually ask for. Providers near you send quotes; the address stays private until you accept one.</p>' +
                '</div></header>' +
                '<div class="discover-list">' +
                    industries.map(function(i, n) { return strip(i, n === 0); }).join('') +
                '</div>' +
                '<section class="hosp-section discover-mine"><div class="loading-line"><span class="spinner"></span> Loading your requests…</div></section>'
            );
            // No inline handlers (CSP script-src 'self'): a missing photo drops out so the tonal panel shows.
            Array.prototype.forEach.call(app().querySelectorAll('.discover-photo img'), function(img) {
                img.addEventListener('error', function() { img.remove(); });
            });
            loadMine();
        }).catch(function(error) {
            app().innerHTML = shell('<div class="notice warning">' +
                esc(K().friendlyApiError(error, 'Could not load services.')) + '</div>');
        });
    }
})();
