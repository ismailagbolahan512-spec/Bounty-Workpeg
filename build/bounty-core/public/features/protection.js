// Trust and safety screens: account standing and appeals (everyone), misuse and incident
// reports (workers), access revocation (businesses), and the review console (admins).
// Loaded after core.js and before bounty.js. Uses window.BountyKit for shared helpers.
// Every value from the server is escaped before it reaches innerHTML.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function when(v) { return v ? K().dateText(v) : '—'; }
    function me() { return K().state.user || {}; }
    function fail(error, fallback) { return K().friendlyApiError(error, fallback); }
    function toast(msg, kind) { K().toast(msg, kind || 'info'); }

    var ACTION_LABEL = {
        warning: 'Warning', restrict_publishing: 'Publishing restricted', suspend: 'Account suspended', terminate: 'Account terminated',
    };
    var REPORT_KIND = { copyright_misuse: 'Copyright misuse', confidentiality_incident: 'Confidentiality incident' };
    var REPORT_STATUS = {
        submitted: 'Submitted', under_review: 'Under review', additional_information_required: 'More information required',
        resolved: 'Resolved', rejected: 'Rejected',
    };
    // Mirrors the server's REPORT_TRANSITIONS so the console only offers valid moves.
    var NEXT_STATUS = {
        submitted: ['under_review', 'rejected'],
        under_review: ['additional_information_required', 'resolved', 'rejected'],
        additional_information_required: ['under_review', 'resolved', 'rejected'],
        resolved: [], rejected: [],
    };

    function section(title, body) {
        return '<section class="detail-section protection-section"><h2>' + esc(title) + '</h2>' + body + '</section>';
    }
    function notice(text, kind) {
        return '<div class="notice ' + (kind || '') + '">' + esc(text) + '</div>';
    }
    function table(headers, rows) {
        if (!rows.length) return '<p class="small muted">Nothing here yet.</p>';
        return '<div class="table-wrap"><table class="table"><thead><tr>' +
            headers.map(function(h) { return '<th>' + esc(h) + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }
    function cell(v) { return '<td>' + v + '</td>'; }

    function loading() {
        app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> Loading</div></div></section>';
    }

    /* ================================================================ page */
    function protectionPage() {
        if (!K().isAuthenticated()) { K().go('auth/login'); return; }
        loading();
        var parts = [];
        Promise.all([
            K().api('/api/protection/enforcement/mine').catch(function() { return { actions: [] }; }),
            K().api('/api/protection/agreements/mine').catch(function() { return { accepted: [] }; }),
        ]).then(function(res) {
            parts.push(standingSection(res[0].actions || []));
            parts.push(agreementsSection(res[1].accepted || []));
            if (K().getRole() === 'worker') parts.push(workerSection());
            if (me().is_admin) parts.push(adminSection());
            app().innerHTML = '<section class="page"><div class="container"><h1>Trust and safety</h1>' +
                '<p class="muted">Agreements, reports, confidentiality and account decisions. Every decision is recorded.</p>' +
                parts.join('') + '</div></section>';
            bindStanding();
            if (K().getRole() === 'worker') bindWorker();
            if (me().is_admin) bindAdmin();
        });
    }

    /* ================================================================ account standing and appeals */
    function standingSection(actions) {
        if (!actions.length) return section('Your account standing', '<p class="small muted">No enforcement actions on your account.</p>');
        var rows = actions.map(function(a) {
            var appealable = (a.action === 'restrict_publishing' || a.action === 'suspend') && !a.reversed && !a.appeal_status;
            var status = a.reversed ? 'Reversed' : (a.appeal_status ? 'Appeal ' + a.appeal_status : 'In force');
            var appeal = appealable
                ? '<form class="appeal-form" data-action-id="' + esc(a.id) + '">' +
                  '<label class="field-label">Appeal this decision<textarea name="statement" rows="3" maxlength="2000" required></textarea></label>' +
                  '<button class="btn btn-quiet" type="submit">Send appeal</button></form>'
                : '';
            return '<tr>' + cell(esc(ACTION_LABEL[a.action] || a.action)) + cell(esc(a.reason)) +
                cell(esc(when(a.created_at))) + cell(esc(status)) + cell(appeal) + '</tr>';
        });
        return section('Your account standing', table(['Decision', 'Reason', 'Date', 'Status', 'Appeal'], rows));
    }

    function bindStanding() {
        app().querySelectorAll('.appeal-form').forEach(function(form) {
            form.addEventListener('submit', function(e) {
                e.preventDefault();
                var statement = form.elements.statement.value.trim();
                K().api('/api/protection/enforcement/' + encodeURIComponent(form.dataset.actionId) + '/appeal', {
                    method: 'POST', body: { statement: statement },
                }).then(function() {
                    toast('Appeal sent. It will be reviewed.', 'success');
                    protectionPage();
                }).catch(function(error) { toast(fail(error, 'Could not send the appeal.'), 'error'); });
            });
        });
    }

    /* ================================================================ agreements */
    function agreementsSection(accepted) {
        var titles = { creator_protection_business: 'Creator Protection Agreement', worker_submission_ip: 'Worker Submission and IP Agreement' };
        var byKind = {};
        accepted.forEach(function(a) { if (!a.bounty_id) byKind[a.kind] = a; });
        var rows = Object.keys(titles).filter(function(k) {
            return (k === 'creator_protection_business' && K().getRole() === 'business') ||
                   (k === 'worker_submission_ip' && K().getRole() === 'worker');
        }).map(function(k) {
            return '<tr>' + cell(esc(titles[k])) + cell(byKind[k] ? esc('Accepted ' + when(byKind[k].accepted_at)) : 'Not accepted yet') + '</tr>';
        });
        if (!rows.length) return '';
        return section('Your agreements', table(['Agreement', 'Status'], rows) +
            '<p class="small muted">Agreement texts are shown when you first need to accept them. They are drafts pending legal review.</p>');
    }

    /* ================================================================ worker: reports */
    function workerSection() {
        return section('Report misuse or an incident',
            '<p class="small muted">Use this for copyright misuse of your own work, or for a confidentiality incident on a task you were part of.</p>' +
            '<form id="report-form" class="form-grid" novalidate>' +
            '<label class="field-label span-2">What happened<select name="kind" required>' +
            '<option value="copyright_misuse">Someone is using my submission without permission</option>' +
            '<option value="confidentiality_incident">Confidential task material was disclosed</option></select></label>' +
            '<label class="field-label span-2">Task and submission<select name="ref" id="report-ref" required><option value="">Loading your submissions…</option></select></label>' +
            '<label class="field-label span-2">Describe it<textarea name="description" rows="4" maxlength="2000" required></textarea></label>' +
            '<label class="field-label span-2">Evidence (links or references, optional)<input name="evidence" maxlength="2000"></label>' +
            '<div class="span-2"><button class="btn btn-primary" type="submit">Send report</button></div>' +
            '<p class="field-hint span-2" id="report-error" hidden></p></form>' +
            '<h3 class="small-heading">Your reports</h3><div id="my-reports"><p class="small muted">Loading</p></div>');
    }

    function bindWorker() {
        K().api('/api/submissions/mine').then(function(rows) {
            var select = document.getElementById('report-ref');
            if (!select) return;
            select.innerHTML = '<option value="">Choose a task</option>' + rows.map(function(s) {
                return '<option value="' + esc(s.id) + '" data-bounty="' + esc(s.bounty_id) + '">' +
                    esc((s.bounty_title || 'Task') + ' · ' + (s.title || 'Submission')) + '</option>';
            }).join('');
        }).catch(function() {});

        var form = document.getElementById('report-form');
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            var errorBox = document.getElementById('report-error');
            var kind = form.elements.kind.value;
            var ref = form.elements.ref.selectedOptions[0];
            if (!ref || !ref.value) { errorBox.textContent = 'Choose a task.'; errorBox.hidden = false; return; }
            var body = {
                kind: kind,
                bounty_id: ref.dataset.bounty,
                description: form.elements.description.value.trim(),
                evidence: form.elements.evidence.value.trim() || null,
            };
            if (kind === 'copyright_misuse') body.submission_id = ref.value;
            K().api('/api/protection/reports', { method: 'POST', body: body }).then(function() {
                toast('Report sent. Your evidence is kept.', 'success');
                protectionPage();
            }).catch(function(error) {
                errorBox.textContent = fail(error, 'Could not send the report.');
                errorBox.hidden = false;
            });
        });

        K().api('/api/protection/reports/mine').then(function(res) {
            var rows = (res.reports || []).map(function(r) {
                return '<tr>' + cell(esc(REPORT_KIND[r.kind] || r.kind)) + cell(esc(REPORT_STATUS[r.status] || r.status)) +
                    cell(esc(when(r.created_at))) + '</tr>';
            });
            document.getElementById('my-reports').innerHTML = table(['Report', 'Status', 'Filed'], rows);
        }).catch(function() {});
    }


    /* ================================================================ admin console */
    function adminSection() {
        var statusOptions = Object.keys(REPORT_STATUS).map(function(k) {
            return '<option value="' + k + '">' + esc(REPORT_STATUS[k]) + '</option>';
        }).join('');
        return section('Review console',
            '<h3 class="small-heading">Reports</h3>' +
            '<label class="field-label">Show<select id="queue-status"><option value="">All</option>' + statusOptions + '</select></label>' +
            '<div id="report-queue"></div>' +
            '<div id="report-detail"></div>' +
            '<h3 class="small-heading">Enforcement</h3>' +
            '<form id="enforce-form" class="form-grid" novalidate>' +
            '<label class="field-label">Account user ID<input name="user_id" required></label>' +
            '<label class="field-label">Action<select name="action">' +
            '<option value="warning">Warning</option><option value="restrict_publishing">Restrict publishing</option>' +
            '<option value="suspend">Suspend</option><option value="terminate">Terminate (permanent)</option></select></label>' +
            '<label class="field-label">Related report ID (optional)<input name="report_id"></label>' +
            '<label class="field-label span-2">Reason<textarea name="reason" rows="2" maxlength="1000" required></textarea></label>' +
            '<label class="check-line span-2" id="legal-line" hidden><input name="legal" type="checkbox"> Legal review has been completed for this termination.</label>' +
            '<div class="span-2"><button class="btn btn-primary" type="submit">Apply</button></div></form>' +
            '<h3 class="small-heading">Reverse an action</h3>' +
            '<form id="reverse-form" class="form-grid" novalidate>' +
            '<label class="field-label">Action ID<input name="id" required></label>' +
            '<label class="field-label">Reason<input name="reason" maxlength="1000" required></label>' +
            '<div class="span-2"><button class="btn btn-quiet" type="submit">Reverse</button></div></form>' +
            '<h3 class="small-heading">Open appeals</h3><div id="appeal-queue"></div>');
    }

    function bindAdmin() {
        loadQueue();
        document.getElementById('queue-status').addEventListener('change', loadQueue);

        var enforce = document.getElementById('enforce-form');
        enforce.elements.action.addEventListener('change', function() {
            document.getElementById('legal-line').hidden = enforce.elements.action.value !== 'terminate';
        });
        enforce.addEventListener('submit', function(e) {
            e.preventDefault();
            var body = {
                user_id: enforce.elements.user_id.value.trim(),
                action: enforce.elements.action.value,
                reason: enforce.elements.reason.value.trim(),
            };
            var reportId = enforce.elements.report_id.value.trim();
            if (reportId) body.report_id = reportId;
            if (body.action === 'terminate') body.legal_review_confirmed = enforce.elements.legal.checked;
            K().api('/api/protection/admin/enforcement', { method: 'POST', body: body }).then(function() {
                toast('Decision recorded.', 'success');
                enforce.reset();
                document.getElementById('legal-line').hidden = true;
            }).catch(function(error) { toast(fail(error, 'Could not record the decision.'), 'error'); });
        });

        var reverse = document.getElementById('reverse-form');
        reverse.addEventListener('submit', function(e) {
            e.preventDefault();
            K().api('/api/protection/admin/enforcement/' + encodeURIComponent(reverse.elements.id.value.trim()) + '/reverse', {
                method: 'POST', body: { reason: reverse.elements.reason.value.trim() },
            }).then(function() {
                toast('Action reversed.', 'success');
                reverse.reset();
            }).catch(function(error) { toast(fail(error, 'Could not reverse the action.'), 'error'); });
        });

        loadAppeals();
    }

    function loadQueue() {
        var status = document.getElementById('queue-status').value;
        var box = document.getElementById('report-queue');
        K().api('/api/protection/admin/reports' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function(res) {
            var rows = (res.reports || []).map(function(r) {
                return '<tr class="clickable" data-id="' + esc(r.id) + '">' + cell(esc(REPORT_KIND[r.kind] || r.kind)) +
                    cell(esc(REPORT_STATUS[r.status] || r.status)) + cell(esc(r.reporter_name)) +
                    cell(esc(r.accused_name || '—')) + cell(esc(when(r.created_at))) + '</tr>';
            });
            box.innerHTML = table(['Report', 'Status', 'Reporter', 'Accused', 'Filed'], rows);
            box.querySelectorAll('tr.clickable').forEach(function(row) {
                row.addEventListener('click', function() { loadReport(row.dataset.id); });
            });
        }).catch(function(error) { box.innerHTML = notice(fail(error, 'Could not load the queue.'), 'warning'); });
    }

    function loadReport(id) {
        var box = document.getElementById('report-detail');
        K().api('/api/protection/admin/reports/' + encodeURIComponent(id)).then(function(res) {
            var r = res.report;
            var moves = NEXT_STATUS[r.status] || [];
            var history = (res.accused_enforcement_history || []).map(function(h) {
                return '<li>' + esc(ACTION_LABEL[h.action] || h.action) + ' · ' + esc(when(h.created_at)) + ' · ' + esc(h.reason) + '</li>';
            }).join('') || '<li class="muted">None on record</li>';
            var audit = (res.audit || []).map(function(a) {
                return '<li>' + esc(when(a.created_at)) + ' · ' + esc(a.action) + '</li>';
            }).join('') || '<li class="muted">No events yet</li>';
            box.innerHTML = '<div class="card report-detail">' +
                '<h3>' + esc(REPORT_KIND[r.kind] || r.kind) + ' · ' + esc(REPORT_STATUS[r.status] || r.status) + '</h3>' +
                '<p><strong>Reporter:</strong> ' + esc(r.reporter_name) + ' · <strong>Accused:</strong> ' + esc(r.accused_name || '—') + '</p>' +
                '<p><strong>Task:</strong> ' + esc(r.bounty_title || '—') + ' (' + esc(r.bounty_id || '') + ')</p>' +
                '<p><strong>Description</strong></p><p class="pre-wrap">' + esc(r.description) + '</p>' +
                '<p><strong>Evidence</strong></p><p class="pre-wrap">' + esc(r.evidence || 'None supplied') + '</p>' +
                '<p><strong>Accused account history</strong></p><ul>' + history + '</ul>' +
                '<p><strong>Audit trail</strong></p><ul>' + audit + '</ul>' +
                (moves.length
                    ? '<form id="status-form" class="form-grid" novalidate>' +
                      '<label class="field-label">Move to<select name="status">' + moves.map(function(m) {
                          return '<option value="' + m + '">' + esc(REPORT_STATUS[m]) + '</option>';
                      }).join('') + '</select></label>' +
                      '<label class="field-label span-2">Investigation findings (required to close)<textarea name="findings" rows="3" maxlength="4000"></textarea></label>' +
                      '<div class="span-2"><button class="btn btn-primary" type="submit">Save</button></div></form>'
                    : '<p class="small muted">This report is closed.</p>') +
                '</div>';
            var form = document.getElementById('status-form');
            if (form) {
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    K().api('/api/protection/admin/reports/' + encodeURIComponent(id), {
                        method: 'PATCH',
                        body: { status: form.elements.status.value, findings: form.elements.findings.value.trim() || undefined },
                    }).then(function() {
                        toast('Report updated.', 'success');
                        loadQueue();
                        loadReport(id);
                    }).catch(function(error) { toast(fail(error, 'Could not update the report.'), 'error'); });
                });
            }
        }).catch(function(error) { box.innerHTML = notice(fail(error, 'Could not load the report.'), 'warning'); });
    }

    function loadAppeals() {
        var box = document.getElementById('appeal-queue');
        K().api('/api/protection/admin/appeals?status=open').then(function(res) {
            var items = (res.appeals || []).map(function(a) {
                return '<div class="card appeal-item"><p><strong>' + esc(a.user_name) + '</strong> · ' +
                    esc(ACTION_LABEL[a.action] || a.action) + ' · ' + esc(when(a.created_at)) + '</p>' +
                    '<p class="pre-wrap">' + esc(a.statement) + '</p>' +
                    '<form class="appeal-decide" data-id="' + esc(a.id) + '" novalidate>' +
                    '<label class="field-label">Decision<select name="decision"><option value="upheld">Uphold the decision</option>' +
                    '<option value="overturned">Overturn (reverses the action)</option></select></label>' +
                    '<label class="field-label">Note<input name="note" maxlength="4000" required></label>' +
                    '<button class="btn btn-quiet" type="submit">Record decision</button></form></div>';
            });
            box.innerHTML = items.join('') || '<p class="small muted">No open appeals.</p>';
            box.querySelectorAll('.appeal-decide').forEach(function(form) {
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    K().api('/api/protection/admin/appeals/' + encodeURIComponent(form.dataset.id) + '/decide', {
                        method: 'POST',
                        body: { decision: form.elements.decision.value, note: form.elements.note.value.trim() },
                    }).then(function() {
                        toast('Decision recorded.', 'success');
                        loadAppeals();
                    }).catch(function(error) { toast(fail(error, 'Could not record the decision.'), 'error'); });
                });
            });
        }).catch(function(error) { box.innerHTML = notice(fail(error, 'Could not load appeals.'), 'warning'); });
    }

    F.routes.push({
        match: function(r) { return r === 'protection'; },
        render: function() { return protectionPage(); },
    });
})();
