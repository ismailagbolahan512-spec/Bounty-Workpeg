// Workpeg links: the signed-in user's own settings for connecting Workpeg to Bounty.
// Lists link tokens, issues and rotates them (a token is shown once), revokes them, and lists
// pending approvals for sensitive actions. Backed by /api/integration-tokens (see routes/integration-tokens.js).
// Loaded after core.js and before bounty.js. Uses window.BountyKit for shared helpers.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function when(v) { return v ? K().dateText(v) : 'Never'; }
    function errorBox(node, error, fallback) { node.textContent = K().friendlyApiError(error, fallback); node.hidden = false; }

    // Mirrors SCOPE_ROLES in services/integration-tokens.js. The server still checks every request.
    var SCOPES = [
        { id: 'bounties:read', label: 'Read open bounties', roles: ['worker', 'business'] },
        { id: 'bounties:draft', label: 'Draft bounties', roles: ['business'] },
        { id: 'bounties:publish', label: 'Publish bounties (you approve each one)', roles: ['business'], sensitive: true },
        { id: 'applications:write', label: 'Apply to bounties (you approve each one)', roles: ['worker'], sensitive: true },
        { id: 'submissions:write', label: 'Submit work (you approve each one)', roles: ['worker'], sensitive: true },
        { id: 'workspace:read', label: 'Read your workspace', roles: ['worker', 'business'] }
    ];
    var ACTION_LABEL = {
        'bounties:publish': 'Publish a bounty',
        'applications:write': 'Apply to a bounty',
        'submissions:write': 'Submit work'
    };

    // A newly issued token is kept in memory only, for this page visit. It is cleared when the user
    // leaves the page, so it cannot show again later.
    var onceToken = null;
    var onceTitle = '';

    F.routes.push({
        match: function(r) { return r === 'settings/workpeg'; },
        render: function() { onceToken = null; return workpegPage(false); }
    });

    function need() {
        if (!K().isAuthenticated()) { K().go('auth/login'); return false; }
        return true;
    }

    function scopesForRole() {
        var role = K().getRole();
        return SCOPES.filter(function(s) { return s.roles.indexOf(role) !== -1; });
    }

    // keepOnce is true when the page is refreshed by an action on the page itself.
    function workpegPage(keepOnce) {
        if (!need()) return;
        if (!keepOnce) onceToken = null;
        app().innerHTML = '<section class="page"><div class="container narrow"><div class="loading-line"><span class="spinner"></span> Loading your Workpeg links…</div></div></section>';
        Promise.all([K().api('/api/integration-tokens'), K().api('/api/integration-tokens/confirmations')]).then(function(res) {
            render(res[0].tokens || [], res[1].confirmations || []);
        }).catch(function(error) {
            app().innerHTML = '<section class="page"><div class="container narrow"><div class="notice warning">' +
                esc(K().friendlyApiError(error, 'Could not load your Workpeg links.')) + '</div></div></section>';
        });
    }

    function render(tokens, pending) {
        var active = tokens.filter(function(t) { return !t.revoked_at && new Date(t.expires_at) > new Date(); });
        var inactive = tokens.filter(function(t) { return t.revoked_at || new Date(t.expires_at) <= new Date(); });

        var tokenRows = active.length ? '<ul class="list-plain">' + active.map(function(t) {
            return '<li class="card-row"><strong>' + esc(t.label || 'Untitled link') + '</strong> ' +
                '<div class="small muted">Scopes: ' + esc((t.scopes || []).join(', ')) + '</div>' +
                '<div class="small muted">Expires ' + esc(when(t.expires_at)) + ' · last used ' + esc(when(t.last_used_at)) + '</div>' +
                '<div class="form-actions">' +
                '<button class="btn btn-sm" type="button" data-rotate="' + esc(t.id) + '">Rotate</button> ' +
                '<button class="btn btn-sm" type="button" data-revoke="' + esc(t.id) + '">Revoke</button></div></li>';
        }).join('') + '</ul>' : '<p class="muted">No active Workpeg links.</p>';

        var pendingHtml = pending.length ? '<ul class="list-plain">' + pending.map(function(c) {
            return '<li class="card-row"><strong>' + esc(ACTION_LABEL[c.action] || c.action) + '</strong> ' +
                '<div class="small muted">From link "' + esc(c.token_label || 'Untitled link') + '" · expires ' + esc(when(c.expires_at)) + '</div>' +
                '<div class="form-actions"><button class="btn btn-primary btn-sm" type="button" data-approve="' + esc(c.id) + '">Approve</button></div></li>';
        }).join('') + '</ul>' : '<p class="muted">Nothing is waiting for your approval.</p>';

        var inactiveHtml = inactive.length ? '<details class="small muted"><summary>Past links (' + inactive.length + ')</summary><ul class="list-plain">' + inactive.map(function(t) {
            return '<li>' + esc(t.label || 'Untitled link') + ' · ' + (t.revoked_at ? 'revoked ' + esc(when(t.revoked_at)) : 'expired ' + esc(when(t.expires_at))) + '</li>';
        }).join('') + '</ul></details>' : '';

        var scopeBoxes = scopesForRole().map(function(s) {
            return '<label class="check-row"><input type="checkbox" name="scopes" value="' + esc(s.id) + '"' + (s.sensitive ? '' : ' checked') + '> ' + esc(s.label) + '</label>';
        }).join('');

        app().innerHTML = '<section class="page"><div class="container narrow">' +
            '<div class="page-head"><div><p class="eyebrow">Your account</p><h1>Workpeg links</h1></div></div>' +
            '<p class="muted">A Workpeg link lets Workpeg AI read and act in Bounty for you, only within the scopes you choose. You can revoke a link at any time, and it stops working on the next request. Signing out also ends all your links. Actions marked for approval wait until you approve them here.</p>' +

            '<section class="detail-section"><h2>Approvals waiting for you</h2>' +
            '<div class="notice" role="note">You can see which action is waiting. The full details of the request are not shown yet, so only approve requests you recognise.</div>' +
            '<div id="wp-approve-error" class="form-error" hidden role="alert"></div>' + pendingHtml + '</section>' +

            '<section class="detail-section"><h2>Your links</h2>' + tokenRows + inactiveHtml + '</section>' +

            '<section class="detail-section"><h2>Create a link</h2>' +
            '<form id="wp-create" class="form-card form">' +
            '<div class="field"><label for="wp-label">Name</label><input id="wp-label" maxlength="80" required placeholder="For example, My Workpeg assistant"></div>' +
            '<fieldset class="field"><legend>Scopes</legend>' + scopeBoxes + '</fieldset>' +
            '<div class="field"><label for="wp-days">Lifetime (days, up to 90)</label><input id="wp-days" type="number" min="1" max="90" value="30"></div>' +
            '<div class="form-error" id="wp-create-error" hidden role="alert"></div>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Create link</button></div>' +
            '</form>' + onceHtml() + '</section>' +
            '</div></section>';

        bind();
    }

    function onceHtml() {
        if (!onceToken) return '<div id="wp-once"></div>';
        return '<div id="wp-once"><div class="notice" role="status"><strong>' + esc(onceTitle) + '</strong><p class="small">Copy this now. It is shown only once and cannot be displayed again.</p>' +
            '<code class="wp-token" id="wp-token-text">' + esc(onceToken) + '</code>' +
            '<div class="form-actions"><button class="btn btn-sm" type="button" id="wp-copy">Copy</button></div></div></div>';
    }

    function bindCopy() {
        var copy = document.getElementById('wp-copy');
        if (!copy) return;
        copy.addEventListener('click', function() {
            var text = document.getElementById('wp-token-text').textContent;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function() {
                    onceToken = null;
                    document.getElementById('wp-once').innerHTML = '';
                    K().toast('Copied', 'success');
                }, function() { K().toast('Could not copy. Select the text and copy it.', 'warning'); });
            } else {
                K().toast('Select the text and copy it.', 'warning');
            }
        });
    }

    // Shows a newly issued token in place, then refreshes the list around it.
    function issued(token, title) {
        onceToken = token;
        onceTitle = title;
        workpegPage(true);
    }

    function bind() {
        bindCopy();
        var create = document.getElementById('wp-create');
        create.addEventListener('submit', function(event) {
            event.preventDefault();
            var errorNode = document.getElementById('wp-create-error');
            errorNode.hidden = true;
            var scopes = Array.prototype.slice.call(create.querySelectorAll('input[name="scopes"]:checked')).map(function(n) { return n.value; });
            if (scopes.length === 0) return errorBox(errorNode, null, 'Choose at least one scope.');
            var days = Number(document.getElementById('wp-days').value) || 30;
            var label = document.getElementById('wp-label').value.trim();
            K().api('/api/integration-tokens', { method: 'POST', body: { label: label, scopes: scopes, days: days } }).then(function(res) {
                issued(res.token, 'Your new Workpeg link');
            }).catch(function(error) { errorBox(errorNode, error, 'Could not create the link.'); });
        });

        Array.prototype.forEach.call(document.querySelectorAll('[data-revoke]'), function(btn) {
            btn.addEventListener('click', function() {
                if (!window.confirm('Revoke this link? Workpeg will stop working on it straight away.')) return;
                K().api('/api/integration-tokens/' + encodeURIComponent(btn.getAttribute('data-revoke')) + '/revoke', { method: 'POST' })
                    .then(function() { K().toast('Link revoked', 'success'); workpegPage(true); })
                    .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not revoke the link.'), 'danger'); });
            });
        });

        Array.prototype.forEach.call(document.querySelectorAll('[data-rotate]'), function(btn) {
            btn.addEventListener('click', function() {
                if (!window.confirm('Rotate this link? The current link stops working at once and a new one is issued.')) return;
                K().api('/api/integration-tokens/' + encodeURIComponent(btn.getAttribute('data-rotate')) + '/rotate', { method: 'POST', body: {} })
                    .then(function(res) { K().toast('Link rotated', 'success'); issued(res.token, 'Your rotated Workpeg link'); })
                    .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not rotate the link.'), 'danger'); });
            });
        });

        Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function(btn) {
            btn.addEventListener('click', function() {
                var errorNode = document.getElementById('wp-approve-error');
                errorNode.hidden = true;
                K().api('/api/integration-tokens/confirmations/' + encodeURIComponent(btn.getAttribute('data-approve')) + '/approve', { method: 'POST', body: {} })
                    .then(function() { K().toast('Approved', 'success'); workpegPage(true); })
                    .catch(function(error) { errorBox(errorNode, error, 'Could not approve this request.'); });
            });
        });
    }
})();
