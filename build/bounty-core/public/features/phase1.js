// Phase 1 screens: verification reports, milestone-based projects, proof-of-work reputation.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function money(v) { return 'NGN ' + Number(v || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function when(v) { return v ? K().dateText(v) : 'No deadline'; }
    function toIso(value) { return value ? new Date(value).toISOString() : null; }

    /* ---------- verification report ---------- */
    var OUTCOMES = {
        pass: { label: 'Checks passed', css: 'check-pass' },
        fail: { label: 'Checks failed', css: 'check-fail' },
        needs_review: { label: 'Needs your review', css: 'check-possible' }
    };
    var CHECK_LABELS = {
        confirmed_fail: ['Not met', 'check-fail'],
        possible_issue: ['Possible issue', 'check-possible'],
        passed: ['Met', 'check-pass'],
        not_checked: ['Not checked', 'check-not-checked']
    };

    F.mounts.verificationReport = function(container, r) {
        var outcome = OUTCOMES[r.outcome] || OUTCOMES.needs_review;
        var items = (r.checks || []).map(function(c, i) {
            var status = CHECK_LABELS[c.status] || CHECK_LABELS.not_checked;
            return '<li class="rubric-item"><span class="criterion-id">C' + String(i + 1).padStart(2, '0') + '</span><div>' +
                '<span class="check-pill ' + status[1] + '">' + esc(status[0]) + '</span>' +
                '<p class="rubric-text">' + esc(c.text) + '</p>' +
                '<p class="small muted">' + esc(c.reason || '') + '</p>' +
                (c.evidence ? '<blockquote class="evidence">“' + esc(c.evidence) + '”</blockquote>' : '') + '</div></li>';
        }).join('');
        var notes = (r.notes || []).map(function(n) { return '<li>' + esc(n) + '</li>'; }).join('');
        container.innerHTML = '<div class="verify-report rubric">' +
            '<div class="rubric-head"><strong>Verification report</strong><span class="check-pill ' + outcome.css + '">' + esc(outcome.label) + '</span></div>' +
            '<p class="small">' + esc(r.summary) + '</p>' +
            (r.security ? '<div class="notice warning">' + K().icon('alert', 16) + ' Security work. Only a qualified human reviewer can confirm it.</div>' : '') +
            (r.mode_note ? '<p class="small muted">' + esc(r.mode_note) + '</p>' : '') +
            '<ol class="rubric-list">' + items + '</ol>' +
            '<ul class="small muted check-notes">' + notes + '</ul>' +
            '<p class="small muted">Created ' + esc(K().dateText(r.created_at || r.checked_at)) + '. The report never accepts or rejects work.</p></div>';
    };

    /* ---------- reputation ---------- */
    var BANDS = { emerging: 'Emerging', established: 'Established', trusted: 'Trusted' };
    F.mounts.workerReputation = function(container, w) {
        var rep = w.reputation;
        if (!rep) return;
        var cards = (rep.industries || []).map(function(i) {
            var band = BANDS[i.band] || 'Emerging';
            return '<article class="rep-card"><div class="rep-head"><strong>' + esc(K().titleCase(i.industry)) + '</strong>' +
                '<span class="tag">' + esc(band) + '</span></div>' +
                '<dl class="definition-list">' +
                '<div><dt>Verified tasks</dt><dd>' + esc(i.verified_completed) + '</dd></div>' +
                '<div><dt>Weighted score</dt><dd>' + esc(i.weighted_score) + '</dd></div>' +
                '<div><dt>On time</dt><dd>' + (i.on_time_rate == null ? '—' : Math.round(i.on_time_rate * 100) + '%') + '</dd></div>' +
                '<div><dt>Client rating</dt><dd>' + (i.average_rating == null ? 'No ratings yet' : esc(i.average_rating) + ' / 5 (' + esc(i.rating_count) + ')') + '</dd></div>' +
                '<div><dt>Revisions</dt><dd>' + (i.revision_rate == null ? '—' : Math.round(i.revision_rate * 100) + '% of tasks') + '</dd></div>' +
                '</dl></article>';
        }).join('');
        var dh = rep.dispute_history;
        var disputeLine = '';
        if (dh && (dh.decided > 0 || dh.open > 0)) {
            disputeLine = '<p class="small"><strong>Disputes</strong> · ' + esc(dh.decided) + ' decided' +
                ' · ' + esc(dh.upheld_against) + ' upheld against this worker' +
                ' · ' + esc(dh.partial) + ' partly upheld' +
                ' · ' + esc(dh.upheld_for) + ' dismissed' +
                ' · ' + esc(dh.no_action) + ' no action' +
                ' · ' + esc(dh.open) + ' open</p>';
        }
        container.innerHTML = '<section class="detail-section reputation" aria-labelledby="rep-title"><h2 id="rep-title">Proof of work</h2>' +
            (cards ? '<div class="rep-grid">' + cards + '</div>' : '<p class="muted">No verified work in any industry yet.</p>') +
            disputeLine +
            '<ul class="small muted check-notes">' + (rep.notes || []).map(function(n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></section>';
    };

    /* ---------- milestones ---------- */
    var MS_STATUS = {
        planned: ['Planned', 'status-pill'],
        in_progress: ['In progress', 'status-pill'],
        submitted: ['Submitted for review', 'status-pill'],
        revision_requested: ['Changes requested', 'status-pill'],
        approved: ['Approved', 'status-pill']
    };
    var EVENT_LABELS = {
        created: 'Milestone created', edited: 'Details edited', assigned: 'Worker assigned', started: 'Work started',
        submitted: 'Submitted for review', revision_requested: 'Changes requested', approved: 'Approved (payment eligibility recorded)'
    };

    F.mounts.projectMilestones = function(container, project) {
        if (!K().isAuthenticated()) return;
        var section = document.createElement('section');
        section.className = 'detail-section milestones';
        section.setAttribute('aria-labelledby', 'milestones-title');
        section.innerHTML = '<h2 id="milestones-title">Milestones</h2><div data-ms-body><div class="loading-line"><span class="spinner"></span> Loading milestones…</div></div>';
        container.appendChild(section);
        load(section, project.id);
    };

    function load(section, projectId) {
        var body = section.querySelector('[data-ms-body]');
        K().api('/api/milestones/project/' + encodeURIComponent(projectId)).then(function(data) {
            if (data.role === 'owner') {
                return K().api('/api/milestones/project/' + encodeURIComponent(projectId) + '/workers').then(function(workers) {
                    render(section, projectId, data, workers);
                });
            }
            render(section, projectId, data, []);
        }).catch(function(error) {
            body.innerHTML = '<div class="notice warning">' + K().icon('alert', 16) + ' ' + esc(K().friendlyApiError(error, 'Milestones could not be loaded.')) + '</div>';
        });
    }

    function render(section, projectId, data, workers) {
        var body = section.querySelector('[data-ms-body]');
        var isOwner = data.role === 'owner';
        var list = data.milestones || [];
        var approved = list.filter(function(m) { return m.status === 'approved'; });
        var total = list.reduce(function(s, m) { return s + m.budget; }, 0);
        var names = {};
        workers.forEach(function(w) { names[w.id] = w.name; });

        var summary = '<p class="small muted">' + approved.length + ' of ' + list.length + ' approved · budgeted ' + money(total) + '</p>';
        var pb = data.project_budget;
        var budgetCard = '';
        if (isOwner && pb) {
            var capText = pb.total === null ? 'No project budget set. Milestones are not capped.' :
                'Project budget ' + money(pb.total) + ' · allocated ' + money(pb.allocated) + ' · remaining ' + money(pb.remaining);
            budgetCard = '<form class="ux-actions" data-ms-budget-form novalidate>' +
                '<p class="small muted">' + esc(capText) + '</p>' +
                '<div class="field"><label for="ms-project-budget">Project budget cap (NGN, leave empty for none)</label>' +
                '<input id="ms-project-budget" name="total_budget" type="number" min="0" max="10000000" step="0.01" value="' + (pb.total === null ? '' : esc(pb.total)) + '"></div>' +
                '<button class="btn btn-sm" type="submit">Save project budget</button></form>';
        }
        var add = isOwner ? '<div class="ux-actions"><button class="btn btn-sm btn-primary" type="button" data-ms-new>Add milestone</button></div><div data-ms-form></div>' : '';
        var cards = list.length ? list.map(function(m) { return card(m, isOwner, names); }).join('') :
            '<div class="empty-state"><h3>No milestones yet</h3><p>' + (isOwner ? 'Split this project into stages, each with its own deliverables, budget and deadline.' : 'No milestone has been assigned to you in this project.') + '</p></div>';

        body.innerHTML = summary + budgetCard + add + '<div class="milestone-list">' + cards + '</div>';

        if (isOwner) {
            body.querySelector('[data-ms-new]').addEventListener('click', function() {
                openForm(section, projectId, null, list, workers);
            });
        }
        var budgetForm = body.querySelector('[data-ms-budget-form]');
        if (budgetForm) {
            budgetForm.onsubmit = function(event) {
                event.preventDefault();
                var raw = budgetForm.total_budget.value.trim();
                var value = raw === '' ? null : Number(raw);
                if (value !== null && (!isFinite(value) || value < 0 || value > 10000000)) {
                    K().toast('Enter a project budget between 0 and 10,000,000, or leave it empty.', 'error');
                    return;
                }
                K().api('/api/milestones/project/' + encodeURIComponent(projectId) + '/budget', { method: 'PATCH', body: { total_budget: value } }).then(function() {
                    K().toast(value === null ? 'Project budget cap cleared.' : 'Project budget saved.', 'success');
                    load(section, projectId);
                }).catch(function(error) {
                    K().toast(K().friendlyApiError(error, 'The project budget could not be saved.'), 'error');
                });
            };
        }
        body.querySelectorAll('[data-ms-edit]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var m = list.find(function(x) { return x.id === btn.getAttribute('data-ms-edit'); });
                openForm(section, projectId, m, list, workers);
            });
        });
        body.querySelectorAll('[data-ms-action]').forEach(function(btn) {
            btn.addEventListener('click', function() { act(section, projectId, btn); });
        });
        body.querySelectorAll('[data-ms-events]').forEach(function(btn) {
            btn.addEventListener('click', function() { toggleEvents(btn); });
        });
        body.querySelectorAll('[data-ms-submit]').forEach(function(form) {
            form.addEventListener('submit', function(event) {
                event.preventDefault();
                var text = form.querySelector('[name="text"]').value.trim();
                var link = form.querySelector('[name="link"]').value.trim();
                if (text.length < 20) return K().toast('Describe the work in at least 20 characters.', 'error');
                var body2 = { submission_text: text };
                if (link) body2.submission_link = link;
                post('/api/milestones/' + encodeURIComponent(form.getAttribute('data-ms-submit')) + '/submit', body2, 'Submitted for review.', section, projectId);
            });
        });
        body.querySelectorAll('[data-ms-revise]').forEach(function(form) {
            form.addEventListener('submit', function(event) {
                event.preventDefault();
                var notes = form.querySelector('[name="notes"]').value.trim();
                if (notes.length < 10) return K().toast('Explain the changes in at least 10 characters.', 'error');
                post('/api/milestones/' + encodeURIComponent(form.getAttribute('data-ms-revise')) + '/request-revision', { notes: notes }, 'Changes requested.', section, projectId);
            });
        });
    }

    function card(m, isOwner, names) {
        var status = MS_STATUS[m.status] || MS_STATUS.planned;
        var id = esc(m.id);
        var waiting = m.waiting_on && m.waiting_on.length ? '<p class="small muted">Waiting for approval of: ' + esc(m.waiting_on.join(', ')) + '</p>' : '';
        var worker = m.worker_id ? (names[m.worker_id] ? esc(names[m.worker_id]) : 'Assigned') : 'Not assigned';
        var actions = '';
        if (isOwner) {
            if (m.status === 'planned') actions += '<button class="btn btn-sm" type="button" data-ms-edit="' + id + '">Edit</button> ';
            if (m.status === 'submitted') {
                actions += '<button class="btn btn-sm btn-primary" type="button" data-ms-action="approve" data-id="' + id + '">Approve</button> ';
                actions += '<details class="ms-revise"><summary class="btn btn-sm">Request changes</summary>' +
                    '<form data-ms-revise="' + id + '"><div class="field"><label for="rev-' + id + '">What should change?</label><textarea id="rev-' + id + '" name="notes" rows="3" maxlength="1000" required></textarea></div>' +
                    '<button class="btn btn-sm" type="submit">Send back</button></form></details> ';
            }
        } else {
            if (m.can_start) actions += '<button class="btn btn-sm btn-primary" type="button" data-ms-action="start" data-id="' + id + '">Start this milestone</button> ';
            if (m.status === 'in_progress' || m.status === 'revision_requested') {
                actions += '<form class="ms-submit" data-ms-submit="' + id + '"><div class="field"><label for="sub-' + id + '">Describe the work</label><textarea id="sub-' + id + '" name="text" rows="4" maxlength="5000" required></textarea></div>' +
                    '<div class="field"><label for="link-' + id + '">Link (optional, https)</label><input id="link-' + id + '" name="link" type="url" maxlength="255" placeholder="https://"></div>' +
                    '<button class="btn btn-primary btn-sm" type="submit">Submit for review</button></form>';
            }
        }
        return '<article class="milestone-card" data-milestone="' + id + '">' +
            '<div class="ux-row-between"><h3 class="ux-m0">' + m.position + '. ' + esc(m.title) + '</h3><span class="' + status[1] + '">' + esc(status[0]) + '</span></div>' +
            '<p class="small">' + esc(m.description || '') + '</p>' +
            '<p class="small"><strong>Deliverables:</strong> ' + esc(m.deliverables) + '</p>' +
            '<p class="small"><strong>Acceptance:</strong> ' + esc(m.acceptance_criteria) + '</p>' +
            '<p class="small muted">Budget ' + money(m.budget) + ' · Deadline ' + esc(when(m.deadline)) + (isOwner ? ' · Worker: ' + worker : '') + '</p>' +
            waiting +
            (m.revision_notes && (m.status === 'revision_requested') ? '<div class="notice warning">Requested changes: ' + esc(m.revision_notes) + '</div>' : '') +
            (m.status === 'approved' ? '<p class="small muted">Approved ' + esc(K().dateText(m.approved_at)) + '. Payment eligibility recorded. No payment has been made.</p>' : '') +
            '<div class="ms-actions">' + actions + '</div>' +
            '<button class="btn btn-sm btn-ghost" type="button" data-ms-events="' + id + '">Show history</button><div class="ms-history" hidden></div>' +
            '</article>';
    }

    function act(section, projectId, btn) {
        var id = btn.getAttribute('data-id');
        if (btn.getAttribute('data-ms-action') === 'approve') {
            if (!window.confirm('Approve this milestone? This records payment eligibility. No payment is made.')) return;
            return post('/api/milestones/' + encodeURIComponent(id) + '/approve', null, 'Milestone approved.', section, projectId);
        }
        return post('/api/milestones/' + encodeURIComponent(id) + '/start', null, 'Milestone started.', section, projectId);
    }

    function post(path, body, message, section, projectId) {
        K().api(path, { method: 'POST', body: body || undefined }).then(function() {
            K().toast(message, 'success');
            load(section, projectId);
        }).catch(function(error) {
            K().toast(K().friendlyApiError(error, 'That did not work. Try again.'), 'error');
        });
    }

    function toggleEvents(btn) {
        var box = btn.parentNode.querySelector('.ms-history');
        if (!box.hidden) { box.hidden = true; btn.textContent = 'Show history'; return; }
        btn.textContent = 'Hide history';
        box.hidden = false;
        box.innerHTML = '<div class="loading-line"><span class="spinner"></span></div>';
        K().api('/api/milestones/' + encodeURIComponent(btn.getAttribute('data-ms-events')) + '/events').then(function(rows) {
            box.innerHTML = rows.length ? '<ol class="criteria-list">' + rows.map(function(e) {
                return '<li><span class="small muted">' + esc(K().dateText(e.created_at)) + '</span> ' + esc(e.actor || 'System') + ': ' + esc(EVENT_LABELS[e.event] || e.event) + '</li>';
            }).join('') + '</ol>' : '<p class="small muted">No history yet.</p>';
        }).catch(function(error) {
            box.innerHTML = '<p class="small muted">' + esc(K().friendlyApiError(error, 'History could not be loaded.')) + '</p>';
        });
    }

    function openForm(section, projectId, m, list, workers) {
        var host = section.querySelector('[data-ms-form]');
        if (!host) return;
        var editing = Boolean(m);
        var others = list.filter(function(x) { return !m || x.id !== m.id; });
        var deps = editing ? (m.depends_on || []).map(function(d) { return d.id; }) : [];
        var workerOptions = '<option value="">Not assigned yet</option>' + workers.map(function(w) {
            return '<option value="' + esc(w.id) + '"' + (editing && m.worker_id === w.id ? ' selected' : '') + '>' + esc(w.name) + '</option>';
        }).join('');
        var depBoxes = others.length ? others.map(function(x) {
            return '<label class="check-line"><input type="checkbox" name="dep" value="' + esc(x.id) + '"' + (deps.indexOf(x.id) !== -1 ? ' checked' : '') + '> ' + esc(x.position + '. ' + x.title) + '</label>';
        }).join('') : '<p class="small muted">Waits for nothing yet.</p>';
        var deadline = m && m.deadline ? new Date(m.deadline).toISOString().slice(0, 16) : '';
        host.innerHTML = '<form class="panel ms-form" novalidate>' +
            '<h3 class="small-heading">' + (editing ? 'Edit milestone' : 'New milestone') + '</h3>' +
            '<div class="form-grid">' +
            '<div class="field span-2"><label for="ms-title">Title</label><input id="ms-title" name="title" required minlength="3" maxlength="160" value="' + esc(m ? m.title : '') + '"></div>' +
            '<div class="field span-2"><label for="ms-desc">Description (optional)</label><textarea id="ms-desc" name="description" rows="2" maxlength="2000">' + esc(m ? m.description : '') + '</textarea></div>' +
            '<div class="field span-2"><label for="ms-del">Deliverables</label><textarea id="ms-del" name="deliverables" rows="2" required maxlength="2000">' + esc(m ? m.deliverables : '') + '</textarea></div>' +
            '<div class="field span-2"><label for="ms-acc">Acceptance criteria</label><textarea id="ms-acc" name="acceptance_criteria" rows="2" required maxlength="2000">' + esc(m ? m.acceptance_criteria : '') + '</textarea></div>' +
            '<div class="field"><label for="ms-budget">Budget (NGN)</label><input id="ms-budget" name="budget" type="number" min="0" max="1000000" step="0.01" value="' + esc(m ? m.budget : 0) + '"></div>' +
            '<div class="field"><label for="ms-deadline">Deadline</label><input id="ms-deadline" name="deadline" type="datetime-local" value="' + esc(deadline) + '"></div>' +
            '<div class="field span-2"><label for="ms-worker">Assign to</label><select id="ms-worker" name="worker_id">' + workerOptions + '</select>' +
            '<span class="field-hint">Only workers who have taken or submitted to a task in this project appear here.</span></div>' +
            '<fieldset class="field span-2"><legend>Waits for</legend>' + depBoxes + '</fieldset>' +
            '</div><div class="ux-actions"><button class="btn btn-primary btn-sm" type="submit">' + (editing ? 'Save changes' : 'Add milestone') + '</button>' +
            '<button class="btn btn-sm" type="button" data-cancel>Cancel</button></div></form>';

        var form = host.querySelector('form');
        form.querySelector('[data-cancel]').addEventListener('click', function() { host.innerHTML = ''; });
        form.addEventListener('submit', function(event) {
            event.preventDefault();
            var f = form;
            var body = {
                title: f.title.value.trim(),
                description: f.description.value.trim(),
                deliverables: f.deliverables.value.trim(),
                acceptance_criteria: f.acceptance_criteria.value.trim(),
                budget: Number(f.budget.value || 0),
                deadline: toIso(f.deadline.value),
                worker_id: f.worker_id.value || null,
                depends_on: Array.prototype.map.call(f.querySelectorAll('input[name="dep"]:checked'), function(i) { return i.value; })
            };
            if (body.title.length < 3) return K().toast('Give the milestone a title of at least 3 characters.', 'error');
            if (body.deliverables.length < 3 || body.acceptance_criteria.length < 3) return K().toast('Describe the deliverables and acceptance criteria.', 'error');
            var request = editing ?
                K().api('/api/milestones/' + encodeURIComponent(m.id), { method: 'PATCH', body: body }) :
                K().api('/api/milestones/project/' + encodeURIComponent(projectId), { method: 'POST', body: body });
            request.then(function() {
                K().toast(editing ? 'Milestone saved.' : 'Milestone added.', 'success');
                load(section, projectId);
            }).catch(function(error) {
                K().toast(K().friendlyApiError(error, 'The milestone could not be saved.'), 'error');
            });
        });
    }
})();
