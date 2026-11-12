// Phase 3 screens: availability and opt-in on the profile, practical skill assessments (worker and reviewer),
// recommended tasks, matching candidates for a business, and the team workspace board.
// Loaded after core.js and before bounty.js. Uses window.BountyKit for shared helpers.
(function() {
    'use strict';
    var F = window.BountyFeatures;
    function K() { return window.BountyKit; }
    function esc(v) { return K().escapeHTML(v == null ? '' : String(v)); }
    function app() { return K().app; }
    function when(v) { return v ? K().dateText(v) : '—'; }
    function me() { return K().state.user || {}; }
    function isAdmin() { return Boolean(me().is_admin); }

    function need(role) {
        if (!K().isAuthenticated()) { K().go('auth/login'); return false; }
        var allowed = role === 'admin' ? isAdmin() : (!role || K().getRole() === role);
        if (!allowed) {
            app().innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h3>Not available for this account</h3><p>This page is for ' +
                esc(role === 'admin' ? 'Bounty administrators' : role + ' accounts') + '.</p></div></div></section>';
            return false;
        }
        return true;
    }
    function loading(label) {
        app().innerHTML = '<section class="page"><div class="container"><div class="loading-line"><span class="spinner"></span> ' + esc(label) + '</div></div></section>';
    }
    function fail(error, fallback) {
        app().innerHTML = '<section class="page"><div class="container"><div class="notice warning">' + esc(K().friendlyApiError(error, fallback)) + '</div></div></section>';
    }
    function errorBox(node, error, fallback) {
        node.textContent = K().friendlyApiError(error, fallback);
        node.hidden = false;
    }
    function scoreLabel(score) {
        if (score >= 60) return { text: 'Strong fit', css: 'check-pass' };
        if (score >= 30) return { text: 'Possible fit', css: 'check-possible' };
        return { text: 'Some overlap', css: 'check-possible' };
    }

    var CATEGORIES = [['dev', 'Development'], ['design', 'Design'], ['content', 'Content'], ['marketing', 'Marketing'], ['other', 'Other']];
    var DIFFICULTIES = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];
    var DELIVERABLE_STATUS = {
        planned: ['Planned', 'check-possible'], in_progress: ['In progress', 'check-possible'],
        delivered: ['Delivered for review', 'check-possible'], accepted: ['Accepted', 'check-pass'], blocked: ['Blocked', 'check-fail']
    };
    var VERDICT_LABEL = { met: 'Met', not_met: 'Not met', unclear: 'Unclear' };

    /* ================================================================ profile availability */
    F.mounts.availability = function(container) {
        if (!container || K().getRole() !== 'worker') return;
        var zones = (typeof Intl !== 'undefined' && Intl.supportedValuesOf) ? Intl.supportedValuesOf('timeZone') : ['UTC', 'Europe/London', 'Africa/Lagos', 'America/New_York'];
        container.innerHTML = '<div class="form-card form" id="availability-card"><h2>Availability and matching</h2>' +
            '<p class="small muted">Tell businesses when you can work. Matching uses your time zone, languages, hours and start date. It never uses your location.</p>' +
            '<div class="form-error" id="availability-error" hidden role="alert"></div>' +
            '<div class="field"><label for="av-zone">Time zone</label><select id="av-zone"><option value="">Not set</option>' +
            zones.map(function(z) { return '<option value="' + esc(z) + '">' + esc(z) + '</option>'; }).join('') + '</select></div>' +
            '<div class="field"><label for="av-country">Country</label><select id="av-country"><option value="">Not set</option></select><span class="small muted">Used only for region-specific information and region-limited tasks. Not used for matching.</span></div>' +
            '<div class="field"><label for="av-langs">Languages</label><input id="av-langs" maxlength="400" placeholder="English, French"><span class="small muted">Up to 10, separated by commas.</span></div>' +
            '<div class="field"><label for="av-hours">Hours you can give each week</label><input id="av-hours" type="number" min="0" max="80" step="1" placeholder="Not set"></div>' +
            '<div class="field"><label for="av-from">Available from</label><input id="av-from" type="date"></div>' +
            '<div class="field"><label class="check-label"><input id="av-discoverable" type="checkbox"> Let businesses find me for tasks that match</label>' +
            '<span class="small muted">Off by default. When it is off, no business sees your profile through matching.</span></div>' +
            '<div class="form-actions"><button class="btn btn-primary" id="av-save" type="button">Save availability</button></div></div>';
        var card = container.querySelector('#availability-card');
        K().api('/api/global/regions').then(function(info) {
            var select = card.querySelector('#av-country');
            info.regions.forEach(function(r) { select.insertAdjacentHTML('beforeend', '<option value="' + esc(r.code) + '">' + esc(r.name) + '</option>'); });
            select.value = select.getAttribute('data-current') || '';
        }).catch(function() {});
        K().api('/api/profile/me').then(function(p) {
            card.querySelector('#av-country').setAttribute('data-current', p.country || '');
            var country = card.querySelector('#av-country');
            if (country.options.length > 1) country.value = p.country || '';
            card.querySelector('#av-zone').value = p.timezone || '';
            card.querySelector('#av-langs').value = (p.languages || []).join(', ');
            card.querySelector('#av-hours').value = p.weekly_hours == null ? '' : p.weekly_hours;
            card.querySelector('#av-from').value = p.available_from || '';
            card.querySelector('#av-discoverable').checked = p.discoverable === true;
        }).catch(function(error) { errorBox(card.querySelector('#availability-error'), error, 'Could not load your availability.'); });

        card.querySelector('#av-save').addEventListener('click', function() {
            var box = card.querySelector('#availability-error');
            box.hidden = true;
            var hours = card.querySelector('#av-hours').value.trim();
            var langs = card.querySelector('#av-langs').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
            var body = {
                timezone: card.querySelector('#av-zone').value,
                languages: langs,
                weekly_hours: hours === '' ? null : Number(hours),
                available_from: card.querySelector('#av-from').value || null,
                discoverable: card.querySelector('#av-discoverable').checked,
                country: card.querySelector('#av-country').value || null
            };
            var btn = card.querySelector('#av-save');
            btn.disabled = true;
            K().api('/api/profile/me', { method: 'PATCH', body: body }).then(function() {
                K().toast('Availability saved', 'success');
            }).catch(function(error) {
                errorBox(box, error, 'Could not save your availability.');
            }).then(function() { btn.disabled = false; });
        });
    };

    /* ================================================================ recommended tasks (worker) */
    F.routes.push({
        match: function(r) { return r === 'recommended' || r === 'assessments' || r === 'admin/assessments'; },
        render: function(route) {
            if (route === 'recommended') return recommendedPage();
            if (route === 'assessments') return assessmentsPage();
            return adminAssessmentsPage();
        }
    });

    function recommendedPage() {
        if (!need('worker')) return;
        loading('Finding tasks that fit you…');
        K().api('/api/matching/tasks').then(function(data) {
            var rows = data.results || [];
            var list = rows.length ? '<ul class="list-plain">' + rows.map(function(r) {
                var s = scoreLabel(r.score);
                return '<li class="card-row"><a href="#/bounties/' + esc(r.bounty_id) + '"><strong>' + esc(r.title) + '</strong></a> ' +
                    '<span class="check-pill ' + s.css + '">' + esc(s.text) + '</span>' +
                    '<p class="small muted">' + esc(r.category) + ' · Deadline ' + esc(when(r.deadline)) + '</p>' +
                    '<ul class="small">' + (r.reasons || []).map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></li>';
            }).join('') + '</ul>' :
                '<div class="empty-state"><h3>No recommendations yet</h3><p>Add categories, skills and availability to your profile to see tasks that fit you.</p><a class="btn" href="#/profile">Update your profile</a></div>';
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<div class="page-head"><div><p class="eyebrow">For you</p><h1>Recommended tasks</h1></div></div>' +
                '<p class="muted">Each suggestion explains why it fits. Matching uses your categories, skills, verified assessments, past reputation, availability and time zone. It never uses your location. Suggestions are not offers.</p>' +
                list + '</div></section>';
        }).catch(function(error) { fail(error, 'Could not load recommendations.'); });
    }

    /* ================================================================ assessments (worker) */
    function assessmentsPage() {
        if (!need('worker')) return;
        loading('Loading skill checks…');
        Promise.all([K().api('/api/assessments'), K().api('/api/assessments/mine')]).then(function(res) {
            var catalogue = res[0] || [];
            var attempts = res[1] || [];
            var cards = catalogue.length ? catalogue.map(function(a) { return assessmentCard(a, attempts); }).join('') :
                '<div class="empty-state"><h3>No skill checks are open right now</h3><p>New checks appear here when they are published.</p></div>';
            app().innerHTML = '<section class="page"><div class="container narrow">' +
                '<div class="page-head"><div><p class="eyebrow">Proof of ability</p><h1>Skill checks</h1></div></div>' +
                '<p class="muted">These checks are optional. You do the work, and a qualified reviewer decides whether it meets the stated points. A verified result shows on your public profile. It is not a certificate, and it does not guarantee any task.</p>' +
                '<div id="assessment-list">' + cards + '</div></div></section>';
            bindAssessments(app());
        }).catch(function(error) { fail(error, 'Could not load skill checks.'); });
    }

    function assessmentCard(a, attempts) {
        var mineList = attempts.filter(function(x) { return x.assessment_id === a.id; });
        var open = mineList.filter(function(x) { return x.status === 'in_progress' || x.status === 'submitted'; })[0];
        var last = mineList[0];
        var rubric = (a.rubric || []).map(function(p) { return '<li>' + esc(p.text) + ' <span class="small muted">(' + esc(p.points) + ' points)</span></li>'; }).join('');
        var state = '';
        if (a.my_status === 'verified') state = '<span class="check-pill check-pass">Verified ' + esc(when(last && last.reviewed_at)) + '</span>';
        else if (open && open.status === 'submitted') state = '<span class="check-pill check-possible">Awaiting review</span>';
        else if (a.cooldown_until) state = '<span class="check-pill check-fail">Try again after ' + esc(when(a.cooldown_until)) + '</span>';
        var notes = (last && last.status === 'not_verified' && last.reviewer_notes) ? '<p class="small"><strong>Reviewer notes:</strong> ' + esc(last.reviewer_notes) + '</p>' : '';
        var action = '';
        if (a.my_status === 'verified' || (open && open.status === 'submitted') || a.cooldown_until) action = '';
        else if (open && open.status === 'in_progress') {
            action = '<form class="form assessment-submit" data-attempt="' + esc(open.id) + '">' +
                '<div class="field"><label for="work-' + esc(open.id) + '">Your work</label><textarea id="work-' + esc(open.id) + '" rows="5" maxlength="5000" required placeholder="Describe what you did and how it meets each point"></textarea></div>' +
                '<div class="field"><label for="link-' + esc(open.id) + '">Link to the work (optional, https)</label><input id="link-' + esc(open.id) + '" type="url" maxlength="255" placeholder="https://"></div>' +
                '<div class="form-error" hidden role="alert"></div>' +
                '<div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Submit for review</button></div></form>';
        } else {
            action = '<button class="btn btn-sm" type="button" data-start="' + esc(a.id) + '">Start this check</button>';
        }
        return '<article class="card-row assessment-card" data-assessment="' + esc(a.id) + '">' +
            '<div class="card-head"><div><h2 class="h4">' + esc(a.title) + '</h2><p class="small muted">' + esc(a.category) + ' · ' + esc(a.difficulty) + '</p></div>' + state + '</div>' +
            '<p>' + esc(a.description) + '</p>' +
            '<details><summary>Scoring points and instructions</summary><p class="small">' + esc(a.instructions) + '</p>' +
            '<p class="small"><strong>What to submit:</strong> ' + esc(a.submission_requirements) + '</p><ul class="small">' + rubric + '</ul></details>' +
            notes + action + '<div class="form-error" data-error hidden role="alert"></div></article>';
    }

    function bindAssessments(root) {
        root.onclick = function(event) {
            var btn = event.target.closest('[data-start]');
            if (!btn) return;
            btn.disabled = true;
            K().api('/api/assessments/' + encodeURIComponent(btn.getAttribute('data-start')) + '/start', { method: 'POST' })
                .then(function() { K().toast('Check started', 'success'); assessmentsPage(); })
                .catch(function(error) { btn.disabled = false; errorBox(btn.parentNode.querySelector('[data-error]'), error, 'Could not start this check.'); });
        };
        root.onsubmit = function(event) {
            var form = event.target.closest('.assessment-submit');
            if (!form) return;
            event.preventDefault();
            var box = form.querySelector('.form-error');
            box.hidden = true;
            var work = form.querySelector('textarea').value.trim();
            var link = form.querySelector('input').value.trim();
            if (work.length < 50) { errorBox(box, { message: 'Describe your work in at least 50 characters.' }, ''); return; }
            if (link && !/^https:\/\//i.test(link)) { errorBox(box, { message: 'The link must start with https://' }, ''); return; }
            var body = { submission_text: work };
            if (link) body.submission_link = link;
            K().api('/api/assessments/attempts/' + encodeURIComponent(form.getAttribute('data-attempt')) + '/submit', { method: 'POST', body: body })
                .then(function() { K().toast('Submitted for review', 'success'); assessmentsPage(); })
                .catch(function(error) { errorBox(box, error, 'Could not submit your work.'); });
        };
    }

    /* ================================================================ assessments (administrator) */
    function adminAssessmentsPage() {
        if (!need('admin')) return;
        loading('Loading the review queue…');
        Promise.all([K().api('/api/assessments/review'), K().api('/api/assessments')]).then(function(res) {
            var queue = res[0] || [];
            var active = res[1] || [];
            app().innerHTML = '<section class="page"><div class="container">' +
                '<div class="page-head"><div><p class="eyebrow">Administrator</p><h1>Skill checks</h1></div></div>' +
                '<div class="form-layout">' +
                '<div><h2>Review queue (' + queue.length + ')</h2>' +
                '<p class="small muted">The pre-check is advisory. It marks each point as met, not met or unclear, and it is never a result. Only your decision verifies a worker.</p>' +
                (queue.length ? queue.map(reviewCard).join('') : '<div class="empty-state"><h3>Nothing waiting</h3><p>Submitted checks appear here.</p></div>') + '</div>' +
                '<div><h2>New check</h2>' + createForm() + '<h2 class="h4">Active checks</h2>' +
                (active.length ? '<ul class="list-plain">' + active.map(function(a) {
                    return '<li class="card-row">' + esc(a.title) + ' <span class="small muted">' + esc(a.category) + '</span> <button class="btn btn-sm" type="button" data-deactivate="' + esc(a.id) + '">Deactivate</button></li>';
                }).join('') + '</ul>' : '<p class="small muted">No active checks.</p>') +
                '</div></div></div></section>';
            bindAdmin(app());
        }).catch(function(error) { fail(error, 'Could not load the review queue.'); });
    }

    function reviewCard(item) {
        var rubricText = {};
        (item.rubric || []).forEach(function(p, i) { rubricText['r' + (i + 1)] = p.text; });
        var pre = item.ai_prescore && item.ai_prescore.items ? item.ai_prescore.items : [];
        var preHtml = pre.length ? '<ul class="small">' + pre.map(function(v) {
            return '<li><strong>' + esc(VERDICT_LABEL[v.verdict] || v.verdict) + ':</strong> ' + esc(rubricText[v.point_id] || v.point_id) + ' — ' + esc(v.explanation || '') + '</li>';
        }).join('') + '</ul>' : '<p class="small muted">No pre-check was available for this submission.</p>';
        return '<article class="card-row review-card" data-attempt="' + esc(item.id) + '">' +
            '<h3 class="h4">' + esc(item.title) + '</h3><p class="small muted">' + esc(item.worker_name) + ' · submitted ' + esc(when(item.submitted_at)) + '</p>' +
            '<p class="pre-wrap">' + esc(item.submission_text) + '</p>' +
            (item.submission_link ? '<p class="small"><a class="inline-link" href="' + esc(item.submission_link) + '" target="_blank" rel="noopener noreferrer">Open the linked work</a></p>' : '') +
            '<details><summary>Advisory pre-check</summary>' + preHtml + '</details>' +
            '<form class="form review-form">' +
            '<fieldset class="field"><legend>Decision</legend><label><input type="radio" name="decision-' + esc(item.id) + '" value="verified" required> Verified</label> ' +
            '<label><input type="radio" name="decision-' + esc(item.id) + '" value="not_verified"> Not verified</label></fieldset>' +
            '<div class="field"><label for="score-' + esc(item.id) + '">Score (0–100)</label><input id="score-' + esc(item.id) + '" type="number" min="0" max="100" step="1" required></div>' +
            '<div class="field"><label for="notes-' + esc(item.id) + '">Notes for the worker</label><textarea id="notes-' + esc(item.id) + '" rows="3" maxlength="1000" required placeholder="Say which points were met and why"></textarea></div>' +
            '<div class="form-error" hidden role="alert"></div>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Record decision</button></div></form></article>';
    }

    function createForm() {
        var rows = '';
        for (var i = 0; i < 2; i++) rows += rubricRow();
        return '<form id="assessment-create" class="form-card form">' +
            '<div class="form-error" id="create-error" hidden role="alert"></div>' +
            '<div class="field"><label for="ac-category">Category</label><select id="ac-category">' + CATEGORIES.map(function(c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select></div>' +
            '<div class="field"><label for="ac-difficulty">Difficulty</label><select id="ac-difficulty">' + DIFFICULTIES.map(function(d) { return '<option value="' + d[0] + '">' + d[1] + '</option>'; }).join('') + '</select></div>' +
            '<div class="field"><label for="ac-title">Title</label><input id="ac-title" maxlength="160" required></div>' +
            '<div class="field"><label for="ac-description">Description</label><textarea id="ac-description" rows="2" maxlength="2000" required></textarea></div>' +
            '<div class="field"><label for="ac-instructions">Instructions</label><textarea id="ac-instructions" rows="4" maxlength="5000" required></textarea></div>' +
            '<div class="field"><label for="ac-requirements">What to submit</label><textarea id="ac-requirements" rows="2" maxlength="2000" required></textarea></div>' +
            '<fieldset class="field"><legend>Scoring points (2–12 points, totalling 10–100)</legend><div id="ac-rubric">' + rows + '</div>' +
            '<p class="small muted">Total: <span id="ac-total">0</span></p><button class="btn btn-sm" type="button" id="ac-add">Add a point</button></fieldset>' +
            '<div class="form-actions"><button class="btn btn-primary" type="submit">Publish check</button></div></form>';
    }

    function rubricRow() {
        return '<div class="rubric-row ac-row"><input class="ac-text" maxlength="300" placeholder="A point the submission must meet" aria-label="Scoring point"> ' +
            '<input class="ac-points" type="number" min="1" max="50" step="1" value="50" aria-label="Points"> <button type="button" class="btn btn-sm ac-remove" aria-label="Remove point">Remove</button></div>';
    }

    function rubricTotal(form) {
        var total = 0;
        form.querySelectorAll('.ac-points').forEach(function(n) { total += Number(n.value) || 0; });
        form.querySelector('#ac-total').textContent = total;
    }

    function bindAdmin(root) {
        var create = root.querySelector('#assessment-create');
        create.querySelector('#ac-add').addEventListener('click', function() {
            if (create.querySelectorAll('.ac-row').length >= 12) return;
            create.querySelector('#ac-rubric').insertAdjacentHTML('beforeend', rubricRow());
            rubricTotal(create);
        });
        create.addEventListener('click', function(event) {
            var rm = event.target.closest('.ac-remove');
            if (!rm) return;
            if (create.querySelectorAll('.ac-row').length <= 2) return;
            rm.closest('.ac-row').remove();
            rubricTotal(create);
        });
        create.addEventListener('input', function() { rubricTotal(create); });
        rubricTotal(create);

        create.addEventListener('submit', function(event) {
            event.preventDefault();
            var box = create.querySelector('#create-error');
            box.hidden = true;
            var rubric = Array.from(create.querySelectorAll('.ac-row')).map(function(row) {
                return { text: row.querySelector('.ac-text').value.trim(), points: Number(row.querySelector('.ac-points').value) };
            });
            var body = {
                category: create.querySelector('#ac-category').value,
                difficulty: create.querySelector('#ac-difficulty').value,
                title: create.querySelector('#ac-title').value.trim(),
                description: create.querySelector('#ac-description').value.trim(),
                instructions: create.querySelector('#ac-instructions').value.trim(),
                submission_requirements: create.querySelector('#ac-requirements').value.trim(),
                rubric: rubric
            };
            K().api('/api/assessments', { method: 'POST', body: body }).then(function() {
                K().toast('Check published', 'success');
                adminAssessmentsPage();
            }).catch(function(error) { errorBox(box, error, 'Could not publish this check.'); });
        });

        root.onsubmit = function(event) {
            var form = event.target.closest('.review-form');
            if (!form) return;
            event.preventDefault();
            var card = form.closest('.review-card');
            var box = form.querySelector('.form-error');
            box.hidden = true;
            var decision = form.querySelector('input[type=radio]:checked');
            var body = {
                decision: decision ? decision.value : '',
                score: Number(form.querySelector('input[type=number]').value),
                notes: form.querySelector('textarea').value.trim()
            };
            K().api('/api/assessments/attempts/' + encodeURIComponent(card.getAttribute('data-attempt')) + '/review', { method: 'POST', body: body })
                .then(function() { K().toast('Decision recorded', 'success'); card.remove(); })
                .catch(function(error) { errorBox(box, error, 'Could not record this decision.'); });
        };

        root.onclick = function(event) {
            var btn = event.target.closest('[data-deactivate]');
            if (!btn) return;
            K().api('/api/assessments/' + encodeURIComponent(btn.getAttribute('data-deactivate')), { method: 'PATCH', body: { active: false } })
                .then(function() { K().toast('Check deactivated', 'success'); adminAssessmentsPage(); })
                .catch(function(error) { K().toast(K().friendlyApiError(error, 'Could not deactivate this check.'), 'error'); });
        };
    }

    /* ================================================================ matching candidates (business) */
    F.mounts.matchingPanel = function(container, bounty) {
        if (!container || !bounty) return;
        container.innerHTML = '<h2>Matching candidates</h2><p class="small muted">Only workers who have chosen to be discoverable are ranked here. Each result explains its fit. A match is a suggestion, not an invitation.</p><div class="loading-line"><span class="spinner"></span> Ranking candidates…</div>';
        K().api('/api/matching/tasks/' + encodeURIComponent(bounty.id)).then(function(data) {
            var rows = data.results || [];
            container.innerHTML = '<h2>Matching candidates</h2><p class="small muted">Only workers who have chosen to be discoverable are ranked here. Each result explains its fit. A match is a suggestion, not an invitation.</p>' +
                (rows.length ? '<ul class="list-plain">' + rows.map(function(r) {
                    var s = scoreLabel(r.score);
                    return '<li class="card-row"><a class="inline-link" href="#/worker/' + esc(r.worker_id) + '"><strong>' + esc(r.name) + '</strong></a> <span class="check-pill ' + s.css + '">' + esc(s.text) + '</span>' +
                        '<ul class="small">' + (r.reasons || []).map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></li>';
                }).join('') + '</ul>' : '<div class="empty-state"><h3>No candidates yet</h3><p>Workers appear here once they opt in and their profile fits this task.</p></div>');
        }).catch(function(error) {
            container.innerHTML = '<h2>Matching candidates</h2><div class="notice warning">' + esc(K().friendlyApiError(error, 'Could not load candidates.')) + '</div>';
        });
    };

    /* ================================================================ team workspace board */
    F.mounts.workspaceBoard = function(container, bounty) {
        if (!container || !bounty) return;
        container.innerHTML = '<div class="loading-line"><span class="spinner"></span> Loading the workspace…</div>';
        load();

        function load() {
            K().api('/api/workspace/' + encodeURIComponent(bounty.id)).then(render).catch(function(error) {
                if (error.status === 403 || error.status === 404) { container.remove(); return; }
                container.innerHTML = '<div class="notice warning">' + esc(K().friendlyApiError(error, 'Could not load the workspace.')) + '</div>';
            });
        }

        function render(data) {
            var role = data.role;
            var p = data.progress;
            var byId = {};
            data.deliverables.forEach(function(d) { byId[d.id] = d; });
            var items = data.deliverables.length ? data.deliverables.map(function(d) { return item(d, role, byId); }).join('') :
                '<p class="small muted">No deliverables yet.' + (role === 'business' ? ' Break the work into parts so each part can be tracked.' : '') + '</p>';
            container.innerHTML = '<h2>Deliverables</h2>' +
                '<p class="small muted">Visible only to the business and the people on this task.</p>' +
                '<div class="progress-summary" role="status"><strong>' + p.accepted + ' of ' + p.total + ' accepted</strong> (' + p.percent + '%)' +
                (p.blocked ? ' · <span class="check-pill check-fail">' + p.blocked + ' blocked</span>' : '') + '</div>' +
                '<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p.percent + '"><span style="width:' + p.percent + '%"></span></div>' +
                '<ul class="list-plain deliverables">' + items + '</ul>' +
                (role === 'business' ? addForm(data.deliverables) : '') +
                '<details class="timeline-box"><summary>Timeline</summary><div class="timeline-body"><p class="small muted">Loading…</p></div></details>' +
                '<div class="form-error" data-board-error hidden role="alert"></div>';
            bind(role);
        }

        function item(d, role, byId) {
            var st = DELIVERABLE_STATUS[d.status] || [d.status, 'check-possible'];
            var mine = String(d.worker_id || '') === String(me().id);
            var notes = [];
            if (d.depends_on && !d.dependency_met) {
                var dep = byId[d.depends_on];
                notes.push('Waiting for "' + esc(dep ? dep.title : 'a previous deliverable') + '" to be accepted.');
            }
            if (d.blocked_reason) notes.push('Blocked: ' + esc(d.blocked_reason));
            var actions = '';
            if (role === 'participant') {
                if (d.status === 'planned' && (!d.worker_id || mine)) actions += btn('start', d.id, 'Claim and start');
                if (d.status === 'in_progress' && mine) actions += btn('deliver', d.id, 'Deliver') + btn('block', d.id, 'Mark blocked');
                if (d.status === 'blocked' && mine) actions += btn('resume', d.id, 'Resume');
            } else {
                if (d.status === 'delivered') actions += btn('accept', d.id, 'Accept') + btn('changes', d.id, 'Request changes');
            }
            return '<li class="card-row deliverable" data-id="' + esc(d.id) + '">' +
                '<div class="card-head"><div><strong>' + esc(d.title) + '</strong>' + (d.component ? ' <span class="small muted">' + esc(d.component) + '</span>' : '') + '</div>' +
                '<span class="check-pill ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
                (d.description ? '<p class="small">' + esc(d.description) + '</p>' : '') +
                '<p class="small muted">' + (d.worker_name ? 'Assigned to ' + esc(d.worker_name) : 'Unassigned') + (d.due_at ? ' · Due ' + esc(when(d.due_at)) : '') + '</p>' +
                (d.link ? '<p class="small"><a class="inline-link" href="' + esc(d.link) + '" target="_blank" rel="noopener noreferrer">Delivered link</a></p>' : '') +
                notes.map(function(n) { return '<p class="small">' + n + '</p>'; }).join('') +
                (actions ? '<div class="form-actions">' + actions + '</div>' : '') +
                '<div class="action-slot"></div></li>';
        }

        function btn(action, id, label) {
            return '<button class="btn btn-sm" type="button" data-action="' + action + '" data-id="' + esc(id) + '">' + esc(label) + '</button> ';
        }

        function addForm(list) {
            var options = list.map(function(d) { return '<option value="' + esc(d.id) + '">' + esc(d.title) + '</option>'; }).join('');
            return '<form id="deliverable-form" class="form-card form"><h3 class="h4">Add a deliverable</h3>' +
                '<div class="field"><label for="dv-title">Title</label><input id="dv-title" maxlength="160" required></div>' +
                '<div class="field"><label for="dv-component">Component (optional)</label><input id="dv-component" maxlength="160"></div>' +
                '<div class="field"><label for="dv-description">Description</label><textarea id="dv-description" rows="2" maxlength="1000"></textarea></div>' +
                '<div class="field"><label for="dv-due">Due date (optional)</label><input id="dv-due" type="date"></div>' +
                (list.length ? '<div class="field"><label for="dv-depends">Starts after (optional)</label><select id="dv-depends"><option value="">Nothing</option>' + options + '</select></div>' : '') +
                '<div class="form-error" hidden role="alert"></div>' +
                '<div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Add deliverable</button></div></form>';
        }

        function bind(role) {
            container.onclick = function(event) {
                var b = event.target.closest('[data-action]');
                if (b) { openAction(b); return; }
                var t = event.target.closest('details.timeline-box summary');
                if (t) loadTimeline();
            };
            container.onsubmit = function(event) {
                if (event.target.id === 'deliverable-form') { event.preventDefault(); addDeliverable(event.target); return; }
                if (event.target.classList.contains('action-form')) { event.preventDefault(); submitAction(event.target); }
            };
        }

        function openAction(b) {
            var card = b.closest('.deliverable');
            var slot = card.querySelector('.action-slot');
            var action = b.getAttribute('data-action');
            var id = b.getAttribute('data-id');
            if (action === 'accept' || action === 'start' || action === 'resume' || action === 'changes') {
                send(id, { status: { accept: 'accepted', start: 'in_progress', resume: 'in_progress', changes: 'in_progress' }[action] }, action === 'accept' ? 'Accepted' : 'Updated');
                return;
            }
            var label = action === 'deliver' ? 'Link to the work (optional, https)' : 'What is blocking this?';
            var field = action === 'deliver' ?
                '<div class="field"><label>' + label + '</label><input name="link" type="url" maxlength="255" placeholder="https://"></div>' :
                '<div class="field"><label>' + label + '</label><textarea name="reason" rows="2" maxlength="500" required></textarea></div>';
            slot.innerHTML = '<form class="form action-form" data-id="' + esc(id) + '" data-kind="' + action + '">' + field +
                '<div class="form-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">' + (action === 'deliver' ? 'Send for review' : 'Save') + '</button></div></form>';
        }

        function submitAction(form) {
            var kind = form.getAttribute('data-kind');
            var box = form.querySelector('.form-error');
            box.hidden = true;
            var body;
            if (kind === 'deliver') {
                var link = form.querySelector('input').value.trim();
                if (link && !/^https:\/\//i.test(link)) { errorBox(box, { message: 'The link must start with https://' }, ''); return; }
                body = { status: 'delivered' };
                if (link) body.link = link;
            } else {
                var reason = form.querySelector('textarea').value.trim();
                if (reason.length < 5) { errorBox(box, { message: 'Say what is blocking this, in at least 5 characters.' }, ''); return; }
                body = { status: 'blocked', blocked_reason: reason };
            }
            send(form.getAttribute('data-id'), body, kind === 'deliver' ? 'Sent for review' : 'Marked blocked', box);
        }

        function send(id, body, message, box) {
            K().api('/api/workspace/deliverables/' + encodeURIComponent(id), { method: 'PATCH', body: body }).then(function() {
                K().toast(message, 'success');
                load();
            }).catch(function(error) {
                if (box) errorBox(box, error, 'Could not update this deliverable.');
                else K().toast(K().friendlyApiError(error, 'Could not update this deliverable.'), 'error');
            });
        }

        function addDeliverable(form) {
            var box = form.querySelector('.form-error');
            box.hidden = true;
            var body = {
                title: form.querySelector('#dv-title').value.trim(),
                component: form.querySelector('#dv-component').value.trim(),
                description: form.querySelector('#dv-description').value.trim()
            };
            var due = form.querySelector('#dv-due').value;
            if (due) body.due_at = due;
            var depends = form.querySelector('#dv-depends');
            if (depends && depends.value) body.depends_on = depends.value;
            K().api('/api/workspace/' + encodeURIComponent(bounty.id), { method: 'POST', body: body }).then(function() {
                K().toast('Deliverable added', 'success');
                load();
            }).catch(function(error) { errorBox(box, error, 'Could not add this deliverable.'); });
        }

        function loadTimeline() {
            var body = container.querySelector('.timeline-body');
            if (body.getAttribute('data-loaded')) return;
            body.setAttribute('data-loaded', '1');
            K().api('/api/workspace/' + encodeURIComponent(bounty.id) + '/timeline').then(function(rows) {
                body.innerHTML = rows.length ? '<ol class="small timeline">' + rows.map(function(e) {
                    return '<li>' + esc(when(e.created_at)) + ' · ' + esc(e.actor_name || 'System') + ' · ' + esc(describe(e)) + '</li>';
                }).join('') + '</ol>' : '<p class="small muted">No changes yet.</p>';
            }).catch(function(error) { body.innerHTML = '<p class="small">' + esc(K().friendlyApiError(error, 'Could not load the timeline.')) + '</p>'; });
        }

        function describe(e) {
            if (e.event === 'created') return 'Added "' + (e.deliverable_title || '') + '"';
            if (e.event === 'status_changed') return (e.deliverable_title || 'Deliverable') + ': ' + ((DELIVERABLE_STATUS[e.detail.from] || [e.detail.from])[0]) + ' → ' + ((DELIVERABLE_STATUS[e.detail.to] || [e.detail.to])[0]);
            if (e.event === 'edited') return (e.deliverable_title || 'Deliverable') + ' edited';
            return e.event;
        }
    };

})();
