// My work: a worker's submissions in one place, grouped by where they stand. Revisions show the
// reviewer's notes beside a resubmit form, and a proposed deadline can be accepted or declined.
// Backed by GET /api/submissions/mine, POST /api/submissions/:id/resubmit, and the deadline
// endpoints. "In progress" is not shown: the server has no status for work that is underway.
// Loaded after core.js and before bounty.js. Uses window.BountyKit for shared helpers.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function api(path, opts) { return K().api(path, opts); }

    var TABS = [
        { key: 'submitted', label: 'Submitted', statuses: ['pending'], empty: 'Nothing waiting for review. Work you send to a bounty appears here until the business decides.' },
        { key: 'revisions', label: 'Revisions', statuses: ['revision_requested'], empty: 'No changes requested. If a business asks for a revision, it appears here with their notes.' },
        { key: 'approved', label: 'Approved', statuses: ['approved'], empty: 'No approved work yet.' },
        { key: 'rejected', label: 'Rejected', statuses: ['rejected'], empty: 'No rejected work.' }
    ];
    var tab = 'submitted';
    var cache = null;

    function loading() {
        app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> Loading your work…</div></div></section>';
    }

    function fail(error) {
        app().innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h2>Unable to load your work</h2><p>' +
            esc(K().friendlyApiError(error, 'Please try again in a moment.')) +
            '</p><button class="btn" type="button" id="work-retry">Try again</button></div></div></section>';
        document.getElementById('work-retry').addEventListener('click', load);
    }

    function countFor(list, t) {
        return list.filter(function(s) { return t.statuses.indexOf(s.status) !== -1; }).length;
    }

    function tabsHTML(list) {
        return '<div class="tabs" role="tablist" aria-label="Your work by status">' + TABS.map(function(t) {
            var selected = t.key === tab;
            return '<button class="tab" role="tab" type="button" id="work-tab-' + t.key + '" aria-selected="' + selected + '" aria-controls="work-panel" data-tab="' + t.key + '">' +
                esc(t.label) + ' <span class="muted">' + countFor(list, t) + '</span></button>';
        }).join('') + '</div>';
    }

    function statusPill(status) {
        var label = K().titleCase(String(status || '').replace(/_/g, ' '));
        return '<span class="status-pill status-' + K().statusClass(status) + '">' + esc(label) + '</span>';
    }

    function revisionForm(s) {
        return '<form class="form stack-sm work-resubmit" data-id="' + esc(s.id) + '" novalidate>' +
            '<div class="notice warning"><div><strong>The reviewer asked for changes.</strong><p style="margin:4px 0 0">' + esc(s.revision_notes || 'No notes were given.') + '</p></div></div>' +
            '<div class="field"><label for="rs-title-' + esc(s.id) + '">Title</label><input id="rs-title-' + esc(s.id) + '" name="title" required minlength="3" maxlength="200" value="' + esc(s.title) + '"></div>' +
            '<div class="field"><label for="rs-desc-' + esc(s.id) + '">How your work meets the requirements</label><textarea id="rs-desc-' + esc(s.id) + '" name="description" required minlength="30" maxlength="2000" rows="5">' + esc(s.description) + '</textarea></div>' +
            '<div class="field"><label for="rs-link-' + esc(s.id) + '">Link to your work</label><input id="rs-link-' + esc(s.id) + '" name="github_link" type="url" maxlength="255" value="' + esc(s.github_link || '') + '"></div>' +
            '<div class="field"><label for="rs-notes-' + esc(s.id) + '">Notes for the reviewer (optional)</label><textarea id="rs-notes-' + esc(s.id) + '" name="notes_to_reviewer" maxlength="1000" rows="2"></textarea></div>' +
            '<div class="form-error" hidden role="alert"></div>' +
            '<div class="row-sm" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Send revised work</button></div>' +
            '</form>';
    }

    function deadlineHTML(s) {
        if (!s.proposed_deadline) return '';
        return '<div class="notice" style="margin-top:12px">The business proposed a new deadline: <strong>' + esc(K().dateText(s.proposed_deadline)) + '</strong>. ' +
            '<div class="row-sm" style="margin-top:8px"><button class="btn btn-sm btn-primary" type="button" data-deadline="accept" data-id="' + esc(s.id) + '">Accept deadline</button>' +
            '<button class="btn btn-sm" type="button" data-deadline="decline" data-id="' + esc(s.id) + '">Decline</button></div></div>';
    }

    function cardHTML(s) {
        var parts = '<article class="panel stack-sm work-card">' +
            '<div class="row-sm" style="justify-content:space-between;flex-wrap:wrap">' +
              '<div><p class="small muted" style="margin:0">' + esc(s.bounty_title || 'Bounty') + '</p>' +
              '<h2 style="margin:2px 0 0">' + esc(s.title) + '</h2></div>' + statusPill(s.status) + '</div>' +
            '<p class="small muted" style="margin:0">Sent ' + esc(K().dateText(s.submitted_at)) + '</p>';
        if (s.status === 'revision_requested') {
            parts += revisionForm(s) + deadlineHTML(s);
        } else if (s.status === 'rejected' && s.rejection_reason) {
            parts += '<div class="notice">' + esc(s.rejection_reason) + '</div>';
        }
        parts += '<div><a class="inline-link" href="#/bounties/' + esc(s.bounty_id) + '">View bounty</a></div></article>';
        return parts;
    }

    function panelHTML(list) {
        var t = TABS.filter(function(x) { return x.key === tab; })[0];
        var items = list.filter(function(s) { return t.statuses.indexOf(s.status) !== -1; });
        if (items.length === 0) {
            return '<div class="empty-state"><h2>' + esc(t.label) + '</h2><p>' + esc(t.empty) + '</p>' +
                '<a class="btn btn-primary" href="#/bounties">Browse bounties</a></div>';
        }
        return items.map(cardHTML).join('');
    }

    function paint() {
        var list = cache || [];
        app().innerHTML = '<section class="page"><div class="container stack-lg">' +
            '<header><p class="eyebrow"><span class="eyebrow-dot"></span> Your work</p>' +
            '<h1 style="font-family:var(--font-display);font-size:var(--text-h1);margin:0">My work</h1>' +
            '<p class="muted" style="margin:6px 0 0">Everything you have sent, by where it stands.</p></header>' +
            tabsHTML(list) +
            '<div id="work-panel" role="tabpanel" aria-labelledby="work-tab-' + tab + '" class="stack-md">' + panelHTML(list) + '</div>' +
            '</div></section>';
        wire();
    }

    function wire() {
        Array.prototype.forEach.call(app().querySelectorAll('[data-tab]'), function(btn) {
            btn.addEventListener('click', function() { tab = btn.getAttribute('data-tab'); paint(); });
        });
        Array.prototype.forEach.call(app().querySelectorAll('.work-resubmit'), function(form) {
            form.addEventListener('submit', function(event) { event.preventDefault(); resubmit(form); });
        });
        Array.prototype.forEach.call(app().querySelectorAll('[data-deadline]'), function(btn) {
            btn.addEventListener('click', function() { answerDeadline(btn); });
        });
    }

    function resubmit(form) {
        var error = form.querySelector('.form-error');
        var submit = form.querySelector('button[type="submit"]');
        error.hidden = true;
        var id = form.getAttribute('data-id');
        var body = {
            title: form.elements.title.value.trim(),
            description: form.elements.description.value.trim(),
            github_link: form.elements.github_link.value.trim() || null,
            notes_to_reviewer: form.elements.notes_to_reviewer.value.trim() || null
        };
        if (body.title.length < 3) return showError(error, 'Add a title of at least 3 characters.');
        if (body.description.length < 30) return showError(error, 'Explain how your work meets the requirements in at least 30 characters.');
        submit.disabled = true;
        submit.textContent = 'Sending…';
        api('/api/submissions/' + encodeURIComponent(id) + '/resubmit', { method: 'POST', body: body })
            .then(function() {
                K().toast('Your revised work was sent.', 'success');
                tab = 'submitted';
                return load();
            })
            .catch(function(e) {
                submit.disabled = false;
                submit.textContent = 'Send revised work';
                showError(error, K().friendlyApiError(e, 'Could not send your revised work.'));
            });
    }

    function answerDeadline(btn) {
        var accept = btn.getAttribute('data-deadline') === 'accept';
        var id = btn.getAttribute('data-id');
        btn.disabled = true;
        api('/api/submissions/' + encodeURIComponent(id) + (accept ? '/accept-deadline' : '/decline-deadline'), { method: 'POST' })
            .then(function() {
                K().toast(accept ? 'New deadline accepted.' : 'Deadline proposal declined.', 'success');
                return load();
            })
            .catch(function(e) {
                btn.disabled = false;
                K().toast(K().friendlyApiError(e, 'Could not update the deadline.'), 'error');
            });
    }

    function showError(node, message) {
        node.textContent = message;
        node.hidden = false;
    }

    function load() {
        loading();
        return api('/api/submissions/mine')
            .then(function(list) {
                cache = Array.isArray(list) ? list : [];
                paint();
            })
            .catch(fail);
    }

    F.routes.push({
        match: function(r) { return r === 'work'; },
        render: function() {
            if (!K().isAuthenticated()) { K().go('auth/login'); return; }
            if (K().getRole() !== 'worker') {
                app().innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h2>Not available for this account</h2><p>My work is for worker accounts.</p></div></div></section>';
                return;
            }
            load();
        }
    });
})();
