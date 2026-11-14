// Workpeg settings for business accounts: approvals waiting for you, connecting the Bounty peg,
// and the tokens already issued (rotate or revoke). Workers never see this page; Workpeg connects
// to the business side only. Backed by /api/integration-tokens.
//
// Rules this screen keeps
//   * A token is shown once, at creation or rotation. It is never fetched again.
//   * Sensitive actions from Workpeg wait here for approval. Each approval covers one exact action
//     and expires after a few minutes, so approving never grants open-ended access.
//   * Revoking takes effect at once and asks first, in the page, not in a browser dialog.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function api(path, opts) { return K().api(path, opts); }

    // Scopes a business can grant to the peg. services:read is business-only; the other two are
    // readable by any signed-in account, so they stay on this business-only page for now.
    var SCOPES = [
        { key: 'services:read', label: 'Read your hospitality requests, quotes and visits' },
        { key: 'bounties:read', label: 'Read open bounties' },
        { key: 'workspace:read', label: 'Read your assignments' }
    ];

    // Sensitive actions the peg can ask to perform. Shown in plain words for the approval list.
    var ACTION_LABEL = {
        'bounties:publish': 'Publish a bounty',
        'applications:write': 'Apply to a bounty',
        'submissions:write': 'Submit work',
        'appointments:write': 'Change an appointment'
    };

    var revealed = null; // { token, label } for the one-time panel; cleared on navigation.

    F.routes.push({
        match: function(r) { return r === 'connections/workpeg'; },
        render: function() {
            // Entering the page from elsewhere drops any token still on screen: it is shown once.
            revealed = null;
            if (!K().isAuthenticated()) { K().go('auth/login'); return; }
            if (K().getRole() !== 'business') {
                app().innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h3>Not available for this account</h3><p>Workpeg connects to business accounts only.</p></div></div></section>';
                return;
            }
            load();
        }
    });

    function loading() {
        app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> Loading your Workpeg settings…</div></div></section>';
    }

    function load() {
        loading();
        Promise.all([
            api('/api/integration-tokens'),
            api('/api/integration-tokens/confirmations').catch(function() { return { confirmations: [] }; })
        ]).then(function(parts) {
            paint(parts[0].tokens || [], parts[1].confirmations || []);
        }).catch(function(error) {
            app().innerHTML = '<section class="page"><div class="container"><div class="notice warning">' +
                esc(K().friendlyApiError(error, 'Could not load your Workpeg settings.')) + '</div></div></section>';
        });
    }

    function isActive(t) {
        return !t.revoked_at && new Date(t.expires_at).getTime() > Date.now();
    }

    function statusOf(t) {
        if (t.revoked_at) return ['Revoked', 'status-rejected'];
        if (new Date(t.expires_at).getTime() <= Date.now()) return ['Expired', 'status-closed'];
        return ['Active', 'status-approved'];
    }

    function minutesLeft(when) {
        var ms = new Date(when).getTime() - Date.now();
        if (ms <= 0) return 'expired';
        var m = Math.ceil(ms / 60000);
        return m + (m === 1 ? ' minute' : ' minutes') + ' left';
    }

    function approvalsHTML(list) {
        if (list.length === 0) {
            return '<p class="muted">Nothing is waiting. When Workpeg asks to do something sensitive, it appears here for you to approve.</p>';
        }
        return list.map(function(c) {
            return '<article class="panel stack-sm" data-confirmation="' + esc(c.id) + '">' +
                '<div class="row-sm" style="justify-content:space-between;flex-wrap:wrap">' +
                  '<div><h3 style="margin:0">' + esc(ACTION_LABEL[c.action] || c.action) + '</h3>' +
                  '<p class="small muted" style="margin:2px 0 0">From ' + esc(c.token_label || 'Workpeg') + ' · ' + esc(minutesLeft(c.expires_at)) + '</p></div>' +
                  '<button class="btn btn-primary btn-sm" type="button" data-approve="' + esc(c.id) + '">Approve this action</button>' +
                '</div>' +
                '<p class="small muted" style="margin:0">Approval covers this one action only, and expires in a few minutes.</p>' +
                '</article>';
        }).join('');
    }

    function revealHTML() {
        if (!revealed) return '';
        return '<div class="notice" id="reveal-panel" role="status" style="margin-bottom:16px">' +
            '<p style="margin:0 0 8px"><strong>Your token. Copy it now. It is not shown again.</strong></p>' +
            '<p id="reveal-value" style="font-family:var(--font-mono, monospace);word-break:break-all;margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid var(--border-default, #444)">' + esc(revealed.token) + '</p>' +
            '<div class="row-sm"><button class="btn btn-sm btn-primary" type="button" data-copy>Copy token</button>' +
            '<button class="btn btn-sm" type="button" data-dismiss-reveal>I have copied it</button>' +
            '<span class="small muted" id="copy-msg"></span></div>' +
            '<p class="small muted" style="margin:8px 0 0">Paste it into the Bounty peg on Workpeg to connect.</p></div>';
    }

    function tokenRowHTML(t) {
        var st = statusOf(t);
        var scopes = (t.scopes || []).map(function(s) {
            var found = SCOPES.filter(function(x) { return x.key === s; })[0];
            return found ? found.label : s;
        });
        var actions = isActive(t)
            ? '<button class="btn btn-sm" type="button" data-rotate="' + esc(t.id) + '">Replace token</button> ' +
              '<button class="btn btn-sm" type="button" data-revoke="' + esc(t.id) + '">Revoke</button>'
            : '';
        return '<article class="panel stack-sm" data-token="' + esc(t.id) + '">' +
            '<div class="row-sm" style="justify-content:space-between;flex-wrap:wrap">' +
              '<h3 style="margin:0">' + esc(t.label || 'Workpeg token') + '</h3>' +
              '<span class="status-pill ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
            '<ul class="small muted" style="margin:0;padding-left:18px">' + scopes.map(function(s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
            '<p class="small muted" style="margin:0">Issued ' + esc(K().dateText(t.issued_at)) +
              ' · ' + (t.last_used_at ? 'last used ' + esc(K().dateText(t.last_used_at)) : 'not used yet') +
              (t.revoked_at ? ' · revoked' : ' · expires ' + esc(K().dateText(t.expires_at))) + '</p>' +
            (actions ? '<div class="row-sm" data-token-actions>' + actions + '</div>' : '') +
            '</article>';
    }

    function paint(tokens, confirmations) {
        var active = tokens.filter(isActive);
        var checks = SCOPES.map(function(s) {
            return '<label class="row-sm" style="align-items:flex-start;gap:10px;cursor:pointer"><input type="checkbox" value="' + esc(s.key) + '" style="width:16px;height:16px;min-height:0;padding:0;margin:3px 0 0;flex:0 0 auto"' + (s.key === 'services:read' ? ' checked' : '') + '><span>' + esc(s.label) + '</span></label>';
        }).join('');

        app().innerHTML =
            '<section class="page"><div class="container stack-lg">' +
            '<header><p class="eyebrow"><span class="eyebrow-dot"></span> Workpeg</p>' +
            '<h1 style="font-family:var(--font-display);font-size:var(--text-h1);margin:0">Workpeg settings</h1>' +
            '<p class="muted" style="margin:6px 0 0">Connect the Bounty peg on Workpeg to your business. You choose what it can read, approve anything sensitive, and revoke at any time.</p>' +
            '<p class="small muted" style="margin:8px 0 0">' + active.length + ' active ' + (active.length === 1 ? 'connection' : 'connections') +
            ' · ' + confirmations.length + ' waiting for approval</p></header>' +

            '<section class="stack-sm"><h2>Approvals waiting for you</h2>' + approvalsHTML(confirmations) + '</section>' +

            '<section class="stack-sm"><h2>Connect a new token</h2>' +
            '<form id="tok-form" class="panel stack-md" novalidate>' +
            '<div class="field"><label for="tok-name">A name, for you</label><input id="tok-name" maxlength="100" required placeholder="For example, Workpeg (hotel)"></div>' +
            '<div class="field"><span class="field-label">What the peg may read</span>' + checks + '</div>' +
            '<div class="field"><label for="tok-days">Days until it expires (1 to 90)</label><input id="tok-days" type="number" min="1" max="90" value="30" required></div>' +
            '<p class="form-error" id="tok-error" hidden role="alert"></p>' +
            '<div class="row-sm" style="justify-content:flex-end"><button class="btn btn-primary" id="tok-create" type="submit">Create token</button></div>' +
            '</form></section>' +

            '<section class="stack-sm" id="reveal-slot">' + revealHTML() + '</section>' +

            '<section class="stack-sm"><h2>Your tokens</h2>' +
            (tokens.length ? tokens.map(tokenRowHTML).join('') : '<p class="muted">No tokens yet.</p>') +
            '</section>' +
            '</div></section>';

        wire();
    }

    function wire() {
        var form = document.getElementById('tok-form');
        if (form) form.addEventListener('submit', create);

        var reveal = document.getElementById('reveal-panel');
        if (reveal) {
            var copy = reveal.querySelector('[data-copy]');
            if (copy) copy.addEventListener('click', copyToken);
            var dismiss = reveal.querySelector('[data-dismiss-reveal]');
            if (dismiss) dismiss.addEventListener('click', function() { revealed = null; load(); });
        }

        Array.prototype.forEach.call(app().querySelectorAll('[data-approve]'), function(btn) {
            btn.addEventListener('click', function() { approve(btn); });
        });
        Array.prototype.forEach.call(app().querySelectorAll('[data-rotate]'), function(btn) {
            btn.addEventListener('click', function() { rotate(btn); });
        });
        Array.prototype.forEach.call(app().querySelectorAll('[data-revoke]'), function(btn) {
            btn.addEventListener('click', function() { askRevoke(btn); });
        });
    }

    function showError(node, message) {
        node.textContent = message;
        node.hidden = false;
    }

    function create(event) {
        event.preventDefault();
        var error = document.getElementById('tok-error');
        error.hidden = true;
        var scopes = Array.prototype.filter.call(
            document.querySelectorAll('#tok-form input[type="checkbox"]'), function(el) { return el.checked; }
        ).map(function(el) { return el.value; });
        var label = document.getElementById('tok-name').value.trim();
        var days = Number(document.getElementById('tok-days').value);
        if (!label) return showError(error, 'Give the token a name, so you can recognise it later.');
        if (scopes.length === 0) return showError(error, 'Tick at least one thing the peg may read.');
        if (!(days >= 1 && days <= 90)) return showError(error, 'Choose between 1 and 90 days.');
        var button = document.getElementById('tok-create');
        button.disabled = true;
        api('/api/integration-tokens', { method: 'POST', body: { label: label, scopes: scopes, days: days } })
            .then(function(res) {
                revealed = { token: res.token || '', label: label };
                K().toast('Token created. Copy it now.', 'success');
                load();
            })
            .catch(function(e) {
                button.disabled = false;
                showError(error, K().friendlyApiError(e, 'Could not create the token.'));
            });
    }

    function rotate(btn) {
        var id = btn.getAttribute('data-rotate');
        btn.disabled = true;
        api('/api/integration-tokens/' + encodeURIComponent(id) + '/rotate', { method: 'POST', body: {} })
            .then(function(res) {
                revealed = { token: res.token || '', label: 'Replacement token' };
                K().toast('Replaced. The old token stopped working.', 'success');
                load();
            })
            .catch(function(e) {
                btn.disabled = false;
                K().toast(K().friendlyApiError(e, 'Could not replace the token.'), 'error');
            });
    }

    // Revoking asks in place: the row shows Confirm and Cancel, nothing blocks the page.
    function askRevoke(btn) {
        var row = btn.parentNode;
        var id = btn.getAttribute('data-revoke');
        row.innerHTML = '<p class="small" style="margin:0;width:100%">Revoke this token? Any peg using it stops working straight away.</p>' +
            '<button class="btn btn-sm btn-primary" type="button" data-confirm-revoke="' + esc(id) + '">Revoke token</button> ' +
            '<button class="btn btn-sm" type="button" data-cancel-revoke>Cancel</button>';
        row.querySelector('[data-cancel-revoke]').addEventListener('click', load);
        row.querySelector('[data-confirm-revoke]').addEventListener('click', function(event) {
            var target = event.currentTarget;
            target.disabled = true;
            api('/api/integration-tokens/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: {} })
                .then(function() { K().toast('Token revoked.', 'success'); load(); })
                .catch(function(e) {
                    target.disabled = false;
                    K().toast(K().friendlyApiError(e, 'Could not revoke the token.'), 'error');
                });
        });
    }

    function approve(btn) {
        var id = btn.getAttribute('data-approve');
        btn.disabled = true;
        api('/api/integration-tokens/confirmations/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} })
            .then(function() {
                K().toast('Approved. Workpeg can complete that one action now.', 'success');
                load();
            })
            .catch(function(e) {
                btn.disabled = false;
                K().toast(K().friendlyApiError(e, 'Could not approve this action.'), 'error');
                load();
            });
    }

    // Copy the revealed token. The clipboard API may be refused, so fall back to selecting the text.
    function copyToken() {
        var msg = document.getElementById('copy-msg');
        var value = document.getElementById('reveal-value');
        function select() {
            var range = document.createRange();
            range.selectNodeContents(value);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            msg.textContent = 'Press Ctrl+C to copy.';
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(revealed.token)
                .then(function() { msg.textContent = 'Copied.'; })
                .catch(select);
        } else {
            select();
        }
    }
})();
