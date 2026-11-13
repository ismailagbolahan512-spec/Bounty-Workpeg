// A hidden page for creating and managing integration tokens for the Workpeg peg.
// Not in the navigation. Reach it only by typing #/connections/workpeg in the address bar.
// A business generates a token here, copies it once (plain text appears only in the response),
// and pastes it into the Bounty peg on Workpeg. Backed by /api/integration-tokens.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }

    var SCOPES = [
        { key: 'services:read', label: 'Hospitality services: read my requests, quotes and visits', role: 'business' },
        { key: 'bounties:read', label: 'Bounties: read open tasks', role: 'any' },
        { key: 'workspace:read', label: 'Workspace: read my assignments', role: 'any' },
    ];

    F.routes.push({
        match: function(r) { return r === 'connections/workpeg'; },
        render: function() {
            if (!K().isAuthenticated()) { K().go('auth/login'); return; }
            app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> Loading your connections…</div></div></section>';
            K().api('/api/integration-tokens').then(function(res) {
                renderPage(res.tokens || []);
            }).catch(function(error) {
                app().innerHTML = '<section class="page"><div class="container"><div class="notice warning">' + esc(K().friendlyApiError(error, 'Could not load your tokens.')) + '</div></div></section>';
            });
        }
    });

    function renderPage(tokens) {
        var checkboxes = SCOPES.map(function(s) {
            return '<label class="card-row"><input type="checkbox" value="' + esc(s.key) + '"' + (s.key === 'services:read' ? ' checked' : '') + '> <strong>' + esc(s.key) + '</strong> — ' + esc(s.label) + '</label>';
        }).join('');
        var list = tokens.length === 0
            ? '<p class="small muted">No tokens yet.</p>'
            : '<ul class="list-plain">' + tokens.map(function(t) {
                var scopes = (t.scopes || []).map(function(s) { return '<code>' + esc(s) + '</code>'; }).join(' ');
                return '<li class="card-row"><strong>' + esc(t.label || t.name || '(unnamed)') + '</strong> ' +
                    '<span class="small muted">' + esc(t.prefix || '') + '… · ' + scopes + ' · expires ' + esc(K().dateText(t.expires_at)) + '</span> ' +
                    '<button class="btn btn-sm" data-revoke="' + esc(t.id) + '">Revoke</button></li>';
            }).join('') + '</ul>';

        app().innerHTML =
            '<section class="page"><div class="container">' +
            '<div class="page-head"><div><p class="eyebrow">Connections</p><h1>Workpeg integration</h1>' +
            '<p class="muted">Generate a token to paste into the Bounty peg on Workpeg. The token shows once when it is created — copy it then. It expires after the number of days you choose.</p></div></div>' +
            '<div class="detail-section"><h2>New token</h2>' +
            '<form id="tok-form" class="form-card form">' +
            '<div class="field"><label for="tok-name">A name, for you</label><input id="tok-name" maxlength="120" required placeholder="For example, Workpeg (hotel)"></div>' +
            '<div class="field"><span class="field-label">What this token may do</span>' + checkboxes + '</div>' +
            '<div class="field"><label for="tok-days">Days until it expires</label><input id="tok-days" type="number" min="1" max="90" value="30" required></div>' +
            '<p class="form-error" id="tok-error" hidden></p>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" id="tok-create" type="submit">Create token</button></div>' +
            '<div id="tok-result" hidden class="notice" style="margin-top:12px"></div>' +
            '</form></div>' +
            '<div class="detail-section"><h2>Existing tokens</h2>' + list + '</div>' +
            '</div></section>';

        document.getElementById('tok-form').addEventListener('submit', function(e) {
            e.preventDefault();
            var error = document.getElementById('tok-error');
            var result = document.getElementById('tok-result');
            error.hidden = true; result.hidden = true;
            var scopes = Array.prototype.filter.call(document.querySelectorAll('[value]:checked'), function(el) { return el.type === 'checkbox'; }).map(function(el) { return el.value; });
            if (scopes.length === 0) { error.textContent = 'Tick at least one scope.'; error.hidden = false; return; }
            var btn = document.getElementById('tok-create');
            btn.disabled = true;
            K().api('/api/integration-tokens', { method: 'POST', body: {
                label: document.getElementById('tok-name').value,
                scopes: scopes,
                days: Number(document.getElementById('tok-days').value)
            } }).then(function(res) {
                var tok = res.token || '';
                // The token is shown ONCE. No auto-reload — the user tells us when they are done.
                result.innerHTML = '<p><strong>Your token (copy it now — it is not shown again)</strong></p>' +
                    '<p id="tok-value" style="font-family:monospace;word-break:break-all;background:var(--surface);padding:10px 12px;border-radius:8px;border:1px solid var(--line);margin:8px 0">' + esc(tok) + '</p>' +
                    '<div class="form-actions">' +
                      '<button type="button" class="btn btn-sm btn-primary" id="tok-copy">Copy token</button>' +
                      '<button type="button" class="btn btn-sm" id="tok-done">Done</button>' +
                      '<span class="small muted" id="tok-copy-msg" style="margin-left:8px"></span>' +
                    '</div>' +
                    '<p class="small muted" style="margin-top:8px">Paste this into the Bounty peg on Workpeg to connect.</p>';
                result.hidden = false;
                btn.disabled = false;
                document.getElementById('tok-name').value = '';
                document.getElementById('tok-copy').addEventListener('click', function() {
                    var msg = document.getElementById('tok-copy-msg');
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(tok).then(function() {
                            msg.textContent = 'Copied.';
                        }).catch(function() {
                            // Fallback: select the text for the user.
                            var range = document.createRange();
                            range.selectNodeContents(document.getElementById('tok-value'));
                            var sel = window.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(range);
                            msg.textContent = 'Press Ctrl+C to copy.';
                        });
                    } else {
                        var range = document.createRange();
                        range.selectNodeContents(document.getElementById('tok-value'));
                        var sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                        msg.textContent = 'Press Ctrl+C to copy.';
                    }
                });
                document.getElementById('tok-done').addEventListener('click', function() {
                    K().go('connections/workpeg');
                });
            }).catch(function(error2) {
                error.textContent = K().friendlyApiError(error2, 'Could not create the token.');
                error.hidden = false;
                btn.disabled = false;
            });
        });

        Array.prototype.forEach.call(document.querySelectorAll('[data-revoke]'), function(b) {
            b.addEventListener('click', function() {
                if (!window.confirm('Revoke this token? Any peg using it will stop working.')) return;
                b.disabled = true;
                K().api('/api/integration-tokens/' + encodeURIComponent(b.getAttribute('data-revoke')) + '/revoke', { method: 'POST', body: {} })
                    .then(function() { K().toast('Revoked', 'success'); K().go('connections/workpeg'); })
                    .catch(function(error) { b.disabled = false; K().toast(K().friendlyApiError(error, 'Could not revoke.'), 'danger'); });
            });
        });
    }
})();
