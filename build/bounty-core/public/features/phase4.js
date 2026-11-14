// Phase 4 screens: a business's private talent pool (lists, notes, invitations), worker invitations
// with consent, global opportunities with honest regional information, and task region limits.
// Loaded after core.js and before bounty.js. Uses window.BountyKit for shared helpers.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function when(v) { return v ? K().dateText(v) : '—'; }
    function me() { return K().state.user || {}; }
    function errorBox(node, error, fallback) { node.textContent = K().friendlyApiError(error, fallback); node.hidden = false; }
    function loading(label) {
        app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> ' + esc(label) + '</div></div></section>';
    }
    function fail(error, fallback) {
        app().innerHTML = '<section class="page"><div class="container"><div class="notice warning">' + esc(K().friendlyApiError(error, fallback)) + '</div></div></section>';
    }
    function need(role) {
        if (!K().isAuthenticated()) { K().go('auth/login'); return false; }
        if (role && K().getRole() !== role) {
            app().innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h3>Not available for this account</h3><p>This page is for ' + esc(role) + ' accounts.</p></div></div></section>';
            return false;
        }
        return true;
    }
    var INVITE_STATUS = { pending: ['Pending', 'check-possible'], accepted: ['Accepted', 'check-pass'], declined: ['Declined', 'check-fail'], withdrawn: ['Withdrawn', 'check-fail'], expired: ['Expired', 'check-fail'] };

    F.routes.push({
        match: function(r) { return r === 'talent' || r === 'talent/sent' || r.indexOf('talent/') === 0 || r === 'invitations' || r === 'opportunities'; },
        render: function(route) {
            if (route === 'talent' || route === 'talent/sent') return talentPage();
            if (route === 'invitations') return invitationsPage();
            if (route === 'opportunities') return opportunitiesPage();
            return listPage(route.slice('talent/'.length));
        }
    });

    /* ================================================================ talent pool (business) */
    function talentPage() {
        if (!need('business')) return;
        loading('Loading your talent pool…');
        Promise.all([K().api('/api/talent/lists'), K().api('/api/talent/invitations')]).then(function(res) {
            var lists = res[0] || [];
            var invites = res[1] || [];
            var listHtml = lists.length ? '<ul class="list-plain">' + lists.map(function(l) {
                return '<li class="card-row"><a href="#/talent/' + esc(l.id) + '"><strong>' + esc(l.name) + '</strong></a> <span class="small muted">' + esc(l.member_count) + ' saved</span></li>';
            }).join('') + '</ul>' : '<p class="muted">No lists yet. Create one to keep track of workers you would like to work with again.</p>';
            var inviteHtml = invites.length ? '<ul class="list-plain">' + invites.map(function(i) {
                var st = INVITE_STATUS[i.status] || [i.status, 'check-possible'];
                return '<li class="card-row"><strong>' + esc(i.worker_name) + '</strong> <span class="small muted">' + esc(i.task_title || 'General invitation') + ' · sent ' + esc(when(i.created_at)) + '</span> ' +
                    '<span class="check-pill ' + st[1] + '">' + esc(st[0]) + '</span>' +
                    (i.status === 'pending' ? ' <button class="btn btn-sm" type="button" data-withdraw="' + esc(i.id) + '">Withdraw</button>' : '') + '</li>';
            }).join('') + '</ul>' : '<p class="muted">No invitations sent.</p>';
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<div class="page-head"><div><p class="eyebrow">Private to your business</p><h1>Talent pool</h1></div></div>' +
                '<p class="muted">Save workers you would like to work with again and keep private notes about them. You can save a worker who has opted in to being found, or who has worked with you. Invitations only take effect when the worker accepts them, and accepting does not assign work or a payment.</p>' +
                '<section class="detail-section"><h2>Your lists</h2>' + listHtml +
                '<form id="list-create" class="form-card form"><div class="field"><label for="list-name">New list name</label><input id="list-name" maxlength="80" required placeholder="For example, Checkout specialists"></div>' +
                '<div class="form-error" id="list-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Create list</button></div></form></section>' +
                '<section class="detail-section"><h2>Invitations you have sent</h2>' + inviteHtml + '</section>' +
                '</div></section>';
            app().querySelector('#list-create').addEventListener('submit', function(event) {
                event.preventDefault();
                var box = app().querySelector('#list-error');
                box.hidden = true;
                K().api('/api/talent/lists', { method: 'POST', body: { name: app().querySelector('#list-name').value.trim() } })
                    .then(function() { K().toast('List created', 'success'); talentPage(); })
                    .catch(function(error) { errorBox(box, error, 'Could not create the list.'); });
            });
            app().onclick = function(event) {
                var w = event.target.closest('[data-withdraw]');
                if (!w) return;
                K().api('/api/talent/invitations/' + encodeURIComponent(w.getAttribute('data-withdraw')) + '/withdraw', { method: 'POST' })
                    .then(function() { K().toast('Invitation withdrawn', 'success'); talentPage(); })
                    .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not withdraw this invitation.'), 'error'); });
            };
        }).catch(function(error) { fail(error, 'Could not load the talent pool.'); });
    }

    function listPage(id) {
        if (!need('business')) return;
        loading('Loading the list…');
        K().api('/api/talent/lists/' + encodeURIComponent(id)).then(function(list) {
            var rows = list.members.map(function(m) {
                return '<tr><td><a class="inline-link" href="#/worker/' + esc(m.worker_id) + '">' + esc(m.name) + '</a><div class="small muted">' + esc((m.categories || []).join(', ') || 'No categories') + '</div></td>' +
                    '<td>' + esc(m.verified_count) + ' verified</td>' +
                    '<td>' + (m.discoverable ? '<span class="check-pill check-pass">Open to invitations</span>' : '<span class="check-pill check-fail">Not open to invitations</span>') + '</td>' +
                    '<td>' + esc(m.notes_count) + ' note(s)</td>' +
                    '<td><button class="btn btn-sm" type="button" data-invite="' + esc(m.worker_id) + '" data-name="' + esc(m.name) + '">Invite</button> ' +
                    '<button class="btn btn-sm" type="button" data-remove="' + esc(m.worker_id) + '">Remove</button></td></tr>';
            }).join('');
            app().innerHTML = '<section class="page"><div class="container">' +
                '<a class="back-link" href="#/talent">← Talent pool</a>' +
                '<div class="page-head"><div><p class="eyebrow">Talent list</p><h1>' + esc(list.name) + '</h1></div>' +
                '<div class="page-actions"><button class="btn btn-sm" type="button" id="list-delete">Delete list</button></div></div>' +
                (list.members.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Worker</th><th>Verified checks</th><th>Invitations</th><th>Notes</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
                    '<div class="empty-state"><h3>No one saved yet</h3><p>Open a worker\'s profile and choose Save to this list.</p></div>') +
                '<div id="invite-slot"></div><div class="form-error" id="list-page-error" hidden role="alert"></div></div></section>';

            app().onclick = function(event) {
                var inv = event.target.closest('[data-invite]');
                if (inv) { openInvite(inv.getAttribute('data-invite'), inv.getAttribute('data-name')); return; }
                var rm = event.target.closest('[data-remove]');
                if (rm) {
                    K().api('/api/talent/lists/' + encodeURIComponent(id) + '/members/' + encodeURIComponent(rm.getAttribute('data-remove')), { method: 'DELETE' })
                        .then(function() { K().toast('Removed from this list', 'success'); listPage(id); })
                        .catch(function(error) { errorBox(app().querySelector('#list-page-error'), error, 'Could not remove this worker.'); });
                    return;
                }
                if (event.target.closest('#list-delete')) {
                    if (!window.confirm('Delete this list? Saved workers are removed from the list only. Your notes are kept.')) return;
                    K().api('/api/talent/lists/' + encodeURIComponent(id), { method: 'DELETE' })
                        .then(function() { K().toast('List deleted', 'success'); K().go('talent'); })
                        .catch(function(error) { errorBox(app().querySelector('#list-page-error'), error, 'Could not delete this list.'); });
                }
            };
        }).catch(function(error) { fail(error, 'Could not load this list.'); });
    }

    function openInvite(workerId, name) {
        var slot = app().querySelector('#invite-slot');
        slot.innerHTML = '<form id="invite-form" class="form-card form"><h2 class="h4">Invite ' + esc(name) + '</h2>' +
            '<p class="small muted">An invitation only takes effect if they accept. It does not assign work or a payment.</p>' +
            '<div class="field"><label for="inv-task">Task (optional)</label><select id="inv-task"><option value="">A general invitation</option></select></div>' +
            '<div class="field"><label for="inv-message">Message</label><textarea id="inv-message" rows="3" minlength="10" maxlength="500" required placeholder="Explain why you think this would suit them"></textarea></div>' +
            '<div class="form-error" id="inv-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Send invitation</button></div></form>';
        K().api('/api/talent/open-tasks').then(function(tasks) {
            var select = slot.querySelector('#inv-task');
            tasks.forEach(function(t) { select.insertAdjacentHTML('beforeend', '<option value="' + esc(t.id) + '">' + esc(t.title) + '</option>'); });
        }).catch(function() {});
        slot.querySelector('#invite-form').addEventListener('submit', function(event) {
            event.preventDefault();
            var box = slot.querySelector('#inv-error');
            box.hidden = true;
            var body = { worker_id: workerId, message: slot.querySelector('#inv-message').value.trim() };
            var task = slot.querySelector('#inv-task').value;
            if (task) body.bounty_id = task;
            K().api('/api/talent/invitations', { method: 'POST', body: body }).then(function() {
                K().toast('Invitation sent', 'success');
                slot.innerHTML = '';
            }).catch(function(error) { errorBox(box, error, 'Could not send this invitation.'); });
        });
    }

    /* ================================================================ worker profile actions (business) */
    F.mounts.talentActions = function(container, worker) {
        if (!container || K().getRole() !== 'business' || !worker || !worker.id) return;
        var id = worker.id;
        container.innerHTML = '<section class="detail-section" id="talent-actions"><h2>Your talent pool</h2>' +
            '<p class="small muted">Visible only to your business. The worker is not told when you save them or write a note.</p>' +
            '<div class="loading-line"><span class="spinner"></span> Loading…</div></section>';
        Promise.all([K().api('/api/talent/lists'), K().api('/api/talent/workers/' + encodeURIComponent(id) + '/notes')]).then(function(res) {
            var lists = res[0] || [];
            var notes = res[1] || [];
            var saveHtml = lists.length ?
                '<form id="save-form" class="form"><div class="field"><label for="save-list">Save to a list</label><select id="save-list">' +
                lists.map(function(l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'; }).join('') + '</select></div>' +
                '<div class="form-error" id="save-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-sm" type="submit">Save</button></div></form>' :
                '<p class="small">You have no lists yet. <a class="inline-link" href="#/talent">Create one in your talent pool</a>.</p>';
            var noteList = notes.length ? '<ul class="small">' + notes.map(function(n) {
                return '<li>' + esc(n.body) + ' <span class="muted">· ' + esc(when(n.created_at)) + '</span> <button class="btn btn-sm" type="button" data-note-delete="' + esc(n.id) + '">Delete</button></li>';
            }).join('') + '</ul>' : '<p class="small muted">No notes yet.</p>';
            container.innerHTML = '<section class="detail-section" id="talent-actions"><h2>Your talent pool</h2>' +
                '<p class="small muted">Visible only to your business. The worker is not told when you save them or write a note.</p>' +
                saveHtml + '<div class="form-error" id="talent-global-error" hidden role="alert"></div>' +
                '<h3 class="h4">Private notes</h3>' + noteList +
                '<form id="note-form" class="form"><div class="field"><label for="note-body">Add a note</label><textarea id="note-body" rows="2" minlength="3" maxlength="1000" required></textarea></div>' +
                '<div class="form-error" id="note-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-sm" type="submit">Add note</button></div></form>' +
                '<h3 class="h4">Invite to a task</h3>' +
                '<form id="talent-invite" class="form"><div class="field"><label for="ti-task">Task (optional)</label><select id="ti-task"><option value="">A general invitation</option></select></div>' +
                '<div class="field"><label for="ti-message">Message</label><textarea id="ti-message" rows="3" minlength="10" maxlength="500" required></textarea></div>' +
                '<div class="form-error" id="ti-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-sm" type="submit">Send invitation</button></div></form></section>';

            K().api('/api/talent/open-tasks').then(function(tasks) {
                var select = container.querySelector('#ti-task');
                tasks.forEach(function(t) { select.insertAdjacentHTML('beforeend', '<option value="' + esc(t.id) + '">' + esc(t.title) + '</option>'); });
            }).catch(function() {});

            var save = container.querySelector('#save-form');
            if (save) save.addEventListener('submit', function(event) {
                event.preventDefault();
                var box = container.querySelector('#save-error');
                box.hidden = true;
                var listId = container.querySelector('#save-list').value;
                K().api('/api/talent/lists/' + encodeURIComponent(listId) + '/members', { method: 'POST', body: { worker_id: id } })
                    .then(function() { K().toast('Saved to your list', 'success'); })
                    .catch(function(error) { errorBox(box, error, 'Could not save this worker.'); });
            });
            container.querySelector('#note-form').addEventListener('submit', function(event) {
                event.preventDefault();
                var box = container.querySelector('#note-error');
                box.hidden = true;
                K().api('/api/talent/workers/' + encodeURIComponent(id) + '/notes', { method: 'POST', body: { body: container.querySelector('#note-body').value.trim() } })
                    .then(function() { K().toast('Note added', 'success'); F.mounts.talentActions(container, worker); })
                    .catch(function(error) { errorBox(box, error, 'Could not add this note.'); });
            });
            container.querySelector('#talent-invite').addEventListener('submit', function(event) {
                event.preventDefault();
                var box = container.querySelector('#ti-error');
                box.hidden = true;
                var body = { worker_id: id, message: container.querySelector('#ti-message').value.trim() };
                var task = container.querySelector('#ti-task').value;
                if (task) body.bounty_id = task;
                K().api('/api/talent/invitations', { method: 'POST', body: body })
                    .then(function() { K().toast('Invitation sent', 'success'); container.querySelector('#talent-invite').reset(); })
                    .catch(function(error) { errorBox(box, error, 'Could not send this invitation.'); });
            });
            container.onclick = function(event) {
                var del = event.target.closest('[data-note-delete]');
                if (!del) return;
                K().api('/api/talent/notes/' + encodeURIComponent(del.getAttribute('data-note-delete')), { method: 'DELETE' })
                    .then(function() { K().toast('Note deleted', 'success'); F.mounts.talentActions(container, worker); })
                    .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not delete this note.'), 'error'); });
            };
        }).catch(function(error) {
            container.innerHTML = '<section class="detail-section"><h2>Your talent pool</h2><div class="notice warning">' + esc(K().friendlyApiError(error, 'Could not load your talent pool.')) + '</div></section>';
        });
    };

    /* ================================================================ invitations (worker) */
    function invitationsPage() {
        if (!need('worker')) return;
        loading('Loading your invitations…');
        K().api('/api/talent/invitations/mine').then(function(rows) {
            var body = rows.length ? '<ul class="list-plain">' + rows.map(function(i) {
                var st = INVITE_STATUS[i.status] || [i.status, 'check-possible'];
                return '<li class="card-row" data-invitation="' + esc(i.id) + '"><strong>' + esc(i.business_name) + '</strong> <span class="small muted">' + esc(i.task_title || 'General invitation') + '</span> ' +
                    '<span class="check-pill ' + st[1] + '">' + esc(st[0]) + '</span>' +
                    '<p class="small">' + esc(i.message) + '</p>' +
                    (i.status === 'pending' ? '<p class="small muted">Expires ' + esc(when(i.expires_at)) + '</p>' +
                        '<div class="form-actions"><button class="btn btn-primary btn-sm" type="button" data-respond="accept" data-id="' + esc(i.id) + '">Accept</button> ' +
                        '<button class="btn btn-sm" type="button" data-respond="decline" data-id="' + esc(i.id) + '">Decline</button></div>' : '') +
                    '<p class="small" data-result></p></li>';
            }).join('') + '</ul>' : '<div class="empty-state"><h3>No invitations</h3><p>When a business invites you, it appears here. You decide whether to accept.</p></div>';
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<div class="page-head"><div><p class="eyebrow">Your choice</p><h1>Invitations</h1></div></div>' +
                '<p class="muted">Accepting an invitation records your interest. It does not assign you work or a payment. To take part in a task, you still apply through the normal process.</p>' +
                body + '</div></section>';
            app().onclick = function(event) {
                var b = event.target.closest('[data-respond]');
                if (!b) return;
                var card = b.closest('[data-invitation]');
                K().api('/api/talent/invitations/' + encodeURIComponent(b.getAttribute('data-id')) + '/respond', { method: 'POST', body: { decision: b.getAttribute('data-respond') } })
                    .then(function(res) {
                        card.querySelector('[data-result]').textContent = res.next_step;
                        card.querySelectorAll('button').forEach(function(x) { x.disabled = true; });
                        K().toast(res.status === 'accepted' ? 'Invitation accepted' : 'Invitation declined', 'success');
                    })
                    .catch(function(error) { card.querySelector('[data-result]').textContent = K().friendlyApiError(error, 'Could not respond to this invitation.'); });
            };
        }).catch(function(error) { fail(error, 'Could not load your invitations.'); });
    }

    /* ================================================================ opportunities (worker) */
    function opportunitiesPage() {
        if (!need('worker')) return;
        loading('Finding opportunities…');
        Promise.all([K().api('/api/global/opportunities'), K().api('/api/global/regions')]).then(function(res) {
            var data = res[0];
            var info = res[1];
            var el = data.eligibility;
            var regionBox = el.country ?
                '<div class="notice"><strong>' + esc(el.region_name) + '</strong>. Rewards are priced in ' + esc(el.currency) + '. ' + esc(el.message) + '</div>' :
                '<div class="notice">' + esc(el.message) + ' <a class="inline-link" href="#/profile">Update your profile</a>.</div>';
            var currencies = '<ul class="small">' + info.currencies.map(function(c) {
                return '<li><strong>' + esc(c.code) + '</strong> (' + esc(c.name) + '): ' + (c.status === 'supported' ? 'supported' : 'not supported yet') + '. ' + esc(c.note) + '</li>';
            }).join('') + '</ul>';
            var rows = data.results.length ? '<ul class="list-plain">' + data.results.map(function(r) {
                return '<li class="card-row"><a href="#/bounties/' + esc(r.bounty_id) + '"><strong>' + esc(r.title) + '</strong></a> <span class="small muted">' + esc(r.category) + ' · Deadline ' + esc(when(r.deadline)) + '</span>' +
                    '<ul class="small">' + (r.reasons || []).map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></li>';
            }).join('') + '</ul>' : '<div class="empty-state"><h3>No open opportunities for you yet</h3><p>Tasks limited to other regions are not shown to you.</p></div>';
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<div class="page-head"><div><p class="eyebrow">Global access</p><h1>Opportunities</h1></div></div>' +
                '<section class="detail-section"><h2>Your region</h2>' + regionBox + '</section>' +
                '<section class="detail-section"><h2>Currencies</h2><p class="small muted">Each region prices in its own currency. Payouts are not confirmed yet for any currency.</p>' + currencies + '</section>' +
                '<section class="detail-section"><h2>Open tasks for you</h2><p class="small muted">Ranked by languages, time zone overlap, skills and availability. Location is not used. Region limits are applied.</p>' + rows + '</section>' +
                '</div></section>';
        }).catch(function(error) { fail(error, 'Could not load opportunities.'); });
    }

    /* ================================================================ task region limits (business) */
    F.mounts.regionAccess = function(container, bounty) {
        if (!container || !bounty || K().getRole() !== 'business') return;
        var open = String(bounty.status || '').toLowerCase() === 'open';
        container.innerHTML = '<h2>Who can see this task</h2><div class="loading-line"><span class="spinner"></span> Loading…</div>';
        K().api('/api/global/regions').then(function(info) {
            var current = bounty.regions || [];
            var anywhere = current.length === 0;
            container.innerHTML = '<h2>Who can see this task</h2>' +
                '<p class="small muted">Leave everything unticked to show this task everywhere. If you choose regions, only people declaring one of them see it in listings. You and the workers on the task always can.</p>' +
                (open ? '' : '<p class="small">Visibility can only change while the task is open.</p>') +
                '<fieldset class="field"><legend>Regions</legend>' + info.regions.map(function(r) {
                    return '<label class="check-label"><input type="checkbox" value="' + esc(r.code) + '"' + (current.indexOf(r.code) !== -1 ? ' checked' : '') + (open ? '' : ' disabled') + '> ' + esc(r.name) + '</label>';
                }).join('') + '</fieldset>' +
                '<p class="small">' + (anywhere ? 'Currently: everywhere.' : 'Currently: ' + esc(current.join(', ')) + '.') + '</p>' +
                (open ? '<div class="form-error" id="region-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-sm" type="button" id="region-save">Save visibility</button></div>' : '');
            var save = container.querySelector('#region-save');
            if (!save) return;
            save.addEventListener('click', function() {
                var box = container.querySelector('#region-error');
                box.hidden = true;
                var chosen = Array.from(container.querySelectorAll('input[type=checkbox]:checked')).map(function(n) { return n.value; });
                K().api('/api/global/tasks/' + encodeURIComponent(bounty.id) + '/regions', { method: 'PATCH', body: { regions: chosen } })
                    .then(function() { K().toast('Visibility saved', 'success'); bounty.regions = chosen; F.mounts.regionAccess(container, bounty); })
                    .catch(function(error) { errorBox(box, error, 'Could not save visibility.'); });
            });
        }).catch(function() {
            container.innerHTML = '<h2>Who can see this task</h2><p class="small muted">Visibility settings are unavailable right now.</p>';
        });
    };
})();
