// Phase 2 screens: dispute resolution centre, duplicate submission review, budget guidance.
// Loaded after core.js and before bounty.js. Uses window.BountyKit for shared helpers.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function money(v) { return 'NGN ' + Number(v || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function when(v) { return v ? K().dateText(v) : '—'; }
    function app() { return K().app; }
    function need(role) {
        if (!K().isAuthenticated()) { K().go('auth/login'); return false; }
        if (role && K().getRole() !== role && !(role === 'admin' && K().state.user && K().state.user.is_admin)) {
            app().innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h3>Not available for this account</h3><p>This page is for ' + esc(role === 'admin' ? 'Bounty administrators' : role + ' accounts') + '.</p></div></div></section>';
            return false;
        }
        return true;
    }
    function isAdmin() { return Boolean(K().state.user && K().state.user.is_admin); }
    function loading(label) {
        app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> ' + esc(label) + '</div></div></section>';
    }
    function fail(error, fallback) {
        app().innerHTML = '<section class="page"><div class="container"><div class="notice warning">' + esc(K().friendlyApiError(error, fallback)) + '</div></div></section>';
    }
    function isHttps(url) { return /^https:\/\//i.test(String(url || '')); }

    var STATUS_CSS = { open: 'check-possible', awaiting_response: 'check-possible', under_review: 'check-possible', awaiting_evidence: 'check-possible', escalated: 'check-fail', resolved: 'check-pass' };
    var OUTCOME_OPTIONS = [
        ['upheld_raiser', 'In favour of the person who raised it'],
        ['upheld_respondent', 'In favour of the other party'],
        ['partial', 'Partly in favour of each party'],
        ['no_action', 'No action required']
    ];

    /* ================= DISPUTES: LIST ================= */
    F.routes.push({
        match: function(r) { return r === 'disputes' || r === 'disputes/new' || r.indexOf('disputes/') === 0 || r === 'admin/disputes'; },
        render: function(route) {
            if (route === 'disputes') return disputesList();
            if (route === 'disputes/new') return disputeForm();
            if (route === 'admin/disputes') return adminQueue();
            return disputeDetail(route.slice('disputes/'.length));
        }
    });

    function disputesList() {
        if (!need()) return;
        loading('Loading your disputes…');
        K().api('/api/disputes/mine').then(function(rows) {
            var admin = isAdmin() ? '<a class="btn btn-sm" href="#/admin/disputes">Administrator queue</a>' : '';
            var body = rows.length ? '<ul class="list-plain">' + rows.map(function(d) {
                return '<li class="card-row"><a href="#/disputes/' + esc(d.id) + '"><strong>' + esc(d.title) + '</strong></a>' +
                    '<span class="check-pill ' + (STATUS_CSS[d.status] || 'check-possible') + '">' + esc(d.status_label) + '</span>' +
                    '<p class="small muted">' + esc(d.category_label) + ' · ' + esc(d.target_title || '') + ' · Updated ' + esc(when(d.updated_at)) + '</p></li>';
            }).join('') + '</ul>' : '<div class="empty-state"><h3>No disputes</h3><p>If an agreement breaks down, you can raise a dispute with the evidence and an explanation. Both parties are heard before a decision.</p></div>';
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<div class="page-head"><div><p class="eyebrow">Resolution</p><h1>Disputes</h1></div>' +
                '<div class="page-actions">' + admin + '<a class="btn btn-primary" href="#/disputes/new">Raise a dispute</a></div></div>' +
                '<p class="muted">Each dispute keeps a full record of messages, evidence and decisions. Raising one may hold related payments until it is decided.</p>' +
                body + '</div></section>';
        }).catch(function(e) { fail(e, 'Could not load disputes.'); });
    }

    /* ================= DISPUTES: RAISE ================= */
    function disputeForm() {
        if (!need()) return;
        var bountyId = K().queryParam('bounty') || '';
        var milestoneId = K().queryParam('milestone') || '';
        var submissionId = K().queryParam('submission') || '';
        loading('Preparing the dispute form…');
        Promise.all([
            K().api('/api/disputes/categories'),
            bountyId && K().getRole() === 'business' ? K().api('/api/submissions/bounty/' + encodeURIComponent(bountyId)).catch(function() { return []; }) :
                (bountyId ? K().api('/api/submissions/mine').then(function(rows) { return rows.filter(function(s) { return s.bounty_id === bountyId; }); }).catch(function() { return []; }) : Promise.resolve([]))
        ]).then(function(result) {
            var categories = result[0];
            var subs = result[1];
            var options = categories.map(function(c) { return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>'; }).join('');
            var subOptions = subs.length ? subs.map(function(s) {
                return '<option value="' + esc(s.id) + '"' + (s.id === submissionId ? ' selected' : '') + '>' + esc(s.worker_name || 'Submission') + ' · ' + esc(s.status) + '</option>';
            }).join('') : '';
            var target = milestoneId ? '<input type="hidden" id="dp-milestone" value="' + esc(milestoneId) + '">' :
                (bountyId ? '<input type="hidden" id="dp-bounty" value="' + esc(bountyId) + '">' : '');
            var needsSubmission = Boolean(bountyId) && K().getRole() === 'business';
            var targetError = !bountyId && !milestoneId;
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<a class="back-link" href="#/disputes">' + K().icon('arrowLeft', 16) + ' Back to disputes</a>' +
                '<h1>Raise a dispute</h1>' +
                (targetError ? '<div class="notice warning">Open this form from a task or milestone so the dispute points to the right work.</div>' : '') +
                '<form class="form-stack" id="dispute-form" novalidate>' + target +
                '<label class="field"><span>Category</span><select id="dp-category" required><option value="">Choose a category</option>' + options + '</select></label>' +
                (needsSubmission ? '<label class="field"><span>Submission this is about</span><select id="dp-submission" required><option value="">Choose a submission</option>' + subOptions + '</select></label>' : '') +
                '<label class="field"><span>Title</span><input id="dp-title" maxlength="160" required placeholder="A short summary"></label>' +
                '<label class="field"><span>What happened</span><textarea id="dp-description" rows="6" maxlength="3000" required placeholder="Describe the problem, what was agreed, and what you would like to happen. Between 20 and 3,000 characters."></textarea></label>' +
                '<p class="small muted">Only the parties and Bounty administrators can see this dispute. Do not include passwords or payment details.</p>' +
                '<div class="form-error" id="dp-error" role="alert" hidden></div>' +
                '<button class="btn btn-primary" type="submit" id="dp-submit"' + (targetError ? ' disabled' : '') + '>Submit dispute</button>' +
                '</form></div></section>';
            var form = document.getElementById('dispute-form');
            form.addEventListener('submit', function(event) {
                event.preventDefault();
                var err = document.getElementById('dp-error');
                var body = {
                    category: document.getElementById('dp-category').value,
                    title: document.getElementById('dp-title').value.trim(),
                    description: document.getElementById('dp-description').value.trim()
                };
                var m = document.getElementById('dp-milestone');
                var b = document.getElementById('dp-bounty');
                if (m) body.milestone_id = m.value;
                if (b) body.bounty_id = b.value;
                var s = document.getElementById('dp-submission');
                if (s && s.value) body.submission_id = s.value;
                if (!body.category) return showErr(err, 'Choose a category.');
                if (body.title.length < 3) return showErr(err, 'Give the dispute a title of at least 3 characters.');
                if (body.description.length < 20) return showErr(err, 'Describe what happened in at least 20 characters.');
                if (needsSubmission && !body.submission_id) return showErr(err, 'Choose the submission this dispute is about.');
                var btn = document.getElementById('dp-submit');
                btn.disabled = true;
                K().api('/api/disputes', { method: 'POST', body: body }).then(function(res) {
                    K().toast('Dispute submitted. The other party has been notified.', 'success');
                    K().go('disputes/' + res.id);
                }).catch(function(error) {
                    btn.disabled = false;
                    showErr(err, K().friendlyApiError(error, 'Could not submit the dispute.'));
                });
            });
        }).catch(function(e) { fail(e, 'Could not open the dispute form.'); });
    }
    function showErr(el, message) { el.textContent = message; el.hidden = false; }

    /* ================= DISPUTES: DETAIL ================= */
    function disputeDetail(id) {
        if (!need()) return;
        loading('Loading the dispute…');
        K().api('/api/disputes/' + encodeURIComponent(id)).then(function(d) { renderDetail(d); })
            .catch(function(e) { fail(e, 'Could not load this dispute.'); });
    }

    function renderDetail(d) {
        var admin = d.viewer_role === 'administrator';
        var target = d.target && (d.target.title || '') ? esc(d.target.title) : 'Task or milestone';
        var subs = (d.submissions || []).map(function(s) {
            return '<li>' + esc(s.title || 'Submission') + ' · ' + esc(s.status || '') + '</li>';
        }).join('');
        var messages = (d.messages || []).map(function(m) {
            return '<li class="thread-item"><div class="small muted">' + esc(m.author_name) + ' · ' + esc(when(m.created_at)) + '</div><p>' + esc(m.body) + '</p></li>';
        }).join('') || '<li class="muted">No messages yet.</li>';
        var evidence = (d.evidence || []).map(function(e) {
            var body = e.kind === 'link' && isHttps(e.body) ?
                '<a href="' + esc(e.body) + '" target="_blank" rel="noopener noreferrer">' + esc(e.body) + '</a>' : esc(e.body);
            return '<li class="thread-item"><div class="small muted">' + esc(e.added_by_name) + ' · ' + (e.kind === 'link' ? 'Link' : 'Text') + ' · ' + esc(when(e.created_at)) + '</div><p>' + body + '</p></li>';
        }).join('') || '<li class="muted">No evidence added yet.</li>';
        var events = (d.events || []).map(function(e) {
            return '<li class="small"><span class="muted">' + esc(when(e.created_at)) + '</span> · ' + esc(e.actor || 'System') + ' · ' + esc(String(e.event).replace(/_/g, ' ')) + '</li>';
        }).join('');
        var decision = d.decision ?
            '<section class="detail-section"><h2>Decision</h2><div class="notice">' +
            '<p><strong>' + esc(d.decision.outcome_label || d.decision.outcome) + '</strong></p><p>' + esc(d.decision.text) + '</p>' +
            '<p class="small muted">Payment: ' + esc(d.decision.payment === 'withhold' ? 'held for review' : d.decision.payment === 'release' ? 'released' : 'no change recorded') + ' · Decided ' + esc(when(d.decision.decided_at)) + '</p>' +
            (d.can_escalate ? '<button class="btn btn-sm" type="button" id="dp-escalate">Ask for a second decision</button>' : '') +
            '</div></section>' : '';

        var reply = d.can_respond ?
            '<form class="form-stack" id="dp-reply"><label class="field"><span>Add a message</span><textarea id="dp-reply-text" rows="3" maxlength="3000" required placeholder="At least 5 characters"></textarea></label><button class="btn btn-sm" type="submit">Send message</button></form>' +
            '<form class="form-stack" id="dp-evidence"><label class="field"><span>Add evidence</span><select id="dp-ev-kind"><option value="text">Written explanation</option><option value="link">Link (https)</option></select>' +
            '<textarea id="dp-ev-body" rows="3" maxlength="3000" required placeholder="Describe the evidence, or paste an https link"></textarea></label><button class="btn btn-sm" type="submit">Add evidence</button></form>' : '';
        var adminForm = admin && d.status !== 'resolved' ?
            '<section class="detail-section"><h2>Administrator decision</h2>' +
            '<form class="form-stack" id="dp-decide"><label class="field"><span>Outcome</span><select id="dp-outcome" required>' + OUTCOME_OPTIONS.map(function(o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
            '<label class="field"><span>Explanation for both parties</span><textarea id="dp-decision" rows="5" required placeholder="Explain the reasoning, referring to the messages and evidence. At least 20 characters."></textarea></label>' +
            '<label class="field"><span>Payment</span><select id="dp-payment"><option value="">No change to payment</option><option value="release">Release related payment</option><option value="withhold">Keep payment on hold</option></select></label>' +
            '<button class="btn btn-primary" type="submit">Record decision</button></form>' +
            '<form class="form-stack" id="dp-request"><label class="field"><span>Ask the parties for more evidence</span><textarea id="dp-request-text" rows="2" placeholder="What is needed? At least 10 characters."></textarea></label><button class="btn btn-sm" type="submit">Request evidence</button></form></section>' : '';

        app().innerHTML = '<section class="page"><div class="container">' +
            '<a class="back-link" href="#/disputes">' + K().icon('arrowLeft', 16) + ' Back to disputes</a>' +
            '<div class="detail-layout"><article>' +
            '<p class="eyebrow">' + esc(d.category_label) + '</p><h1>' + esc(d.title) + '</h1>' +
            '<p><span class="check-pill ' + (STATUS_CSS[d.status] || 'check-possible') + '">' + esc(d.status_label) + '</span></p>' +
            '<dl class="definition-list"><div><dt>About</dt><dd>' + target + '</dd></div>' +
            '<div><dt>Raised by</dt><dd>' + esc(d.raised_by && d.raised_by.name) + '</dd></div>' +
            '<div><dt>Respondent</dt><dd>' + esc(d.respondent && d.respondent.name) + '</dd></div>' +
            '<div><dt>Opened</dt><dd>' + esc(when(d.created_at)) + '</dd></div></dl>' +
            '<section class="detail-section"><h2>Account</h2><p>' + esc(d.description) + '</p></section>' +
            (subs ? '<section class="detail-section"><h2>Related submissions</h2><ul class="check-list">' + subs + '</ul></section>' : '') +
            decision + adminForm +
            '<section class="detail-section"><h2>Messages</h2><ul class="thread">' + messages + '</ul>' + reply + '</section>' +
            '<section class="detail-section"><h2>Evidence</h2><ul class="thread">' + evidence + '</ul></section>' +
            '</article><aside><section class="detail-section"><h2>Record</h2><ul class="check-list">' + (events || '<li class="muted">No events yet.</li>') + '</ul>' +
            '<p class="small muted">Every change is recorded here. Records cannot be edited or deleted.</p></section></aside></div></div></section>';

        wireDetail(d);
    }

    function wireDetail(d) {
        var reply = document.getElementById('dp-reply');
        if (reply) reply.addEventListener('submit', function(event) {
            event.preventDefault();
            var text = document.getElementById('dp-reply-text').value.trim();
            if (text.length < 5) return K().toast('Write at least 5 characters.', 'error');
            K().api('/api/disputes/' + encodeURIComponent(d.id) + '/messages', { method: 'POST', body: { body: text } })
                .then(function() { K().toast('Message sent.', 'success'); disputeDetail(d.id); })
                .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not send the message.'), 'error'); });
        });
        var ev = document.getElementById('dp-evidence');
        if (ev) ev.addEventListener('submit', function(event) {
            event.preventDefault();
            var kind = document.getElementById('dp-ev-kind').value;
            var body = document.getElementById('dp-ev-body').value.trim();
            if (kind === 'link' && !isHttps(body)) return K().toast('Evidence links must start with https://', 'error');
            K().api('/api/disputes/' + encodeURIComponent(d.id) + '/evidence', { method: 'POST', body: { kind: kind, body: body } })
                .then(function() { K().toast('Evidence added.', 'success'); disputeDetail(d.id); })
                .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not add the evidence.'), 'error'); });
        });
        var esc2 = document.getElementById('dp-escalate');
        if (esc2) esc2.addEventListener('click', function() {
            var reason = window.prompt('Why should this decision be reviewed again? (At least 20 characters)');
            if (reason === null) return;
            K().api('/api/disputes/' + encodeURIComponent(d.id) + '/escalate', { method: 'POST', body: { reason: reason.trim() } })
                .then(function() { K().toast('Your request for a second decision was recorded.', 'success'); disputeDetail(d.id); })
                .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not escalate.'), 'error'); });
        });
        var decide = document.getElementById('dp-decide');
        if (decide) decide.addEventListener('submit', function(event) {
            event.preventDefault();
            var body = {
                outcome: document.getElementById('dp-outcome').value,
                decision: document.getElementById('dp-decision').value.trim(),
                payment: document.getElementById('dp-payment').value || null
            };
            if (body.decision.length < 20) return K().toast('The explanation needs at least 20 characters.', 'error');
            K().api('/api/disputes/' + encodeURIComponent(d.id) + '/decide', { method: 'POST', body: body })
                .then(function() { K().toast('Decision recorded and both parties notified.', 'success'); disputeDetail(d.id); })
                .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not record the decision.'), 'error'); });
        });
        var request = document.getElementById('dp-request');
        if (request) request.addEventListener('submit', function(event) {
            event.preventDefault();
            var note = document.getElementById('dp-request-text').value.trim();
            K().api('/api/disputes/' + encodeURIComponent(d.id) + '/request-evidence', { method: 'POST', body: { note: note } })
                .then(function() { K().toast('The parties have been asked for more evidence.', 'success'); disputeDetail(d.id); })
                .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not send the request.'), 'error'); });
        });
    }

    /* ================= ADMIN QUEUE ================= */
    function adminQueue() {
        if (!need('admin')) return;
        var status = K().queryParam('status') || '';
        loading('Loading the dispute queue…');
        K().api('/api/disputes/admin/queue' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function(rows) {
            var filters = ['', 'open', 'under_review', 'awaiting_evidence', 'escalated', 'resolved'].map(function(s) {
                return '<a class="tag' + (s === status ? ' is-active' : '') + '" href="#/admin/disputes' + (s ? '?status=' + s : '') + '">' + esc(s ? s.replace(/_/g, ' ') : 'All') + '</a>';
            }).join(' ');
            var list = rows.length ? '<table class="data-table"><thead><tr><th>Dispute</th><th>Category</th><th>Status</th><th>Updated</th></tr></thead><tbody>' + rows.map(function(d) {
                return '<tr><td><a href="#/disputes/' + esc(d.id) + '">' + esc(d.title) + '</a></td><td>' + esc(d.category) + '</td><td><span class="check-pill ' + (STATUS_CSS[d.status] || 'check-possible') + '">' + esc(d.status_label) + '</span></td><td>' + esc(when(d.updated_at)) + '</td></tr>';
            }).join('') + '</tbody></table>' : '<div class="empty-state"><h3>Nothing in this queue</h3></div>';
            app().innerHTML = '<section class="page"><div class="container">' +
                '<div class="page-head"><div><p class="eyebrow">Administration</p><h1>Dispute queue</h1></div></div>' +
                '<p class="filter-row">' + filters + '</p>' + list + '</div></section>';
        }).catch(function(e) { fail(e, 'Could not load the queue.'); });
    }

    /* ================= DUPLICATE REVIEW (task page, owner) ================= */
    var DECISION_LABEL = { open: 'Needs review', duplicate: 'Same issue', independent: 'Found independently', dismissed: 'Dismissed' };

    F.mounts.duplicateReview = function(container, bounty) {
        function load() {
            container.innerHTML = '<div class="loading-line"><span class="spinner"></span> Checking for overlapping submissions…</div>';
            K().api('/api/duplicates/bounty/' + encodeURIComponent(bounty.id)).then(render).catch(function(e) {
                container.innerHTML = '<p class="small muted">' + esc(K().friendlyApiError(e, 'Could not load the overlap review.')) + '</p>';
            });
        }
        function render(flags) {
            var open = flags.filter(function(f) { return f.status === 'open'; }).length;
            var items = flags.length ? flags.map(function(f) {
                var pct = Math.round(f.score * 100);
                var reasons = (f.explanation || []).map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('');
                var subs = (f.submissions || []).map(function(s) { return esc(s.worker_name || 'Worker') + ' (' + esc(s.status) + ')'; }).join(' and ');
                var buttons = f.status === 'open' ?
                    '<div class="button-row"><button class="btn btn-sm" type="button" data-dup="' + esc(f.id) + '" data-decision="duplicate">Same issue</button>' +
                    '<button class="btn btn-sm" type="button" data-dup="' + esc(f.id) + '" data-decision="independent">Found independently</button>' +
                    '<button class="btn btn-sm" type="button" data-dup="' + esc(f.id) + '" data-decision="dismissed">Dismiss</button></div>' : '';
                return '<article class="rep-card dup-flag"><div class="rep-head"><strong>' + pct + '% similar</strong>' +
                    '<span class="tag">' + esc(DECISION_LABEL[f.status] || f.status) + '</span></div>' +
                    '<p class="small">' + subs + '</p>' +
                    (f.security ? '<div class="notice warning">Security work. Check whether each worker found the issue independently. Matching wording alone is not proof of copying.</div>' : '') +
                    '<ul class="small muted check-notes">' + reasons + '</ul>' + buttons + '</article>';
            }).join('') : '<p class="small muted">No overlapping submissions have been flagged.</p>';
            container.innerHTML = '<div class="dup-review"><div class="rubric-head"><strong>Overlap review</strong><span class="small muted">' + open + ' open</span></div>' +
                '<p class="small muted">A flag asks you to look at two submissions together. It is not a finding of misconduct, and no submission is changed by it.</p>' +
                items +
                '<div class="button-row"><button class="btn btn-sm" type="button" data-dup-scan>Re-check this task</button>' +
                '<a class="btn btn-sm" href="#/disputes/new?bounty=' + esc(bounty.id) + '">Raise a dispute about this task</a></div></div>';
            container.querySelectorAll('[data-dup]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var note = window.prompt('Optional note for your records:', '') || '';
                    K().api('/api/duplicates/' + encodeURIComponent(btn.getAttribute('data-dup')), { method: 'PATCH', body: { decision: btn.getAttribute('data-decision'), note: note.trim() || undefined } })
                        .then(function() { K().toast('Decision recorded.', 'success'); load(); })
                        .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not record the decision.'), 'error'); });
                });
            });
            var scan = container.querySelector('[data-dup-scan]');
            if (scan) scan.addEventListener('click', function() {
                K().api('/api/duplicates/bounty/' + encodeURIComponent(bounty.id) + '/scan', { method: 'POST' })
                    .then(function() { K().toast('Overlap check complete.', 'success'); load(); })
                    .catch(function(e) { K().toast(K().friendlyApiError(e, 'Could not run the check.'), 'error'); });
            });
        }
        load();
    };

    /* ================= BUDGET GUIDANCE (create task page) ================= */
    F.mounts.budgetGuidance = function(container) {
        container.innerHTML = '<div class="budget-guidance"><div class="rubric-head"><strong>Budget guidance</strong></div>' +
            '<p class="small muted">A planning estimate from the details you have entered. It is not a verified market rate. You set the final budget.</p>' +
            '<button class="btn btn-sm" type="button" id="budget-estimate">Estimate a budget</button><div id="budget-out"></div></div>';
        document.getElementById('budget-estimate').addEventListener('click', function() {
            var val = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
            var days = val('bounty-deadline') ? Math.ceil((new Date(val('bounty-deadline')) - Date.now()) / 86400000) : null;
            var body = {
                category: val('bounty-category'),
                difficulty: val('bounty-difficulty'),
                description: val('bounty-description'),
                deliverables: val('bounty-requirements'),
                criteria_count: (val('bounty-criteria') || '').split('\n').filter(Boolean).length,
                reward: val('bounty-reward') || undefined,
                deadline: days === null ? undefined : new Date(Date.now() + days * 86400000).toISOString()
            };
            var out = document.getElementById('budget-out');
            out.innerHTML = '<div class="loading-line"><span class="spinner"></span> Estimating…</div>';
            K().api('/api/budget/estimate', { method: 'POST', body: body }).then(function(r) {
                var warn = (r.warnings || []).map(function(w) { return '<div class="notice warning">' + esc(w) + '</div>'; }).join('');
                var factors = (r.factors || []).map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('');
                var assumptions = (r.assumptions || []).map(function(a) { return '<li>' + esc(a) + '</li>'; }).join('');
                out.innerHTML = warn + '<dl class="definition-list">' +
                    '<div><dt>Complexity</dt><dd>' + esc(K().titleCase(r.complexity)) + '</dd></div>' +
                    '<div><dt>Estimated hours</dt><dd>' + esc(r.estimated_hours.low) + '–' + esc(r.estimated_hours.high) + '</dd></div>' +
                    '<div><dt>Recommended range</dt><dd>' + money(r.recommended_range.low) + ' – ' + money(r.recommended_range.high) + '</dd></div></dl>' +
                    '<p class="small"><strong>Why this estimate</strong></p><ul class="small muted check-notes">' + factors + '</ul>' +
                    '<p class="small"><strong>Assumptions</strong></p><ul class="small muted check-notes">' + assumptions + '</ul>';
            }).catch(function(e) {
                out.innerHTML = '<p class="small muted">' + esc(K().friendlyApiError(e, 'Could not estimate the budget.')) + '</p>';
            });
        });
    };
})();
