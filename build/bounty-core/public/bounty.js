/* Bounty frontend: vanilla JS, hash routing, Express API. */
(function() {
    'use strict';

    var API_BASE = String(window.BOUNTY_API_BASE || window.location.origin).replace(/\/$/, '');
    var TOKEN_KEY = 'bounty_token';
    var USER_KEY = 'bounty_user';
    var THEME_KEY = 'bounty_theme';

    // Three modes: 'system' (default — follows OS prefers-color-scheme),
    // 'light' and 'dark' (explicit, persisted to localStorage).
    var THEME_MODES = {
        system: { label: 'System', description: 'Match my device', icon: 'monitor' },
        light:  { label: 'Light',  description: 'Always light',   icon: 'sun' },
        dark:   { label: 'Dark',   description: 'Always dark',    icon: 'moon' }
    };

    var state = {
        user: readJSON(USER_KEY),
        token: '',
        themeMode: 'system',
        themeMenu: false,
        mobileMenu: false,
        bountyPage: 1,
        bountyLimit: 9,
        category: 'all',
        difficulty: 'all',
        search: '',
        sort: 'newest'
    };

    var app = document.getElementById('app');
    var header = document.getElementById('hdr');
    var footer = document.getElementById('footer');
    var toastNode = document.getElementById('toast');

    function $(selector, root) {
        return (root || document).querySelector(selector);
    }

    function $$(selector, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    }

    function on(element, eventName, handler) {
        if (element) element.addEventListener(eventName, handler);
    }

    function nz(value, fallback) {
        return value === null || value === undefined ? fallback : value;
    }

    function readJSON(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
    }

    function escapeHTML(value) {
        return String(nz(value, '')).replace(/[&<>"']/g, function(char) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
        });
    }

    function icon(name, size) {
        size = size || 20;
        var common = 'width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
        var paths = {
            sparkles: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z"/>',
            sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
            moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"/>',
            monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
            menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
            close: '<path d="m18 6-12 12M6 6l12 12"/>',
            arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
            search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
            code: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14"/>',
            palette: '<path d="M12 3a9 9 0 0 0 0 18h1.2a2 2 0 0 0 1.4-3.4 1.8 1.8 0 0 1 1.3-3.1H18a3 3 0 0 0 3-3C21 6.8 17 3 12 3Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="10" cy="6.8" r=".8"/><circle cx="15" cy="7.2" r=".8"/>',
            globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
            shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
            clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
            logout: '<path d="M10 17l5-5-5-5m5 5H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
            plus: '<path d="M12 5v14M5 12h14"/>',
            file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
            arrowLeft: '<path d="M19 12H5m7 7-7-7 7-7"/>',
            alert: '<path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
            bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'
        };
        return '<svg ' + common + '>' + (paths[name] || paths.sparkles) + '</svg>';
    }

    function currentRoute() {
        return (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
    }

    function go(route, replace) {
        var target = '#/' + route.replace(/^\//, '');
        if (location.hash === target) render();
        else if (replace) location.replace(target);
        else location.hash = target;
    }

    // The session itself is an HttpOnly cookie that scripts cannot read. This in-memory token is
    // only used for API clients; the browser sends the cookie on its own.
    function getToken() {
        return state.token || '';
    }

    function setSession(user, token) {
        state.user = user || null;
        state.token = token || '';
        if (state.user) localStorage.setItem(USER_KEY, JSON.stringify(state.user));
        else localStorage.removeItem(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
        renderHeader();
    }

    function isAuthenticated() {
        // The server checks the session cookie on every request. This only decides what to show.
        return Boolean(state.user && state.user.id);
    }

    function requireAuth(route) {
        if (isAuthenticated()) return true;
        sessionStorage.setItem('bounty_after_auth', route || 'bounties');
        go('auth/login');
        toast('Sign in to explore Bounty opportunities.');
        return false;
    }

    function toast(message, type) {
        toastNode.textContent = message;
        toastNode.className = ('toast ' + (type || '')).trim();
        toastNode.hidden = false;
        clearTimeout(toastNode._timer);
        toastNode._timer = setTimeout(function() { toastNode.hidden = true; }, 3600);
    }

    function api(path, options) {
        options = options || {};
        var headers = new Headers(options.headers || {});
        var isFormData = options.body instanceof FormData;
        var hasJsonBody = options.body && !isFormData && typeof options.body !== 'string';

        if (hasJsonBody || typeof options.body === 'string') headers.set('Content-Type', 'application/json');
        if (getToken() && options.auth !== false) headers.set('Authorization', 'Bearer ' + getToken());

        return fetch(API_BASE + path, {
            method: options.method || 'GET',
            headers: headers,
            body: hasJsonBody ? JSON.stringify(options.body) : options.body
        }).then(function(response) {
            return response.text().then(function(text) {
                var data = null;
                try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { message: text }; }

                // 428 = an agreement must be accepted first. Show it, record the acceptance, retry once.
                if (response.status === 428 && data && data.code && !options._agreed) {
                    return requireAgreement(data).then(function() {
                        return api(path, Object.assign({}, options, { _agreed: true }));
                    });
                }

                if (!response.ok) {
                    if (response.status === 401 && options.auth !== false) {
                        var route = currentRoute();
                        setSession(null, '');
                        sessionStorage.setItem('bounty_after_auth', route);
                        if (route.indexOf('auth/') !== 0) go('auth/login');
                    }
                    var message = (data && data.message) || (data && data.error) ||
                        (data && data.errors && data.errors.join ? data.errors.join(', ') : '') ||
                        ('Request failed (' + response.status + ')');
                    var error = new Error(message);
                    error.status = response.status;
                    error.data = data;
                    throw error;
                }
                return data;
            });
        });
    }

    // Shows an agreement or NDA the server requires. Text is inserted with textContent only.
    // Resolves once the acceptance is recorded; rejects if the person declines.
    function requireAgreement(data) {
        return new Promise(function(resolve, reject) {
            var overlay = document.createElement('div');
            overlay.className = 'agreement-overlay';
            var dialog = document.createElement('div');
            dialog.className = 'card agreement-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');

            var heading = document.createElement('h2');
            heading.textContent = data.title || 'Agreement';

            var text = document.createElement('pre');
            text.className = 'agreement-text';
            text.textContent = data.body || '';

            var label = document.createElement('label');
            label.className = 'agreement-check';
            var box = document.createElement('input');
            box.type = 'checkbox';
            var boxText = document.createElement('span');
            boxText.textContent = 'I have read this agreement and I accept it.';
            label.appendChild(box);
            label.appendChild(boxText);

            var error = document.createElement('p');
            error.className = 'field-hint agreement-error';
            error.hidden = true;

            var actions = document.createElement('div');
            actions.className = 'agreement-actions';
            var cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'btn btn-quiet';
            cancel.textContent = 'Cancel';
            var accept = document.createElement('button');
            accept.type = 'button';
            accept.className = 'btn btn-primary';
            accept.textContent = 'Accept and continue';
            actions.appendChild(cancel);
            actions.appendChild(accept);

            dialog.appendChild(heading);
            dialog.appendChild(text);
            dialog.appendChild(label);
            dialog.appendChild(error);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            function close() { overlay.remove(); }

            cancel.addEventListener('click', function() {
                close();
                reject(new Error('You need to accept this agreement to continue.'));
            });
            accept.addEventListener('click', function() {
                if (!box.checked) {
                    error.textContent = 'Tick the box to confirm you accept.';
                    error.hidden = false;
                    return;
                }
                accept.disabled = true;
                var payload = { kind: data.kind };
                if (data.bounty_id) payload.bounty_id = data.bounty_id;
                api('/api/protection/agreements/accept', { method: 'POST', body: payload }).then(function() {
                    close();
                    resolve();
                }).catch(function(err) {
                    accept.disabled = false;
                    error.textContent = err.message;
                    error.hidden = false;
                });
            });
            box.focus();
        });
    }

    function normalizeUser(data) {
        var user = (data && data.user) || (data && data.data && data.data.user) || (data && data.data) || data || {};
        var token = (data && data.token) || (data && data.accessToken) || (data && data.access_token) || user.token || '';
        var name = user.name || user.full_name || (user.email ? user.email.split('@')[0] : '') || 'Member';
        return {
            user: { id: user.id || user.user_id, email: user.email, name: name, role: user.role, is_admin: user.is_admin === true },
            token: token
        };
    }

    function categoryLabel(value) {
        var labels = { dev: 'Development', design: 'Design', content: 'Content', marketing: 'Marketing', other: 'Other' };
        return labels[String(value || '').toLowerCase()] || titleCase(value || 'General');
    }

    function titleCase(value) {
        return String(value || '').replace(/[_-]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    function difficultyClass(value) {
        var v = String(value || '').toLowerCase();
        return ['easy', 'medium', 'hard'].indexOf(v) !== -1 ? v : 'medium';
    }

    function statusClass(value) {
        return String(value || '').toLowerCase().replace(/[^a-z_]/g, '');
    }

    function money(value, currency) {
        currency = currency || 'NGN';
        var amount = Number(value);
        if (!isFinite(amount)) return 'Reward TBD';
        try {
            return new Intl.NumberFormat('en-NG', { style: 'currency', currency: currency, maximumFractionDigits: 2 }).format(amount);
        } catch (e) {
            return currency + ' ' + amount.toLocaleString();
        }
    }

    function dateText(value) {
        if (!value) return 'No deadline set';
        var d = new Date(value);
        if (isNaN(d.getTime())) return String(value);
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function daysLeft(value) {
        if (!value) return 'No deadline';
        var days = Math.ceil((new Date(value).getTime() - Date.now()) / 86400000);
        if (!isFinite(days)) return 'Deadline not set';
        if (days < 0) return 'Deadline passed';
        if (days === 0) return 'Due today';
        if (days === 1) return '1 day left';
        return days + ' days left';
    }

    function workerSlotsText(b) {
        var taken = Number(b.participants_count || 0);
        var max = Number(b.max_workers || 3);
        if (taken >= max) return 'All ' + max + ' worker slots taken';
        return taken + ' of ' + max + ' workers';
    }

    function safeLink(value) {
        try {
            var u = new URL(value);
            return (u.protocol === 'http:' || u.protocol === 'https:') ? escapeHTML(u.href) : '';
        } catch (e) {
            return '';
        }
    }

    function normalizeBounties(data) {
        if (Array.isArray(data)) return data;
        if (data && data.bounties) return data.bounties;
        if (data && data.data && data.data.bounties) return data.data.bounties;
        if (data && data.data) return data.data;
        return [];
    }

    function getRole() {
        return String((state.user && state.user.role) || '').toLowerCase();
    }

    function headerLink(route, label) {
        var active = currentRoute() === route || (route === 'bounties' && currentRoute().indexOf('bounties') === 0);
        return '<a href="#/' + route + '" ' + (active ? 'aria-current="page"' : '') + '>' + label + '</a>';
    }

    /* ============ THEMES ============ */

    function normalizeThemeMode(value) {
        return (value === 'light' || value === 'dark' || value === 'system') ? value : 'system';
    }

    // Keeps compatibility with older code that calls normalizeTheme.
    function normalizeTheme(value) { return normalizeThemeMode(value); }

    function bellHTML() {
        var notes = state.notifications || [];
        var unread = notes.filter(function(n) { return !n.read_at; }).length;
        return '<button class="icon-button ux-rel" id="bell-btn" type="button" aria-label="Notifications, ' + unread + ' unread">' +
            icon('bell', 20) +
            (unread ? '<span class="ux-bell-count">' + unread + '</span>' : '') +
            '</button>';
    }

    function loadNotifications() {
        if (!isAuthenticated()) return;
        api('/api/notifications')
            .then(function(rows) {
                state.notifications = rows || [];
                renderHeader();
            })
            .catch(function() {});
    }

    function notificationsPage() {
        if (!protectedPage('notifications')) return;
        var notes = state.notifications || [];
        var items = notes.map(function(n) {
            var inner = '<div class="dashboard-item"><div><h3>' + escapeHTML(n.message) + '</h3><p class="small muted">' + escapeHTML(dateText(n.created_at)) + '</p></div>' +
                (n.read_at ? '' : '<span class="status-pill pending">New</span>') + '</div>';
            return n.link ? '<a href="' + escapeHTML(n.link) + '" class="ux-link-block">' + inner + '</a>' : inner;
        }).join('');

        app.innerHTML = '<section class="page"><div class="container"><div class="page-header"><span class="eyebrow">Activity</span><h1>Notifications</h1></div>' +
            '<div class="dashboard-list">' + (items || '<div class="empty-state"><h3>No notifications yet</h3><p>Submissions, approvals and rejections will appear here.</p></div>') + '</div>' +
            (notes.length ? '<button class="btn ux-mt18" id="mark-read" type="button">Mark all as read</button>' : '') +
            '</div></section>';

        on($('#mark-read'), 'click', function() {
            api('/api/notifications/read-all', { method: 'PATCH' })
                .then(function() {
                    var now = new Date().toISOString();
                    state.notifications = notes.map(function(n) { return Object.assign({}, n, { read_at: n.read_at || now }); });
                    renderHeader();
                    notificationsPage();
                })
                .catch(function(error) { toast(friendlyApiError(error, 'Could not update notifications.'), 'error'); });
        });
    }

    function avatarInner(user) {
        if (user && user.avatar_url) {
            return '<img src="' + escapeHTML(user.avatar_url) + '" alt="">';
        }
        return escapeHTML(((user && user.name) || 'M').charAt(0).toUpperCase());
    }

    function resizeImage(file) {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function() { reject(new Error('Could not read that file.')); };
            reader.onload = function() {
                var img = new Image();
                img.onerror = function() { reject(new Error('That file is not a supported image.')); };
                img.onload = function() {
                    var size = 256;
                    var side = Math.min(img.width, img.height);
                    var sx = (img.width - side) / 2;
                    var sy = (img.height - side) / 2;
                    var canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }
    /* ============ WORKER CATEGORIES, ONBOARDING AND PROFILE ============ */

    var WORK_CATEGORIES = [
        ['dev', 'Development'],
        ['design', 'Design'],
        ['content', 'Content'],
        ['marketing', 'Marketing'],
        ['other', 'Other']
    ];

    function categoryCheckboxes(selected) {
        selected = selected || [];
        return '<div class="ux-chips ux-mt6">' +
            WORK_CATEGORIES.map(function(c) {
                return '<label class="ux-inline-check"><input type="checkbox" data-cat value="' + c[0] + '" class="ux-w-auto ux-m0"' +
                    (selected.indexOf(c[0]) !== -1 ? ' checked' : '') + '> ' + c[1] + '</label>';
            }).join('') + '</div>';
    }

    function checkedCategories(root) {
        return $$('input[data-cat]', root).filter(function(i) { return i.checked; }).map(function(i) { return i.value; });
    }

    function checkOnboarding() {
        if (!isAuthenticated() || state.onboardingFor === state.user.id) return;
        state.onboardingFor = state.user.id;
        api('/api/profile/me')
            .then(function(me) {
                state.profile = me;
                syncVerified(me);
                // Onboarding waits until the email is confirmed, so the two prompts never overlap.
        if (getRole() === 'worker' && me.onboarding_done === false) showOnboarding(me);
                else if (window.BountyFeatures && window.BountyFeatures.afterSignIn) window.BountyFeatures.afterSignIn(me);
            })
            .catch(function() {});
    }

    // Two-step drawer: step 1 picks work categories, step 2 reviews them and saves skills.
    // Skipping (or the close button) still marks onboarding done, so it never returns unasked.
    function showOnboarding(me) {
        if (document.getElementById('onboarding-drawer')) return;
        var back = document.createElement('div');
        back.id = 'onboarding-backdrop';
        back.className = 'drawer-backdrop';
        var drawer = document.createElement('aside');
        drawer.id = 'onboarding-drawer';
        drawer.className = 'drawer';
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-modal', 'true');
        drawer.setAttribute('aria-labelledby', 'ob-title');
        document.body.appendChild(back);
        document.body.appendChild(drawer);
        document.body.style.overflow = 'hidden';

        var step = 1;
        var chosen = (me.categories || []).slice();
        var skills = me.skills || '';

        function finish(saveAnswers) {
            if (back.parentNode) back.parentNode.removeChild(back);
            if (drawer.parentNode) drawer.parentNode.removeChild(drawer);
            document.body.style.overflow = '';
            // The availability question follows the profile questions.
            if (window.BountyFeatures && window.BountyFeatures.afterSignIn) window.BountyFeatures.afterSignIn(state.profile || me);
            return saveAnswers;
        }

        function captureStep() {
            if (step === 1) chosen = checkedCategories(drawer);
            var field = $('#ob-skills', drawer);
            if (field) skills = field.value.trim();
        }

        function paint() {
            var title = step === 1 ? 'What kind of work do you do?' : 'Check and finish';
            var body;
            if (step === 1) {
                body = '<p class="small muted">This helps businesses find you. You can change it later on your profile.</p>' +
                    '<div class="field"><span class="field-label">Pick any that apply</span>' + categoryCheckboxes(chosen) + '</div>';
            } else {
                var names = chosen.length
                    ? chosen.map(categoryLabel).join(', ')
                    : 'None yet. You can add them later.';
                body = '<p class="small muted">Saving marks setup complete. Nothing is shared beyond your profile.</p>' +
                    '<dl class="detail-def"><div class="detail-def-row"><dt>Work categories</dt><dd>' + escapeHTML(names) + '</dd></div></dl>' +
                    '<div class="field"><label for="ob-skills">What are you good at? (optional)</label>' +
                    '<input id="ob-skills" maxlength="300" placeholder="e.g. HTML, copywriting, video editing" value="' + escapeHTML(skills) + '"></div>';
            }
            var foot = step === 1
                ? '<button class="btn" type="button" id="ob-skip">Skip for now</button><button class="btn btn-primary" type="button" id="ob-next">Next</button>'
                : '<button class="btn" type="button" id="ob-back">Back</button><button class="btn btn-primary" type="button" id="ob-save">Save and finish</button>';
            drawer.innerHTML =
                '<div class="drawer-head"><div>' +
                  '<p class="eyebrow" style="margin-bottom:4px"><span class="eyebrow-dot"></span> Set up your profile · step ' + step + ' of 2</p>' +
                  '<h2 id="ob-title">' + escapeHTML(title) + '</h2></div>' +
                  '<button class="icon-button" id="ob-close" type="button" aria-label="Skip setup">' + icon('close', 18) + '</button></div>' +
                '<div class="drawer-body stack-md">' + body + '</div>' +
                '<div class="drawer-foot">' + foot + '</div>';
            wire();
            var first = drawer.querySelector('input, button.btn-primary');
            if (first) first.focus();
        }

        function skipSetup() {
            api('/api/profile/me', { method: 'PATCH', body: { onboarding_done: true } }).catch(function() {});
            finish(false);
        }

        function wire() {
            on($('#ob-close', drawer), 'click', skipSetup);
            on($('#ob-skip', drawer), 'click', skipSetup);
            on($('#ob-next', drawer), 'click', function() { captureStep(); step = 2; paint(); });
            on($('#ob-back', drawer), 'click', function() { captureStep(); step = 1; paint(); });
            on($('#ob-save', drawer), 'click', function() {
                captureStep();
                var saveButton = $('#ob-save', drawer);
                saveButton.disabled = true;
                api('/api/profile/me', {
                        method: 'PATCH',
                        body: { categories: chosen, skills: skills, onboarding_done: true }
                    })
                    .then(function(saved) {
                        state.profile = saved;
                        finish(true);
                        toast('Thanks. Your profile is updated.', 'success');
                    })
                    .catch(function(error) {
                        saveButton.disabled = false;
                        toast(friendlyApiError(error, 'Could not save your answers.'), 'error');
                    });
            });
        }

        paint();
    }

    function addMineToggle() {
        if (getRole() !== 'worker') return;
        var bar = $('.results-line');
        if (!bar || $('#mine-only')) return;
        var label = document.createElement('label');
        label.className = 'small';
        label.style.cssText = 'display:inline-flex;gap:8px;align-items:center;cursor:pointer;margin-bottom:10px';
        label.innerHTML = '<input type="checkbox" id="mine-only"' + (state.mineOnly ? ' checked' : '') + '> Only show my categories';
        bar.parentNode.insertBefore(label, bar);
        on($('#mine-only'), 'change', function(event) {
            state.mineOnly = event.target.checked;
            var mine = state.profile && state.profile.categories && state.profile.categories.length;
            if (state.mineOnly && !mine) toast('Pick your work categories on your profile first.', 'error');
            state.bountyPage = 1;
            fetchBounties();
        });
    }

    // ------------------------------------------------ Proof-of-Ability (worker portfolio)
    // The worker chooses which approved work to show, drafts a summary from that work, edits it and saves it.
    // "Verified" means approved on Bounty. Skills the worker types are labelled self-reported.
    function loadPortfolio() {
        var card = $('#portfolio-card');
        if (!card) return;
        card.innerHTML = '<section class="form-card"><h2>Portfolio</h2><div class="loading-line"><span class="spinner"></span> Loading your approved work…</div></section>';
        api('/api/portfolio/me')
            .then(function(data) { renderPortfolio(card, data); })
            .catch(function(error) {
                card.innerHTML = '<section class="form-card"><h2>Portfolio</h2><div class="form-error" role="alert">' + escapeHTML(friendlyApiError(error, 'Your portfolio could not be loaded.')) + '</div><button class="btn btn-sm" type="button" id="portfolio-retry">Try again</button></section>';
                on($('#portfolio-retry'), 'click', loadPortfolio);
            });
    }

    function renderPortfolio(card, data) {
        var approved = data.approved || [];
        var rows = approved.length ? approved.map(function(item) {
            return '<label class="portfolio-row"><input type="checkbox" data-show="' + escapeHTML(item.id) + '"' + (item.portfolio_visible ? ' checked' : '') + '>' +
                '<span><strong>' + escapeHTML(item.title) + '</strong><span class="small muted"> · ' + escapeHTML(item.bounty_title) + ' · ' + escapeHTML(categoryLabel(item.category)) + '</span></span></label>';
        }).join('') : '<p class="muted">Approved work appears here once a business approves one of your submissions.</p>';

        card.innerHTML = '<section class="form-card form" id="portfolio-section">' +
            '<h2>Portfolio</h2>' +
            '<p class="small muted">Choose which approved work appears on your public profile. Work listed here is verified on Bounty. Anything you type about your skills is self-reported.</p>' +
            '<div id="portfolio-list">' + rows + '</div>' +
            '<div class="form-error" id="portfolio-error" hidden role="alert"></div>' +
            '<div class="field"><label for="portfolio-summary">Summary</label>' +
            '<textarea id="portfolio-summary" maxlength="1000" placeholder="Write a summary, or draft one from the work you show">' + escapeHTML(data.summary || '') + '</textarea>' +
            '<span class="field-hint"><span id="portfolio-count">' + String((data.summary || '').length) + '</span>/1000 characters</span></div>' +
            '<div class="ux-row ux-gap14"><button class="btn btn-sm" type="button" id="portfolio-draft">Draft a summary</button>' +
            '<button class="btn btn-primary btn-sm" type="button" id="portfolio-save">Save summary</button></div>' +
            '<div id="portfolio-draft-output" aria-live="polite"></div></section>';

        $$('input[data-show]', card).forEach(function(box) {
            on(box, 'change', function() {
                var wanted = box.checked;
                box.disabled = true;
                api('/api/portfolio/submissions/' + encodeURIComponent(box.getAttribute('data-show')), { method: 'PATCH', body: { visible: wanted } })
                    .then(function(res) {
                        box.checked = res.portfolio_visible === true;
                        toast(box.checked ? 'Shown on your profile.' : 'Hidden from your profile.', 'success');
                    })
                    .catch(function(error) {
                        box.checked = !wanted;
                        toast(friendlyApiError(error, 'Could not change what is shown.'), 'error');
                    })
                    .then(function() { box.disabled = false; });
            });
        });

        on($('#portfolio-summary'), 'input', function() {
            $('#portfolio-count').textContent = String($('#portfolio-summary').value.length);
        });

        on($('#portfolio-draft'), 'click', function() {
            var button = $('#portfolio-draft');
            var output = $('#portfolio-draft-output');
            button.disabled = true;
            output.innerHTML = '<div class="loading-line"><span class="spinner"></span> Drafting from the work you show…</div>';
            api('/api/ai/proof-of-ability/generate', { method: 'POST', body: {} })
                .then(function(draft) { showPortfolioDraft(output, draft); })
                .catch(function(error) {
                    output.innerHTML = '<div class="form-error" role="alert">' + escapeHTML(friendlyApiError(error, 'The draft could not be made. Try again in a moment.')) + '</div>';
                })
                .then(function() { button.disabled = false; });
        });

        on($('#portfolio-save'), 'click', function() {
            var button = $('#portfolio-save');
            var box = $('#portfolio-summary');
            var errorBox = $('#portfolio-error');
            errorBox.hidden = true;
            button.disabled = true;
            api('/api/portfolio/me/summary', { method: 'PUT', body: { summary: box.value } })
                .then(function(res) {
                    box.value = res.summary || '';
                    $('#portfolio-count').textContent = String(box.value.length);
                    toast('Summary saved.', 'success');
                })
                .catch(function(error) { showFormError(errorBox, friendlyApiError(error, 'Could not save your summary.')); })
                .then(function() { button.disabled = false; });
        });
    }

    // Shows who wrote the draft and what it rests on. Fills the editable box; nothing is saved until the worker saves.
    function showPortfolioDraft(output, draft) {
        var notice = draft.source === 'ai'
            ? 'Drafted with an AI model from the work you chose to show. Check every line against it before you save.'
            : (draft.ai_error || 'Drafted by our rules engine, not an AI model. Check every line before you save.');
        var verified = (draft.verified || []).map(function(item) {
            return '<li>' + escapeHTML(item.title) + ' <span class="small muted">· ' + escapeHTML(item.bounty_title) + '</span></li>';
        }).join('');
        output.innerHTML = '<div class="notice">' + escapeHTML(notice) + '</div>' +
            '<p class="small"><strong>Verified on Bounty</strong></p>' +
            (verified ? '<ul class="check-list">' + verified + '</ul>' : '<p class="muted small">No shown work to verify yet.</p>') +
            (draft.skills && draft.skills.length ? '<p class="small"><strong>The work shows:</strong> ' + escapeHTML(draft.skills.join(', ')) + '</p>' : '');
        $('#portfolio-summary').value = draft.summary || '';
        $('#portfolio-count').textContent = String((draft.summary || '').length);
    }

    function profilePage() {
        if (!protectedPage('profile')) return;
        var pendingPhoto = null;
        var worker = getRole() === 'worker';
        var business = getRole() === 'business';
        var nameLabel = business ? 'Company name' : 'Full name';
        var bioLabel = business ? 'About the company' : 'Bio';
        var photoLabel = business ? 'Logo' : 'Photo';
        var bioPlaceholder = business ? 'What does your company do?' : 'Tell businesses about your skills and experience';

        app.innerHTML = '<section class="page"><div class="container"><div class="page-header"><span class="eyebrow">Your account</span><h1>Your profile</h1><p>Update how other people see you on Bounty.</p>' + (worker ? '<p class="small"><a class="inline-link" href="#/worker/' + escapeHTML(state.user.id) + '">View your public profile →</a></p>' : '') + '</div>' +
            '<div class="form-layout"><form id="profile-form" class="form-card form"><div id="profile-error" class="form-error" hidden role="alert"></div>' +
            '<div class="field"><span class="field-label">' + photoLabel + '</span><div class="ux-row ux-gap14">' +
            '<div id="avatar-preview" class="ux-avatar ux-avatar-lg">' + avatarInner(state.user) + '</div>' +
            '<input id="avatar-file" type="file" accept="image/*"></div><span class="field-hint">Any image. It is cropped to a square and stored with your profile.</span></div>' +
            '<div class="field"><label for="profile-name">' + nameLabel + '</label><input id="profile-name" name="name" required minlength="2" maxlength="100" value="' + escapeHTML(state.user.name || '') + '"></div>' +
            '<div class="field"><label for="profile-bio">' + bioLabel + '</label><textarea id="profile-bio" name="bio" maxlength="500" placeholder="' + bioPlaceholder + '"></textarea><span class="field-hint"><span id="bio-count">0</span>/500 characters</span></div>' +
            (business ?
                '<div class="field"><label for="profile-website">Website (optional)</label><input id="profile-website" type="url" maxlength="200" placeholder="https://example.com"></div>' +
                '<div class="field"><label for="profile-location">Location (optional)</label><input id="profile-location" maxlength="100" placeholder="e.g. Lagos, Nigeria"></div>' : '') +
            (worker ?
                '<div class="field"><span class="field-label">Kinds of work you do</span>' + categoryCheckboxes([]) + '</div>' +
                '<div class="field"><label for="profile-skills">What you are good at (optional)</label><input id="profile-skills" maxlength="300" placeholder="e.g. HTML, copywriting, video editing"></div>' : '') +
            '<button class="btn btn-primary" id="profile-save" type="submit">Save profile ' + icon('arrow', 16) + '</button></form></div>' +
            (worker ? '<div class="form-layout" id="portfolio-card"></div><div class="form-layout" data-availability-slot></div>' : '') +
            (business ? '<div class="form-layout"><section class="form-card form" aria-labelledby="workpeg-settings-title"><h2 id="workpeg-settings-title" class="h4">Workpeg</h2>' +
              '<p class="muted">Connect Bounty to Workpeg, approve what it may do, and revoke access at any time. Only business accounts can connect.</p>' +
              '<div><a class="btn btn-sm btn-primary" href="#/connections/workpeg">Open Workpeg settings</a></div></section></div>' : '') +
            '</div></section>';

        api('/api/profile/me')
            .then(function(me) {
                state.profile = me;
                setSession(Object.assign({}, state.user, me), getToken());
                $('#profile-bio').value = me.bio || '';
                $('#bio-count').textContent = (me.bio || '').length;
                if (worker) {
                    $$('input[data-cat]', $('#profile-form')).forEach(function(box) {
                        box.checked = (me.categories || []).indexOf(box.value) !== -1;
                    });
                    $('#profile-skills').value = me.skills || '';
                }
                if (business) {
                    $('#profile-website').value = me.website || '';
                    $('#profile-location').value = me.location || '';
                }
                $('#avatar-preview').innerHTML = avatarInner(state.user);
            })
            .catch(function(error) { showFormError($('#profile-error'), friendlyApiError(error, 'Could not load your profile.')); });
        if (worker) loadPortfolio();
        if (worker) mountFeature('availability', app.querySelector('[data-availability-slot]'));

        on($('#profile-bio'), 'input', function(event) {
            $('#bio-count').textContent = event.target.value.length;
        });

        on($('#avatar-file'), 'change', function(event) {
            var file = event.target.files && event.target.files[0];
            if (!file) return;
            resizeImage(file)
                .then(function(dataUrl) {
                    pendingPhoto = dataUrl;
                    $('#avatar-preview').innerHTML = avatarInner({ avatar_url: dataUrl });
                })
                .catch(function(error) { showFormError($('#profile-error'), error.message); });
        });

        on($('#profile-form'), 'submit', function(event) {
            event.preventDefault();
            var errorBox = $('#profile-error');
            var button = $('#profile-save');
            errorBox.hidden = true;

            var payload = {
                name: $('#profile-name').value.trim(),
                bio: $('#profile-bio').value.trim()
            };
            if (pendingPhoto) payload.avatar_url = pendingPhoto;
            if (worker) {
                payload.categories = checkedCategories($('#profile-form'));
                payload.skills = $('#profile-skills').value.trim();
            }
            if (business) {
                payload.website = $('#profile-website').value.trim();
                payload.location = $('#profile-location').value.trim();
            }

            button.disabled = true;
            api('/api/profile/me', { method: 'PATCH', body: payload })
                .then(function(me) {
                    state.profile = me;
                    setSession(Object.assign({}, state.user, me), getToken());
                    toast('Profile saved.', 'success');
                    profilePage();
                })
                .catch(function(error) {
                    showFormError(errorBox, friendlyApiError(error, 'Could not save your profile.'));
                    button.disabled = false;
                });
        });
    }

    function businessProfilePage(id) {
        if (!protectedPage('business/' + id)) return;
        app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a><div class="loading-line"><span class="spinner"></span> Loading company profile…</div></div></section>';

        api('/api/profile/business/' + encodeURIComponent(id))
            .then(function(c) {
                var site = safeLink(c.website || '');
                app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a><div class="detail-layout"><article class="panel">' +
                    '<div class="ux-row ux-gap16 ux-mb18"><div class="ux-avatar ux-avatar-xl">' + avatarInner(c) + '</div>' +
                    '<div><h1 class="detail-title ux-m0">' + escapeHTML(c.name || 'Company') + '</h1>' +
                    (c.location ? '<p class="small muted ux-mt4">' + escapeHTML(c.location) + '</p>' : '') + '</div></div>' +
                    '<section class="detail-section"><h2>About</h2><div class="detail-description">' + escapeHTML(c.bio || 'This company has not added a description yet.') + '</div></section>' +
                    (site ? '<section class="detail-section"><h2>Website</h2><p><a class="inline-link" href="' + site + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(c.website) + '</a></p></section>' : '') +
                    '</article><div class="panel detail-sidebar"><h2>Activity</h2><dl class="definition-list">' +
                    '<div><dt>Bounties posted</dt><dd>' + escapeHTML(c.bounties_posted) + '</dd></div>' +
                    '<div><dt>Completed</dt><dd>' + escapeHTML(c.bounties_completed) + '</dd></div></dl></div></div></section>';
            })
            .catch(function(error) {
                app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a><div class="empty-state"><span class="empty-illustration">' + icon('alert', 28) + '</span><h3>Company not found</h3><p>' + escapeHTML(friendlyApiError(error, 'This company profile could not be loaded.')) + '</p><a class="btn btn-primary" href="#/bounties">Back to marketplace</a></div></div></section>';
            });
    }

    function addCompanyLink(bounty) {
        var sidebar = $('.detail-sidebar');
        if (!sidebar || !bounty.business_id) return;
        var link = document.createElement('a');
        link.className = 'btn btn-block';
        link.style.marginTop = '12px';
        link.href = '#/business/' + encodeURIComponent(bounty.business_id);
        link.textContent = 'View company profile';
        sidebar.appendChild(link);
    }
    /* ============ LAYOUT ============ */
    // Briefly transitions every color so a theme change fades in rather than snapping.
    /* ============ PUBLIC PAGES ============ */

    function authPage(mode) {
        var signup = mode === 'signup';
        var heading = signup ? 'Join Bounty.' : 'Welcome back.';
        var sub = signup
            ? 'Create an account. Browse tasks, prove your ability, and get the work seen by people who need it.'
            : 'Log in to pick up where you left off.';
        app.innerHTML =
            '<section class="auth-shell">' +
              '<div class="auth-brand-pane">' +
                '<div class="auth-brand-content">' +
                  '<a class="auth-brand-mark" href="#/"><span class="brand-mark">B</span><span>Bounty</span></a>' +
                  '<div class="stack-md">' +
                    '<h1 class="auth-headline">' + escapeHTML(heading) + '</h1>' +
                    '<p class="auth-sub">' + escapeHTML(sub) + '</p>' +
                  '</div>' +
                '</div>' +
                '<div class="auth-marks">' +
                  '<div class="auth-mark-row"><span class="auth-mark-icon">' + icon('file', 16) + '</span><div><strong>Clear tasks, clear outcomes.</strong>Every bounty states its scope, requirements and acceptance criteria upfront.</div></div>' +
                  '<div class="auth-mark-row"><span class="auth-mark-icon">' + icon('shield', 16) + '</span><div><strong>Reputation from work done.</strong>Approved submissions build a per-industry record you can show.</div></div>' +
                  '<div class="auth-mark-row"><span class="auth-mark-icon">' + icon('globe', 16) + '</span><div><strong>Opportunity without a gate.</strong>Who you know and where you are matter less than what you can do.</div></div>' +
                '</div>' +
              '</div>' +
              '<section class="auth-form-pane"><div class="auth-form-card">' +
                '<h2>' + (signup ? 'Create your account' : 'Log in') + '</h2>' +
                '<p class="lead">' + (signup ? 'One minute. No email verification step.' : 'Enter your account details below.') + '</p>' +
                '<form id="auth-form" class="form" novalidate>' +
                  '<div id="auth-error" class="form-error" hidden role="alert"></div>' +
                  (signup ? '<div class="field"><label for="auth-name">Full name</label><input id="auth-name" name="name" autocomplete="name" placeholder="e.g. Ismaila Jabar" required maxlength="100"></div>' : '') +
                  '<div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="254"></div>' +
                  '<div class="field"><label for="auth-password">Password</label>' +
                    '<div class="pw-wrap"><input id="auth-password" name="password" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" placeholder="' + (signup ? 'At least 8 characters' : 'Your password') + '" required minlength="' + (signup ? '8' : '1') + '" maxlength="128">' +
                    '<button class="pw-toggle" type="button" id="pw-toggle" aria-pressed="false" aria-label="Show password">Show</button></div>' +
                    (signup ? '<div class="pw-strength-wrap"><div class="progress pw-strength"><div class="progress-bar progress-strength-0" id="pw-strength-bar"></div></div><small id="pw-strength-label">—</small></div>' : '') +
                  '</div>' +
                  (signup ? '<div class="field"><span class="field-label" style="margin-bottom:8px">I want to join as</span>' +
                    '<div class="role-cards">' +
                      '<label class="role-card"><input type="radio" name="role" value="worker" checked><span class="role-card-body"><strong>Worker</strong><span>Find tasks, prove your ability, get paid for approved work.</span></span></label>' +
                      '<label class="role-card"><input type="radio" name="role" value="business"><span class="role-card-body"><strong>Business</strong><span>Post tasks, review submissions, hire proven workers.</span></span></label>' +
                    '</div></div>' : '') +
                  '<div class="form-actions" style="margin-top:' + (signup ? '24px' : '20px') + '">' +
                    '<button class="btn btn-primary btn-block" type="submit" id="auth-submit">' + (signup ? 'Create account' : 'Log in') + '</button>' +
                  '</div>' +
                '</form>' +
                (signup ? '' : '<p class="auth-switch"><a class="inline-link" href="#/auth/forgot">Forgot password?</a></p>') +
                '<p class="auth-switch">' + (signup ? 'Already have an account? <a class="inline-link" href="#/auth/login">Log in</a>' : 'New to Bounty? <a class="inline-link" href="#/auth/signup">Create an account</a>') + '</p>' +
              '</div></section>' +
            '</section>';
        on($('#auth-form'), 'submit', function(event) { submitAuth(event, signup); });
        on($('#pw-toggle'), 'click', function(event) {
            var input = $('#auth-password');
            var reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            event.currentTarget.textContent = reveal ? 'Hide' : 'Show';
            event.currentTarget.setAttribute('aria-pressed', String(reveal));
            event.currentTarget.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
        });
        on($('#auth-form'), 'input', function(event) {
            if (event.target.getAttribute) event.target.setAttribute('aria-invalid', 'false');
        });
        if (signup) on($('#auth-password'), 'input', function(e) { updatePwStrength(e.target.value); });
    }

    // Lightweight password strength estimate — length tiers, plus variety for the next step.
    function updatePwStrength(pw) {
        var bar = $('#pw-strength-bar');
        var label = $('#pw-strength-label');
        if (!bar || !label) return;
        var score = 0;
        if (pw.length >= 8) score++;
        if (pw.length >= 12) score++;
        if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
        if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
        bar.className = 'progress-bar progress-strength-' + score;
        var labels = ['—', 'Weak', 'Okay', 'Good', 'Strong'];
        label.textContent = pw.length === 0 ? '—' : labels[score];
    }

    // Marks one field as invalid and moves focus to it, so the error is tied to the input.
    function markInvalid(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('aria-invalid', 'true');
        el.focus();
    }

    function submitAuth(event, signup) {
        event.preventDefault();
        var form = event.currentTarget;
        var button = $('#auth-submit');
        var errorBox = $('#auth-error');
        errorBox.hidden = true;

        var values = new FormData(form);
        var payload = {
            email: String(values.get('email') || '').trim().toLowerCase(),
            password: String(values.get('password') || '')
        };
        if (signup) {
            payload.name = String(values.get('name') || '').trim();
            payload.role = String(values.get('role') || 'worker');
        }

        if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
            markInvalid('auth-email');
            return showFormError(errorBox, 'Enter a valid email address.');
        }
        if (payload.password.length < (signup ? 8 : 1)) {
            markInvalid('auth-password');
            return showFormError(errorBox, signup ? 'Use a password with at least 8 characters.' : 'Enter your password.');
        }
        if (signup && !payload.name) {
            markInvalid('auth-name');
            return showFormError(errorBox, 'Enter your name.');
        }

        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> ' + (signup ? 'Creating account…' : 'Signing in…');

        api('/api/auth/' + (signup ? 'signup' : 'signin'), { method: 'POST', body: payload, auth: false })
            .then(function(data) {
                var normalized = normalizeUser(data);
                if (!normalized.token || !normalized.user.id) {
                    throw new Error('The server response did not include a usable user ID and login token.');
                }
                setSession(normalized.user, normalized.token);
                var destination = sessionStorage.getItem('bounty_after_auth') || 'bounties';
                sessionStorage.removeItem('bounty_after_auth');
                toast(signup ? 'Account created successfully.' : 'You are signed in.', 'success');
                go(destination);
            })
            .catch(function(error) {
                var message = friendlyApiError(error, signup ? 'Could not create your account.' : 'Could not sign you in.');
                if (/email/i.test(message)) markInvalid('auth-email');
                else if (/password/i.test(message)) markInvalid('auth-password');
                showFormError(errorBox, message);
            })
            .then(function() {
                if (document.contains(button)) {
                    button.disabled = false;
                    button.innerHTML = (signup ? 'Create account' : 'Log in') + ' ' + icon('arrow', 16);
                }
            });
    }

    function showFormError(node, message) {
        node.textContent = message;
        node.hidden = false;
    }

    function friendlyApiError(error, fallback) {
        if (error instanceof TypeError && /fetch/i.test(error.message)) {
            return 'Could not reach the Bounty server. Check your connection and try again. If the site has been idle, the server can take a minute to start.';
        }
        return (error && error.message) || fallback;
    }

    function protectedPage(route) {
        return requireAuth(route);
    }

    /* ============ MARKETPLACE ============ */

    // A single bounty on the list — one big rich horizontal row rather than a grid card.
    function bountyRow(b) {
        var id = b.id || b.bounty_id;
        var title = b.title || 'Untitled bounty';
        var status = b.status || 'open';
        var desc = String(b.description || 'No description yet.').replace(/\s+/g, ' ').trim();
        var deadlineBit = b.deadline ? daysLeft(b.deadline) : 'No deadline';
        return '<a class="bounty-row" href="#/bounties/' + encodeURIComponent(id) + '">' +
            '<div class="bounty-row-main">' +
              '<div class="bounty-row-top">' +
                '<span class="badge badge-signal">' + escapeHTML(categoryLabel(b.category)) + '</span>' +
                '<span class="status-pill status-' + statusClass(status) + '">' + escapeHTML(titleCase(status)) + '</span>' +
                (b.difficulty ? '<span class="tag">' + escapeHTML(titleCase(b.difficulty)) + '</span>' : '') +
              '</div>' +
              '<h2 class="bounty-row-title">' + escapeHTML(title) + '</h2>' +
              '<p class="bounty-row-desc">' + escapeHTML(desc) + '</p>' +
              '<div class="bounty-row-meta">' +
                '<span>' + icon('clock', 13) + ' ' + escapeHTML(deadlineBit) + '</span>' +
                '<span>' + icon('file', 13) + ' ' + escapeHTML(titleCase(b.submission_type || 'submission')) + '</span>' +
                '<span>' + escapeHTML(workerSlotsText(b)) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="bounty-row-reward">' +
              '<span class="bounty-row-reward-amount num">' + escapeHTML(formatNumber(b.reward_amount)) + '</span>' +
              '<span class="bounty-row-reward-currency">' + escapeHTML(b.currency || 'NGN') + '</span>' +
            '</div>' +
          '</a>';
    }

    // Kept as an alias so existing callers (dashboard) that use bountyCard() still work.
    function bountyCard(b) { return bountyRow(b); }

    function formatNumber(value) {
        var n = Number(value);
        if (!isFinite(n)) return String(value || '');
        return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    function browsePage() {
        if (!protectedPage('bounties')) return;
        var isBusiness = getRole() === 'business';
        var isWorker = getRole() === 'worker';
        var categories = [
            ['all', 'All'],
            ['dev', 'Development'],
            ['design', 'Design'],
            ['content', 'Content'],
            ['marketing', 'Marketing'],
            ['other', 'Other']
        ];
        var difficulties = [
            ['all', 'Any level'],
            ['easy', 'Easy'],
            ['medium', 'Medium'],
            ['hard', 'Hard']
        ];

        var categoryItems = categories.map(function(c) {
            return '<button class="filter-rail-item" type="button" data-category="' + c[0] + '" aria-pressed="' + (state.category === c[0]) + '">' +
                '<span>' + escapeHTML(c[1]) + '</span></button>';
        }).join('');
        var difficultyItems = difficulties.map(function(d) {
            return '<button class="filter-rail-item" type="button" data-difficulty="' + d[0] + '" aria-pressed="' + (state.difficulty === d[0]) + '">' +
                '<span>' + escapeHTML(d[1]) + '</span></button>';
        }).join('');

        var tabsHTML = isWorker ?
            '<div class="tabs" role="tablist">' +
              '<button class="tab" role="tab" aria-selected="' + (state.mineOnly ? 'true' : 'false') + '" data-tab="mine">For you</button>' +
              '<button class="tab" role="tab" aria-selected="' + (state.mineOnly ? 'false' : 'true') + '" data-tab="all">All opportunities</button>' +
            '</div>' : '';

        app.innerHTML =
            '<section class="page"><div class="container">' +
              '<div class="page-head">' +
                '<div>' +
                  '<p class="eyebrow"><span class="eyebrow-dot"></span> Marketplace</p>' +
                  '<h1>Find work worth proving.</h1>' +
                  '<p class="muted">Each task states what it needs, what success looks like, and when it is due. Filter on the left; submissions are reviewed against the stated criteria.</p>' +
                '</div>' +
                (isBusiness ? '<div><a class="btn btn-primary" href="#/bounties/new">' + icon('plus', 16) + ' Create a bounty</a></div>' : '') +
              '</div>' +
              tabsHTML +
              '<div class="marketplace-layout">' +
                '<div class="filter-rail" role="region" aria-label="Filter bounties">' +
                  '<div class="filter-rail-group"><span class="filter-rail-group-label">Category</span>' + categoryItems + '</div>' +
                  '<div class="filter-rail-group"><span class="filter-rail-group-label">Difficulty</span>' + difficultyItems + '</div>' +
                '</div>' +
                '<div>' +
                  '<div class="search-toolbar">' +
                    '<div class="search-wrap">' + icon('search', 17) + '<input id="bounty-search" type="search" placeholder="Search by title or keyword…" value="' + escapeHTML(state.search) + '" aria-label="Search bounties"></div>' +
                    '<select id="bounty-sort" aria-label="Sort" style="width:auto;min-width:160px">' +
                      '<option value="newest"' + (state.sort === 'newest' ? ' selected' : '') + '>Newest first</option>' +
                      '<option value="reward-high"' + (state.sort === 'reward-high' ? ' selected' : '') + '>Highest reward</option>' +
                      '<option value="deadline"' + (state.sort === 'deadline' ? ' selected' : '') + '>Deadline soon</option>' +
                    '</select>' +
                  '</div>' +
                  '<div class="results-line"><span id="results-count">Loading…</span><span>Page <strong id="page-number" class="num">' + state.bountyPage + '</strong></span></div>' +
                  '<div id="bounty-results" class="bounty-list" aria-live="polite">' +
                    '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>' +
                  '</div>' +
                  '<div id="bounty-pagination" class="form-actions" style="justify-content:center;margin-top:24px"></div>' +
                '</div>' +
              '</div>' +
            '</div></section>';

        on($('#bounty-search'), 'input', debounce(function(event) {
            state.search = event.target.value;
            state.bountyPage = 1;
            fetchBounties();
        }, 250));
        on($('#bounty-sort'), 'change', function(event) {
            state.sort = event.target.value;
            fetchBounties();
        });
        $$('[data-category]').forEach(function(button) {
            button.addEventListener('click', function() {
                state.category = button.getAttribute('data-category');
                state.bountyPage = 1;
                $$('[data-category]').forEach(function(b) { b.setAttribute('aria-pressed', String(b === button)); });
                fetchBounties();
            });
        });
        $$('[data-difficulty]').forEach(function(button) {
            button.addEventListener('click', function() {
                state.difficulty = button.getAttribute('data-difficulty');
                state.bountyPage = 1;
                $$('[data-difficulty]').forEach(function(b) { b.setAttribute('aria-pressed', String(b === button)); });
                fetchBounties();
            });
        });
        $$('[data-tab]').forEach(function(t) {
            t.addEventListener('click', function() {
                var mode = t.getAttribute('data-tab');
                state.mineOnly = (mode === 'mine');
                state.bountyPage = 1;
                $$('[data-tab]').forEach(function(x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
                fetchBounties();
            });
        });
        fetchBounties();
    }

    function debounce(fn, wait) {
        var timer;
        return function() {
            var args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function() { fn.apply(null, args); }, wait);
        };
    }

    function fetchBounties() {
        var result = $('#bounty-results');
        if (!result) return;
        result.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';

        var params = new URLSearchParams({ page: String(state.bountyPage), limit: String(state.bountyLimit) });
        if (state.category !== 'all') params.set('category', state.category);
        if (state.difficulty !== 'all') params.set('difficulty', state.difficulty);

        api('/api/bounties?' + params.toString())
            .then(function(data) {
                var bounties = normalizeBounties(data).filter(function(b) {
                    var open = !b.status || String(b.status).toLowerCase() === 'open';
                    var notExpired = !b.deadline || new Date(b.deadline).getTime() > Date.now();
                    return open && notExpired;
                });
                if (state.mineOnly && state.profile && state.profile.categories && state.profile.categories.length) {
                    bounties = bounties.filter(function(b) {
                        return state.profile.categories.indexOf(b.category) !== -1;
                    });
                }
                var term = state.search.trim().toLowerCase();
                if (term) {
                    bounties = bounties.filter(function(b) {
                        return String(b.title || '').toLowerCase().indexOf(term) !== -1 ||
                            String(b.description || '').toLowerCase().indexOf(term) !== -1;
                    });
                }
                if (state.sort === 'reward-high') {
                    bounties.sort(function(a, b) { return Number(b.reward_amount || 0) - Number(a.reward_amount || 0); });
                }
                if (state.sort === 'deadline') {
                    bounties.sort(function(a, b) { return new Date(a.deadline || '2999-01-01') - new Date(b.deadline || '2999-01-01'); });
                }
                if (state.sort === 'newest') {
                    bounties.sort(function(a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });
                }

                var pagination = (data && data.pagination) || {};
                var total = Number(nz(pagination.total, bounties.length));
                var pages = Math.max(1, Math.ceil(total / state.bountyLimit));

                // The server total includes closed and expired bounties, so count what this page shows.
                $('#results-count').textContent = bounties.length ? bounties.length + ' open ' + (bounties.length === 1 ? 'bounty' : 'bounties') + ' on this page' : 'No open bounties on this page';
                $('#page-number').textContent = state.bountyPage;

                if (!bounties.length) {
                    var filtered = state.search || state.category !== 'all' || state.difficulty !== 'all' || state.mineOnly;
                    result.innerHTML = '<div class="empty-state"><span class="empty-illustration">' + icon('search', 24) + '</span><h3>' + (filtered ? 'Nothing matches those filters' : 'No open bounties yet') + '</h3><p>' + (filtered ? 'Try a wider search, drop a filter or switch to “All opportunities”.' : 'When a business publishes a task, it will appear here. Check back soon.') + '</p>' + (filtered ? '<button class="btn" id="clear-filters" type="button">Clear filters</button>' : '') + '</div>';
                } else {
                    result.innerHTML = bounties.map(bountyRow).join('');
                }

                on($('#clear-filters'), 'click', function() {
                    state.search = '';
                    state.category = 'all';
                    state.difficulty = 'all';
                    state.mineOnly = false;
                    state.bountyPage = 1;
                    browsePage();  // full re-render so the chips, tabs and search field reset too
                });

                var pager = $('#bounty-pagination');
                pager.innerHTML =
                    (state.bountyPage > 1 ? '<button class="btn" data-page="prev">' + icon('arrowLeft', 15) + ' Previous</button>' : '') +
                    (state.bountyPage < pages ? '<button class="btn" data-page="next">Next ' + icon('arrow', 15) + '</button>' : '');
                on($('[data-page="prev"]', pager), 'click', function() {
                    state.bountyPage--;
                    fetchBounties();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });
                on($('[data-page="next"]', pager), 'click', function() {
                    state.bountyPage++;
                    fetchBounties();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });
            })
            .catch(function(error) {
                result.innerHTML = '<div class="empty-state"><span class="empty-illustration">' + icon('alert', 28) + '</span><h3>We couldn\'t load bounties</h3><p>' + escapeHTML(friendlyApiError(error, 'The server could not return opportunities.')) + '</p><button class="btn btn-primary" id="retry-bounties" type="button">Try again</button></div>';
                $('#results-count').textContent = 'Unable to load opportunities';
                $('#bounty-pagination').innerHTML = '';
                on($('#retry-bounties'), 'click', fetchBounties);
            });
    }

    /* ============ BOUNTY DETAIL ============ */
    function addCloseButton(bounty) {
        var sidebar = $('.detail-sidebar');
        if (!sidebar || String(bounty.status || '').toLowerCase() !== 'open') return;
        var wrap = document.createElement('div');
        wrap.style.marginTop = '12px';
        wrap.innerHTML = '<button class="btn btn-block" id="close-bounty-btn" type="button">Close bounty</button>';
        sidebar.appendChild(wrap);
        on($('#close-bounty-btn'), 'click', function(event) {
            inlineConfirm(event.currentTarget, 'Close this bounty? It will be hidden from the marketplace.', 'Close bounty', function() {
                api('/api/bounties/' + encodeURIComponent(bounty.id) + '/close', { method: 'PATCH' })
                    .then(function() {
                        toast('Bounty closed.', 'success');
                        bountyDetailPage(bounty.id);
                    })
                    .catch(function(error) {
                        toast(friendlyApiError(error, 'Could not close this bounty.'), 'error');
                    });
            });
        });
    }

    // Submission as a right-side drawer. Keeps the worker on the detail page, shows criteria next
    // to the form, and persists in-progress text in sessionStorage so an accidental close doesn't
    // nuke what was typed.
    function submissionDrawerHTML(bounty) {
        var linkRequired = bounty.submission_type !== 'text';
        var draftKey = 'bounty_submit_draft_' + bounty.id;
        var saved = {};
        try { saved = JSON.parse(sessionStorage.getItem(draftKey) || '{}'); } catch (e) { saved = {}; }
        var criteriaBlock = bounty.acceptance_criteria && bounty.acceptance_criteria.length
            ? '<div class="field"><label>Acceptance criteria (for your reference)</label>' + criteriaListHTML(bounty.acceptance_criteria) + '</div>'
            : '';
        return '<div id="submission-drawer-backdrop" class="drawer-backdrop" hidden></div>' +
          '<aside id="submission-drawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="sd-title" hidden>' +
            '<div class="drawer-head">' +
              '<div><p class="eyebrow" style="margin-bottom:4px"><span class="eyebrow-dot"></span> Submit your work</p>' +
              '<h2 id="sd-title">' + escapeHTML((bounty.title || 'Submission').slice(0, 60)) + '</h2></div>' +
              '<button class="icon-button" id="submission-drawer-close" type="button" aria-label="Close">' + icon('close', 18) + '</button>' +
            '</div>' +
            '<form id="submission-form" class="drawer-body form" novalidate>' +
              '<div id="submission-error" class="form-error" hidden role="alert"></div>' +
              criteriaBlock +
              '<div class="field"><label for="submission-title">Submission title</label><input id="submission-title" name="title" required minlength="3" maxlength="200" placeholder="A one-line summary of your submission" value="' + escapeHTML(saved.title || '') + '"></div>' +
              '<div class="field"><label for="submission-description">How your work meets the requirements</label><textarea id="submission-description" name="description" required minlength="30" maxlength="2000" rows="5" placeholder="Explain what you built and how it meets each criterion.">' + escapeHTML(saved.description || '') + '</textarea><span class="field-hint">30 to 2000 characters.</span></div>' +
              '<div class="field"><label for="submission-link">' + (linkRequired ? 'Link to your work' : 'Link (optional)') + '</label><input id="submission-link" name="github_link" type="url" maxlength="255" ' + (linkRequired ? 'required' : '') + ' placeholder="https://github.com/you/project" value="' + escapeHTML(saved.github_link || '') + '"><span class="field-hint">A project, repository or hosted file. 255 characters max.</span></div>' +
              '<div class="field"><label for="submission-notes">Notes for the reviewer (optional)</label><textarea id="submission-notes" name="notes" maxlength="1000" rows="3" placeholder="Anything the reviewer should know.">' + escapeHTML(saved.notes || '') + '</textarea></div>' +
            '</form>' +
            '<div class="drawer-foot">' +
              '<button class="btn" type="button" id="submission-drawer-cancel">Cancel</button>' +
              '<button class="btn btn-primary" id="submit-work-btn" type="submit" form="submission-form">Submit work</button>' +
            '</div>' +
          '</aside>';
    }

    function openSubmissionDrawer(bounty) {
        var drawer = $('#submission-drawer');
        var back = $('#submission-drawer-backdrop');
        if (!drawer || !back) return;
        drawer.hidden = false;
        back.hidden = false;
        document.body.style.overflow = 'hidden';
        setTimeout(function() {
            var t = $('#submission-title');
            if (t) t.focus();
        }, 20);
        // Persist typed content to sessionStorage as the user types, keyed per bounty.
        var draftKey = 'bounty_submit_draft_' + bounty.id;
        // Property handler, not addEventListener: reopening the drawer must not stack listeners.
        var draftForm = $('#submission-form');
        if (draftForm) draftForm.oninput = function() {
            try {
                sessionStorage.setItem(draftKey, JSON.stringify({
                    title: ($('#submission-title') || {}).value || '',
                    description: ($('#submission-description') || {}).value || '',
                    github_link: ($('#submission-link') || {}).value || '',
                    notes: ($('#submission-notes') || {}).value || '',
                }));
            } catch (e) { /* ignore */ }
        };
        on($('#submission-drawer-cancel'), 'click', closeSubmissionDrawer);
        // Escape closes the drawer.
        document.addEventListener('keydown', drawerEsc);
    }

    function closeSubmissionDrawer() {
        var drawer = $('#submission-drawer');
        var back = $('#submission-drawer-backdrop');
        if (drawer) drawer.hidden = true;
        if (back) back.hidden = true;
        document.body.style.overflow = '';
        document.removeEventListener('keydown', drawerEsc);
    }

    function drawerEsc(e) {
        if (e.key === 'Escape') closeSubmissionDrawer();
    }

    function bountyDetailPage(id) {
        if (!protectedPage('bounties/' + id)) return;
        app.innerHTML = '<section class="page"><div class="container"><nav class="breadcrumb"><a href="#/bounties">Marketplace</a><span class="breadcrumb-sep">/</span><span>Loading…</span></nav><div class="loading-line"><span class="spinner"></span> Loading bounty details…</div></div></section>';

        Promise.all([api('/api/bounties/' + encodeURIComponent(id)), loadCatalogue().catch(function() { return null; })])
            .then(function(parts) {
                var bounty = parts[0];
                if (!bounty || !bounty.id) throw new Error('This bounty could not be found.');

                var business = getRole() === 'business';
                var open = String(bounty.status || 'open').toLowerCase() === 'open';

                var deadlineBit = bounty.deadline ? daysLeft(bounty.deadline) : 'No deadline';
                app.innerHTML =
                    '<section class="page"><div class="container">' +
                      '<nav class="breadcrumb" aria-label="Breadcrumb">' +
                        '<a href="#/bounties">Marketplace</a><span class="breadcrumb-sep">/</span>' +
                        '<span>' + escapeHTML(categoryLabel(bounty.category)) + '</span><span class="breadcrumb-sep">/</span>' +
                        '<span>' + escapeHTML((bounty.title || 'Bounty').slice(0, 60)) + '</span>' +
                      '</nav>' +
                      '<div class="detail-layout">' +
                        '<article class="panel">' +
                          '<div class="stack-md">' +
                            '<div class="row-sm" style="flex-wrap:wrap">' +
                              '<span class="badge badge-signal">' + escapeHTML(categoryLabel(bounty.category)) + '</span>' +
                              '<span class="status-pill status-' + statusClass(bounty.status || 'open') + '">' + escapeHTML(titleCase(bounty.status || 'open')) + '</span>' +
                              (bounty.difficulty ? '<span class="tag">' + escapeHTML(titleCase(bounty.difficulty)) + '</span>' : '') +
                            '</div>' +
                            '<h1 style="font-family:var(--font-display);font-size:var(--text-h1);font-weight:700;letter-spacing:-0.02em;margin:0">' + escapeHTML(bounty.title || 'Untitled bounty') + '</h1>' +
                            '<p class="meta row-sm" style="gap:16px;flex-wrap:wrap;color:var(--text-tertiary)">' +
                              '<span>' + icon('clock', 13) + ' ' + escapeHTML(deadlineBit) + '</span>' +
                              '<span>' + icon('file', 13) + ' ' + escapeHTML(titleCase(bounty.submission_type || 'submission')) + ' submission</span>' +
                              '<span>' + escapeHTML(workerSlotsText(bounty)) + '</span>' +
                            '</p>' +
                          '</div>' +
                          '<section class="detail-section" style="margin-top:28px"><h2>About this bounty</h2><div class="detail-description" style="color:var(--text-primary);line-height:1.65;font-size:var(--text-body)">' + escapeHTML(bounty.description || 'No description has been provided.') + '</div></section>' +
                          (bounty.project_id ? '<section class="detail-section"><h2>Part of a project</h2><p><a class="inline-link" href="#/projects/' + encodeURIComponent(bounty.project_id) + '">View the project and its other tasks</a></p></section>' : '') +
                          (bounty.blocked ? '<section class="detail-section"><div class="notice warning">' + icon('alert', 16) + ' This task waits for other tasks to be completed first: ' + escapeHTML((bounty.depends_on || []).filter(function(d) { return d.status !== 'completed'; }).map(function(d) { return d.title; }).join(', ')) + '</div></section>' : '') +
                          (bounty.acceptance_criteria && bounty.acceptance_criteria.length ? '<section class="detail-section"><h2>Acceptance criteria</h2>' + criteriaListHTML(bounty.acceptance_criteria) + '<p class="small muted">These checks guide the reviewer. A failed check does not auto-reject work.</p></section>' : '') +
                          checklistSectionHTML(bounty.completion_checklist) +
                          executionDetailHTML(bounty) +
                          participationHTML(bounty) +
                          (bounty.requirements ? '<section class="detail-section"><h2>Requirements</h2><div class="detail-description" style="line-height:1.65">' + escapeHTML(Array.isArray(bounty.requirements) ? bounty.requirements.join('\n') : bounty.requirements) + '</div></section>' : '') +
                        '</article>' +
                        '<aside class="panel detail-sidebar">' +
                          '<div class="detail-sidebar-card">' +
                            '<div class="reward-display">' +
                              '<span class="reward-label">Bounty reward</span>' +
                              '<span class="reward-amount">' + escapeHTML(formatNumber(bounty.reward_amount)) + '</span>' +
                              '<span class="reward-currency">' + escapeHTML(bounty.currency || 'NGN') + '</span>' +
                            '</div>' +
                            fundingHTML(bounty) +
                            '<dl class="detail-def">' +
                              '<div class="detail-def-row"><dt>Deadline</dt><dd>' + escapeHTML(dateText(bounty.deadline)) + '</dd></div>' +
                              '<div class="detail-def-row"><dt>Time left</dt><dd>' + escapeHTML(deadlineBit) + '</dd></div>' +
                              '<div class="detail-def-row"><dt>Category</dt><dd>' + escapeHTML(categoryLabel(bounty.category)) + '</dd></div>' +
                              '<div class="detail-def-row"><dt>Difficulty</dt><dd>' + escapeHTML(titleCase(bounty.difficulty || 'medium')) + '</dd></div>' +
                              '<div class="detail-def-row"><dt>Workers</dt><dd>' + escapeHTML(workerSlotsText(bounty)) + '</dd></div>' +
                            '</dl>' +
                            (business ?
                              '<a class="btn btn-block" href="#/dashboard">Open dashboard</a>' :
                              bounty.category === 'hospitality' ?
                              '<a class="btn btn-primary btn-block" href="#/services/' + escapeHTML(bounty.id) + '">Open this visit</a>' :
                              open && !bounty.blocked && !(bounty.my_participation && bounty.my_participation.status === 'active') ?
                              '<button class="btn btn-primary btn-block" id="open-submit-drawer" type="button">Submit to this bounty</button>' +
                              '<p class="small muted" style="text-align:center;margin:0">You can revise your submission after you send it.</p>' :
                              '<p class="small muted">This bounty is not currently accepting submissions.</p>') +
                          '</div>' +
                        '</aside>' +
                      '</div>' +
                    '</div></section>' +
                    (!business && open && !bounty.blocked ? submissionDrawerHTML(bounty) : '');

                on($('#open-submit-drawer'), 'click', function() { openSubmissionDrawer(bounty); });
                on($('#submission-drawer-close'), 'click', closeSubmissionDrawer);
                on($('#submission-drawer-backdrop'), 'click', closeSubmissionDrawer);
                on($('#submission-form'), 'submit', function(event) { submitWork(event, bounty); });
                addCompanyLink(bounty);
                addReviewAndReport(bounty);
                addWorkspace(bounty);
                addFeatureSection(bounty, 'deliverables', 'workspaceBoard');
                wireParticipation(bounty);
                if (getRole() === 'business') {
                    addFeatureSection(bounty, 'matching', 'matchingPanel');
                    addFeatureSection(bounty, 'access', 'regionAccess');
                    loadSubmissions(bounty);
                    addCloseButton(bounty);
                }
                if (getRole() !== 'business') loadMySubmission(bounty);
            })
            .catch(function(error) {
                app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a><div class="empty-state"><span class="empty-illustration">' + icon('alert', 28) + '</span><h3>Unable to open this bounty</h3><p>' + escapeHTML(friendlyApiError(error, 'Please return to the marketplace and try again.')) + '</p><a class="btn btn-primary" href="#/bounties">Back to marketplace</a></div></div></section>';
            });
    }

    function submitWork(event, bounty) {
        event.preventDefault();
        var form = event.currentTarget;
        var button = $('#submit-work-btn');
        var errorBox = $('#submission-error');
        errorBox.hidden = true;

        var values = new FormData(form);
        var payload = {
            bounty_id: bounty.id,
            title: String(values.get('title') || '').trim(),
            description: String(values.get('description') || '').trim(),
            github_link: String(values.get('github_link') || '').trim() || null
        };

        payload.notes_to_reviewer = String(values.get('notes') || '').trim() || null;
        if (!payload.title || payload.title.length < 3) {
            return showFormError(errorBox, 'Add a title of at least 3 characters.');
        }
        if (payload.description.length < 30) {
            return showFormError(errorBox, 'Explain how your work meets the requirements in at least 30 characters.');
        }
        if (!payload.github_link && bounty.submission_type !== 'text') {
            return showFormError(errorBox, 'Add a link to your work.');
        }
        if (payload.github_link) {
            try {
                var url = new URL(payload.github_link);
                if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
            } catch (e) {
                return showFormError(errorBox, 'Enter a valid http or https project URL.');
            }
        }

        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Submitting…';

        api('/api/submissions', { method: 'POST', body: payload })
            .then(function() {
                // Work is saved on the server: drop the local draft and close the drawer,
                // then re-open this bounty so the worker sees their real submission.
                try { sessionStorage.removeItem('bounty_submit_draft_' + bounty.id); } catch (e) { /* ignore */ }
                closeSubmissionDrawer();
                toast('Your submission was sent.', 'success');
                bountyDetailPage(bounty.id);
            })
            .catch(function(error) {
                showFormError(errorBox, friendlyApiError(error, 'Could not submit your work.'));
            })
            .then(function() {
                if (document.contains(button)) {
                    button.disabled = false;
                    button.innerHTML = 'Submit work ' + icon('arrow', 16);
                }
            });
    }


    /* ============ STATUS, FUNDING AND CHECKLISTS ============ */

    var SUBMISSION_STATUS_TEXT = {
        pending: 'Under review',
        revision_requested: 'Changes requested',
        approved: 'Approved',
        rejected: 'Rejected'
    };

    function statusLabel(value) {
        return SUBMISSION_STATUS_TEXT[value] || titleCase(value);
    }

    function fundingHTML(bounty) {
        if (bounty.funding_status === 'funded') {
            return '<div class="notice">' + icon('shield', 16) + ' Funded: the business has deposited the reward for this task.</div>';
        }
        return '<div class="notice warning">' + icon('alert', 16) + ' Not funded yet. Payment is not connected in this demo, so an approved submission is not guaranteed a payout.</div>';
    }

    function checklistSectionHTML(items) {
        if (!items || !items.length) return '';
        return '<section class="detail-section"><h2>Done means</h2><ul class="check-list">' +
            items.map(function(text) { return '<li><span class="checkmark">✓</span><span>' + escapeHTML(text) + '</span></li>'; }).join('') +
            '</ul><p class="small muted">Check each item before you submit. The reviewer uses the same list.</p></section>';
    }

    function statusStepsHTML(status) {
        var pending = status === 'pending';
        var outcome = status === 'approved' ? 'Approved' :
            status === 'rejected' ? 'Rejected' :
            status === 'revision_requested' ? 'Changes requested' : 'Decision';
        var steps = [
            ['Submitted', 'done'],
            ['Under review', pending ? 'current' : 'done'],
            [outcome, pending ? 'todo' : 'current']
        ];
        return '<ol class="status-steps" aria-label="Submission progress">' +
            steps.map(function(s) {
                return '<li class="' + s[1] + '">' + escapeHTML(s[0]) + '</li>';
            }).join('') + '</ol>';
    }

    /* ============ REVIEW: REQUIREMENTS BESIDE SUBMISSION ============ */

    function submissionReviewCard(s, bounty) {
        var status = String(s.status || '').toLowerCase();
        var pending = status === 'pending';
        var open = pending || status === 'revision_requested';
        var id = escapeHTML(s.id);
        var link = s.github_link ? safeLink(s.github_link) : '';
        var requirements = Array.isArray(bounty.requirements) ? bounty.requirements.join('\n') : (bounty.requirements || '');
        var asked =
            '<div class="review-col"><h4>What was asked</h4>' +
            '<p class="small muted">Submission type: ' + escapeHTML(titleCase(bounty.submission_type || 'text')) + '</p>' +
            (requirements ? '<div class="detail-description small">' + escapeHTML(requirements) + '</div>' : '<p class="small muted">No written requirements.</p>') +
            (bounty.acceptance_criteria && bounty.acceptance_criteria.length ? criteriaListHTML(bounty.acceptance_criteria) : '') +
            (bounty.completion_checklist && bounty.completion_checklist.length ?
                '<p class="small"><strong>Done means:</strong></p><ul class="criteria-list">' +
                bounty.completion_checklist.map(function(t) { return '<li>' + escapeHTML(t) + '</li>'; }).join('') + '</ul>' : '') +
            '</div>';
        var submitted =
            '<div class="review-col"><h4>What was submitted</h4>' +
            '<p class="small muted">By ' + escapeHTML(s.worker_name || 'Worker') + ' · ' + escapeHTML(dateText(s.submitted_at)) + '</p>' +
            '<p>' + escapeHTML(s.description || '') + '</p>' +
            (link ? '<p class="small"><a class="inline-link" href="' + link + '" target="_blank" rel="noopener noreferrer">Open the link to the work</a></p>' : '<p class="small muted">No link provided.</p>') +
            (s.notes_to_reviewer ? '<p class="small"><strong>Notes:</strong> ' + escapeHTML(s.notes_to_reviewer) + '</p>' : '') +
            (s.revision_notes ? '<p class="small"><strong>Changes requested:</strong> ' + escapeHTML(s.revision_notes) + '</p>' : '') +
            '</div>';
        return '<article class="dashboard-item review-item" data-submission="' + id + '">' +
            '<div class="review-body"><div class="review-head"><h3>' + escapeHTML(s.title || 'Untitled submission') + '</h3>' +
            '<span class="status-pill ' + statusClass(status) + '">' + escapeHTML(statusLabel(status)) + '</span></div>' +
            '<div class="review-compare">' + asked + submitted + '</div>' +
            (pending ? '<div class="revise-box" data-revise-box hidden><label class="small" for="revise-' + id + '">What should change?</label><textarea id="revise-' + id + '" rows="3" maxlength="1000" placeholder="Explain what needs to change"></textarea><div class="field"><label class="small" for="revise-deadline-' + id + '">Proposed new deadline (optional)</label><input id="revise-deadline-' + id + '" data-revise-deadline type="datetime-local"><span class="field-hint">The task deadline changes only if the worker accepts.</span></div><div><button class="btn btn-sm" type="button" data-revise-send="' + id + '">Send back for changes</button></div></div>' : '') +
            (open ? '<div class="reject-box" data-reject-box hidden><label class="small" for="reject-reason-' + id + '">Reason for rejection (the worker sees this)</label><textarea id="reject-reason-' + id + '" data-reject-reason rows="3" maxlength="500" placeholder="Say what was missing or wrong, so the worker knows what to change"></textarea><span class="field-hint">10–500 characters. A rejection needs a reason.</span><div><button class="btn btn-sm btn-primary" type="button" data-reject-send="' + id + '">Send rejection</button></div></div>' : '') +
            '</div><div class="dashboard-item-actions">' +
            '<button class="btn btn-sm" type="button" data-checks="' + id + '">Run checks</button>' +
            ' <button class="btn btn-sm" type="button" data-verify="' + id + '">Verification report</button>' +
            (pending ? ' <button class="btn btn-sm" type="button" data-revise="' + id + '">Request changes</button>' : '') +
            (pending ? ' <button class="btn btn-primary btn-sm" type="button" data-approve="' + id + '">' + escapeHTML(approveLabel(bounty.execution_mode)) + '</button>' : '') +
            (open ? ' <button class="btn btn-sm" type="button" data-reject="' + id + '">Reject</button>' : '') +
            '</div><div class="checks-out" data-checks-out></div><div class="verify-out" data-verify-out></div></article>';
    }

    /* ============ EXECUTION MODES: CREATE FORM, TAKING A TASK, CLOSURE ============ */

    var EXECUTION_CATALOGUE = null;
    var MODE_LABELS = {
        first_valid: 'First Valid Submission',
        competitive: 'Competitive Selection',
        team: 'Team / Parallel Execution',
        independent: 'Independent Assessment'
    };
    var CLOSURE_TEXT = {
        winner_confirmed: 'Closed: a verified winner was confirmed.',
        target_reached: 'Closed: the number of independent assessments was reached.',
        cancelled_by_business: 'Cancelled by the business.',
        deadline_passed: 'Closed: the deadline passed.'
    };
    var EVENT_TEXT = {
        bounty_created: 'Task published',
        worker_accepted: 'Worker took the task',
        worker_terms_accepted: 'Worker accepted the terms',
        worker_assigned: 'Worker assigned',
        submission_received: 'Submission received',
        submission_approved: 'Submission confirmed',
        bounty_closed: 'Task closed',
        bounty_expired: 'Deadline passed',
        bounty_cancelled: 'Task cancelled'
    };
    var SECURITY_FIELDS = [
        ['authorization_statement', 'Written authorization', 'Who approved this work and exactly what it covers. An NDA is not authorization.'],
        ['rules_of_engagement', 'Rules of engagement', 'How the work may be done, and when a worker must stop and report.'],
        ['permitted_targets', 'Permitted targets', 'The systems or pages in scope, named exactly.'],
        ['prohibited_activities', 'Prohibited activities', 'What must not be done, for example denial-of-service or testing other systems.']
    ];

    function loadCatalogue() {
        if (EXECUTION_CATALOGUE) return Promise.resolve(EXECUTION_CATALOGUE);
        return api('/api/classification').then(function(data) {
            EXECUTION_CATALOGUE = data;
            return data;
        });
    }

    function findJob(id) {
        if (!EXECUTION_CATALOGUE || !id) return null;
        var found = null;
        EXECUTION_CATALOGUE.industries.forEach(function(industry) {
            industry.job_types.forEach(function(job) {
                if (job.id === id) found = job;
            });
        });
        return found;
    }

    function modeMeta(id) {
        var list = EXECUTION_CATALOGUE ? EXECUTION_CATALOGUE.modes : [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return { id: id, label: MODE_LABELS[id] || titleCase(id), short: '', explanation: '', examples: '', use_cases: '' };
    }

    function approveLabel(mode) {
        if (mode === 'first_valid') return 'Confirm winner';
        if (mode === 'competitive') return 'Select as winner';
        if (mode === 'independent') return 'Accept assessment';
        return 'Approve';
    }

    // Plain-language check of a chosen mode against the job type. Null means no comment.
    function fitNote(job, mode) {
        if (!job) return null;
        if (job.recommended_mode === 'team') {
            return { warning: true, text: job.title + ' is usually done as a team project. Team work is set up from a project. For a single task, ' + modeMeta(mode).label + ' is used.' };
        }
        if (mode === job.recommended_mode) return null;
        if (job.alternative_modes.indexOf(mode) !== -1) {
            return { warning: false, text: 'A reasonable choice for this work. Recommended: ' + modeMeta(job.recommended_mode).label + '.' };
        }
        return {
            warning: true,
            text: job.title + ' usually works best as ' + modeMeta(job.recommended_mode).label + '. You can keep ' + modeMeta(mode).label +
                ' if you have a reason. Consider ' + modeMeta(job.recommended_mode).label + ' if you want the work finished faster or more reliably.'
        };
    }

    function executionSectionHTML() {
        return '<section class="task-step panel" id="execution-step"><span class="task-step-no">02b / How the work is completed</span>' +
            '<h2 class="step-title">How would you like this task to be completed?</h2>' +
            '<p class="small muted">Choose the format that fits the work. We suggest one from the kind of work, and you keep the final choice.</p>' +
            '<div class="form-grid"><div class="field span-2"><label for="bounty-job-type">What kind of work is this?</label>' +
            '<select id="bounty-job-type" name="job_type"><option value="">Not sure yet</option></select>' +
            '<span class="field-hint">Some kinds of work need a written authorization and rules of engagement.</span></div></div>' +
            '<div class="mode-grid" id="mode-grid" role="radiogroup" aria-label="How the task is completed"><div class="loading-line"><span class="spinner"></span> Loading options…</div></div>' +
            '<div id="execution-note" class="notice" hidden></div>' +
            '<div class="form-grid">' +
            '<div class="field"><label for="bounty-max-workers">How many workers may take this task?</label><input id="bounty-max-workers" name="max_workers" type="number" min="1" max="50" step="1" value="3"><span class="field-hint">Once this many have taken it, the task is full.</span></div>' +
            '<div class="field" id="winners-field" hidden><label for="bounty-winner-limit">How many winners will you choose?</label><input id="bounty-winner-limit" name="winner_limit" type="number" min="1" max="50" step="1" value="1"></div>' +
            '<div class="field" id="target-field" hidden><label for="bounty-target">How many independent assessments do you need?</label><input id="bounty-target" name="independent_target" type="number" min="2" max="50" step="1" value="3"><span class="field-hint">The task completes when this many are accepted.</span></div>' +
            '</div>' +
            '<div class="form-grid"><div class="field span-2"><label class="agreement-check"><input id="bounty-confidential" name="confidential" type="checkbox"><span>This task involves confidential business information. Only you and Bounty admins can see its details, so workers cannot take it.</span></label></div></div>' +
            '<div id="security-fields" class="security-fields" hidden>' +
            '<div class="notice warning">This work touches systems or sensitive information. Workers must accept your rules of engagement before they start. Write the authorization statement as well.</div>' +
            SECURITY_FIELDS.map(function(f) {
                var id = 'bounty-' + f[0].replace(/_/g, '-');
                return '<div class="field span-2"><label for="' + id + '">' + escapeHTML(f[1]) + '</label>' +
                    '<textarea id="' + id + '" name="' + f[0] + '" rows="3" maxlength="5000"></textarea>' +
                    '<span class="field-hint">' + escapeHTML(f[2]) + '</span></div>';
            }).join('') +
            '</div></section>';
    }

    function renderExecutionControls() {
        var select = $('#bounty-job-type');
        var grid = $('#mode-grid');
        if (!select || !grid || !EXECUTION_CATALOGUE) return;
        select.innerHTML = '<option value="">Not sure yet</option>' + EXECUTION_CATALOGUE.industries.map(function(industry) {
            return '<optgroup label="' + escapeHTML(industry.title) + '">' + industry.job_types.map(function(job) {
                return '<option value="' + escapeHTML(job.id) + '">' + escapeHTML(job.title) + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
        grid.innerHTML = EXECUTION_CATALOGUE.modes.map(function(m) {
            var disabled = m.id === 'team';
            return '<label class="mode-card mode-' + escapeHTML(m.id) + (disabled ? ' is-disabled' : '') + '">' +
                '<input type="radio" name="execution_mode" value="' + escapeHTML(m.id) + '"' + (m.id === 'competitive' ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
                '<span class="mode-head"><span class="mode-dot" aria-hidden="true"></span><strong>' + escapeHTML(m.label) + '</strong>' +
                '<span class="mode-badge" data-badge="' + escapeHTML(m.id) + '" hidden>Recommended</span></span>' +
                '<span class="mode-short">' + escapeHTML(m.short) + '</span>' +
                '<span class="small">' + escapeHTML(m.explanation) + '</span>' +
                '<span class="small muted"><strong>Examples:</strong> ' + escapeHTML(m.examples) + '</span>' +
                '<span class="small muted"><strong>Best when:</strong> ' + escapeHTML(m.use_cases) + '</span>' +
                (disabled ? '<span class="small"><strong>Set up from a project.</strong> Create a project and choose team work there.</span>' : '') +
                '</label>';
        }).join('');
        on(select, 'change', onJobChange);
        $$('input[name="execution_mode"]', grid).forEach(function(radio) { on(radio, 'change', updateExecutionUI); });
        updateExecutionUI();
    }

    function onJobChange() {
        var job = findJob($('#bounty-job-type').value);
        if (job) {
            var target = job.recommended_mode === 'team' ?
                (job.alternative_modes.filter(function(m) { return m !== 'team'; })[0] || 'competitive') :
                job.recommended_mode;
            var radio = $('#mode-grid input[value="' + target + '"]');
            if (radio && !radio.disabled) radio.checked = true;
            $('#bounty-max-workers').value = job.recommended_mode === 'team' ? 3 : job.suggested_workers;
        }
        updateExecutionUI();
    }

    function updateExecutionUI() {
        var grid = $('#mode-grid');
        if (!grid) return;
        var job = findJob(($('#bounty-job-type') || {}).value);
        var checked = grid.querySelector('input[name="execution_mode"]:checked');
        var mode = checked ? checked.value : 'competitive';

        $$('[data-badge]', grid).forEach(function(badge) {
            badge.hidden = !(job && job.recommended_mode === badge.getAttribute('data-badge'));
        });
        $('#winners-field').hidden = mode !== 'competitive';
        $('#target-field').hidden = mode !== 'independent';
        $('#security-fields').hidden = !(job && job.requires_authorization);

        var note = fitNote(job, mode);
        var box = $('#execution-note');
        box.hidden = !note;
        box.className = 'notice' + (note && note.warning ? ' warning' : '');
        box.textContent = note ? note.text : '';
    }

    // Values for the create request. Team is not offered here (it comes from a project), so the
    // disabled radio is never sent.
    function executionPayload(values) {
        var mode = String(values.get('execution_mode') || 'competitive');
        var maxWorkers = Number(values.get('max_workers') || 3);
        if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 50) {
            throw new Error('Enter a whole number of workers from 1 to 50.');
        }
        var jobValue = String(values.get('job_type') || '');
        var payload = { execution_mode: mode, job_type: jobValue || null, max_workers: maxWorkers, confidential: Boolean(values.get('confidential')) };
        if (mode === 'competitive') payload.winner_limit = Number(values.get('winner_limit') || 1);
        if (mode === 'independent') payload.independent_target = Number(values.get('independent_target') || 3);
        var job = findJob(jobValue);
        if (job && job.requires_authorization) {
            SECURITY_FIELDS.forEach(function(f) {
                payload[f[0]] = String(values.get(f[0]) || '').trim();
            });
        }
        return payload;
    }

    function applyExecutionDraft(draft) {
        if (!$('#bounty-job-type') || !EXECUTION_CATALOGUE) return;
        if (draft.job_type && findJob(draft.job_type)) $('#bounty-job-type').value = draft.job_type;
        if (draft.execution_mode) {
            var radio = $('#mode-grid input[value="' + draft.execution_mode + '"]');
            if (radio && !radio.disabled) radio.checked = true;
        }
        if (draft.suggested_workers) $('#bounty-max-workers').value = draft.suggested_workers;
        updateExecutionUI();
    }

    function wireExecution() {
        loadCatalogue().then(renderExecutionControls).catch(function() {
            var grid = $('#mode-grid');
            if (grid) grid.innerHTML = '<div class="notice warning">The task formats could not be loaded. Refresh the page to try again.</div>';
        });
    }

    // ---- detail page: how the task is completed, taking it, and closure

    function scopeFieldsHTML(scope) {
        var rows = [
            ['Written authorization', scope.authorization_statement],
            ['Rules of engagement', scope.rules_of_engagement],
            ['Permitted targets', scope.permitted_targets],
            ['Prohibited activities', scope.prohibited_activities]
        ];
        return rows.map(function(r) {
            return '<div class="review-col"><h4>' + escapeHTML(r[0]) + '</h4><div class="detail-description small">' + escapeHTML(r[1] || '') + '</div></div>';
        }).join('');
    }

    function executionDetailHTML(bounty) {
        var business = getRole() === 'business';
        var mode = modeMeta(bounty.execution_mode || 'competitive');
        var html = '<section class="detail-section execution-section"><h2>How this task is completed</h2>' +
            '<div class="mode-summary"><span class="mode-dot mode-' + escapeHTML(mode.id) + '" aria-hidden="true"></span>' +
            '<div><strong>' + escapeHTML(mode.label) + '</strong><p class="small">' + escapeHTML(mode.explanation || mode.short || '') + '</p></div></div>' +
            '<p class="small muted">' + escapeHTML(String(bounty.participants_count || 0)) + ' of ' + escapeHTML(String(bounty.max_workers || 3)) +
            ' workers have taken this task.' +
            (mode.id === 'competitive' ? ' The business chooses ' + escapeHTML(String(bounty.winner_limit || 1)) + ' winner(s).' : '') +
            (mode.id === 'independent' ? ' The task completes after ' + escapeHTML(String(bounty.independent_target || '')) + ' accepted assessments.' : '') +
            '</p>';
        if (bounty.closure_reason && CLOSURE_TEXT[bounty.closure_reason]) {
            html += '<div class="notice">' + escapeHTML(CLOSURE_TEXT[bounty.closure_reason]) + '</div>';
        }
        if (business && bounty.scope && !bounty.scope.restricted) {
            html += '<h3 class="small-heading">Authorization and rules you published</h3>' + scopeFieldsHTML(bounty.scope);
        }
        return html + '</section>';
    }

    function participationHTML(bounty) {
        if (getRole() === 'business') {
            return '<section class="detail-section" id="participation-section"><h2>Workers on this task</h2>' +
                '<div id="participants-box"><div class="loading-line"><span class="spinner"></span> Loading…</div></div>' +
                '<button class="btn btn-sm" type="button" id="history-toggle">Show audit trail</button>' +
                '<div id="history-box" hidden></div></section>';
        }
        if (String(bounty.status || '').toLowerCase() !== 'open' || bounty.closure_reason) return '';
        var me = bounty.my_participation;
        var needsNda = Boolean(bounty.requires_authorization);
        var html = '<section class="detail-section" id="participation-section"><h2>Take this task</h2>';

        if (me && me.status === 'active' && (!needsNda || me.roe_accepted)) {
            return html + '<div class="notice">You are on this task. <strong>Next step:</strong> open the workspace below to talk to the business and follow the deliverables. Due ' + escapeHTML(dateText(bounty.deadline)) + '.</div></section>';
        }
        if (bounty.execution_mode === 'team' && !(me && me.status === 'assigned')) {
            return html + '<p class="small muted">Team work is assigned by the business. You cannot take it yourself.</p></section>';
        }
        if (!needsNda) {
            var label = me && me.status === 'assigned' ? 'Confirm assignment' : 'Take this task';
            return html + '<button class="btn btn-primary" type="button" id="take-task">' + label + '</button></section>';
        }
        var scope = bounty.scope && !bounty.scope.restricted ? scopeFieldsHTML(bounty.scope) :
            '<p class="small muted">The rules are not available to you yet.</p>';
        return html + '<h3 class="small-heading">Rules of engagement</h3>' + scope +
            '<label class="check-line"><input type="checkbox" id="accept-roe"> I have read these rules and will follow them.</label>' +
            '<button class="btn btn-primary" type="button" id="accept-roe-btn" disabled>Accept the rules</button></section>';
    }

    function sendAccept(bountyId, body, button) {
        button.disabled = true;
        api('/api/bounties/' + encodeURIComponent(bountyId) + '/accept', { method: 'POST', body: body })
            .then(function() {
                toast('Saved.', 'success');
                bountyDetailPage(bountyId);
            })
            .catch(function(error) {
                toast(friendlyApiError(error, 'Could not save this.'), 'error');
                button.disabled = false;
            });
    }

    function wireParticipation(bounty) {
        if (getRole() === 'business') {
            loadParticipants(bounty);
            wireHistory(bounty);
            return;
        }
        var take = $('#take-task');
        if (take) {
            on(take, 'click', function() {
                sendAccept(bounty.id, {}, take);
            });
        }
        var roe = $('#accept-roe');
        var roeButton = $('#accept-roe-btn');
        if (roe && roeButton) {
            on(roe, 'change', function() { roeButton.disabled = !roe.checked; });
            on(roeButton, 'click', function() { sendAccept(bounty.id, { roe_accepted: true }, roeButton); });
        }
    }

    function loadParticipants(bounty) {
        var box = $('#participants-box');
        if (!box) return;
        api('/api/bounties/' + encodeURIComponent(bounty.id) + '/participants').then(function(rows) {
            box.innerHTML = rows.length ? '<ul class="criteria-list">' + rows.map(function(p) {
                var terms = bounty.requires_authorization ?
                    ', rules ' + (p.roe_accepted ? 'accepted' : 'pending') : '';
                return '<li><strong>' + escapeHTML(p.worker_name) + '</strong> · ' + escapeHTML(titleCase(p.status)) + escapeHTML(terms) + '</li>';
            }).join('') + '</ul>' : '<p class="small muted">No workers have taken this task yet.</p>';
        }).catch(function(error) {
            box.innerHTML = '<p class="small muted">' + escapeHTML(friendlyApiError(error, 'Could not load the workers.')) + '</p>';
        });
    }

    function wireHistory(bounty) {
        var toggle = $('#history-toggle');
        var box = $('#history-box');
        if (!toggle || !box) return;
        on(toggle, 'click', function() {
            if (!box.hidden) {
                box.hidden = true;
                toggle.textContent = 'Show audit trail';
                return;
            }
            api('/api/bounties/' + encodeURIComponent(bounty.id) + '/history').then(function(events) {
                box.innerHTML = events.length ? '<ol class="criteria-list">' + events.map(function(e) {
                    return '<li><span class="small muted">' + escapeHTML(dateText(e.at)) + '</span> ' + escapeHTML(e.actor) + ': ' +
                        escapeHTML(EVENT_TEXT[e.event] || titleCase(e.event)) + '</li>';
                }).join('') + '</ol>' : '<p class="small muted">No events yet.</p>';
                box.hidden = false;
                toggle.textContent = 'Hide audit trail';
            }).catch(function(error) {
                box.innerHTML = '<p class="small muted">' + escapeHTML(friendlyApiError(error, 'Could not load the audit trail.')) + '</p>';
                box.hidden = false;
            });
        });
    }

    /* ============ BUSINESS REVIEW ============ */

    function loadSubmissions(bounty) {
        var article = $('.detail-layout > article');
        if (!article) return;

        var section = document.createElement('section');
        section.className = 'detail-section';
        section.id = 'review-section';
        section.innerHTML = '<h2>Submissions</h2><div data-duplicates-slot></div><div id="review-list"><div class="loading-line"><span class="spinner"></span> Loading submissions…</div></div>';
        article.appendChild(section);
        mountFeature('duplicateReview', section.querySelector('[data-duplicates-slot]'), bounty);

        api('/api/submissions/bounty/' + encodeURIComponent(bounty.id))
            .then(function(rows) {
                var list = $('#review-list');
                if (!list) return;
                if (!rows || !rows.length) {
                    list.innerHTML = '<p class="muted">No submissions yet.</p>';
                    return;
                }
                list.innerHTML = rows.map(function(row) { return submissionReviewCard(row, bounty); }).join('');
                wireSubmissionTools(list, bounty);
                $$('[data-approve]', list).forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        inlineConfirm(btn, 'Approve this submission? This marks the bounty as completed.', 'Approve', function() {
                            approveSubmission(bounty, btn.getAttribute('data-approve'), btn);
                        });
                    });
                });
                $$('[data-reject]', list).forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var box = btn.closest('[data-submission]').querySelector('[data-reject-box]');
                        if (box) box.hidden = !box.hidden;
                    });
                });
                $$('[data-reject-send]', list).forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var card = btn.closest('[data-submission]');
                        var reason = String(card.querySelector('[data-reject-reason]').value || '').trim();
                        if (reason.length < 10) return toast('Give the worker a reason (at least 10 characters).', 'error');
                        inlineConfirm(btn, 'Reject this submission? The worker will see your reason and will not be able to resubmit to this bounty.', 'Reject', function() {
                            rejectSubmission(bounty, btn.getAttribute('data-reject-send'), btn, reason);
                        });
                    });
                });
            })
            .catch(function(error) {
                var list = $('#review-list');
                if (list) list.innerHTML = '<div class="notice warning">' + icon('alert', 16) + ' ' + escapeHTML(friendlyApiError(error, 'Could not load submissions.')) + '</div>';
            });
    }

    // Inline confirmation inside the submission card: the decision is explicit, and nothing blocks the page.
    function inlineConfirm(button, message, label, onYes) {
        var card = button.closest('[data-submission]') || button.parentNode;
        var old = card.querySelector('[data-inline-confirm]');
        if (old) old.parentNode.removeChild(old);
        var box = document.createElement('div');
        box.className = 'notice warning inline-confirm';
        box.setAttribute('data-inline-confirm', '');
        box.setAttribute('role', 'alert');
        box.innerHTML = '<p style="margin:0 0 10px">' + escapeHTML(message) + '</p><div class="row-sm"><button class="btn btn-sm btn-primary" type="button" data-yes>' + escapeHTML(label) + '</button><button class="btn btn-sm" type="button" data-no>Cancel</button></div>';
        card.appendChild(box);
        box.querySelector('[data-no]').addEventListener('click', function() { box.parentNode.removeChild(box); button.focus(); });
        box.querySelector('[data-yes]').addEventListener('click', function() { box.parentNode.removeChild(box); onYes(); });
        box.querySelector('[data-yes]').focus();
    }

    function approveSubmission(bounty, submissionId, button) {
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Approving…';

        api('/api/submissions/' + encodeURIComponent(submissionId) + '/approve', { method: 'POST' })
            .then(function() {
                toast('Submission approved. Payment is simulated.', 'success');
                bountyDetailPage(bounty.id);
            })
            .catch(function(error) {
                toast(friendlyApiError(error, 'Could not approve this submission.'), 'error');
                button.disabled = false;
                button.textContent = 'Approve';
            });
    }

    function rejectSubmission(bounty, submissionId, button, reason) {
        button.disabled = true;

        api('/api/submissions/' + encodeURIComponent(submissionId) + '/reject', { method: 'POST', body: { reason: reason } })
            .then(function() {
                toast('Submission rejected. The worker has your reason.', 'success');
                bountyDetailPage(bounty.id);
            })
            .catch(function(error) {
                toast(friendlyApiError(error, 'Could not reject this submission.'), 'error');
                button.disabled = false;
            });
    }

    /* ============ WORKER STATUS ============ */

    function loadMySubmission(bounty) {
        if (!$('#submit-section')) return;
        api('/api/submissions/mine')
            .then(function(rows) {
                var mine = (rows || []).filter(function(s) {
                    return String(s.bounty_id) === String(bounty.id);
                })[0];
                var section = $('#submit-section');
                if (!mine || !section) return;
                section.innerHTML = '<h2>Your submission</h2>' +
                    '<div class="dashboard-item"><div><h3>' + escapeHTML(mine.title || 'Untitled submission') + '</h3>' +
                    '<p class="small muted">Submitted ' + escapeHTML(dateText(mine.submitted_at)) + '</p></div>' +
                    '<span class="status-pill ' + statusClass(mine.status) + '">' + escapeHTML(statusLabel(mine.status)) + '</span></div>' +
                    statusStepsHTML(mine.status) +
                    (mine.status === 'rejected' ? '<div class="notice warning"><strong>Why this was rejected:</strong> ' + escapeHTML(mine.rejection_reason || 'No reason was recorded.') + '</div>' : '') +
                    (mine.status === 'revision_requested' && mine.revision_notes ? '<div class="notice"><strong>Changes requested:</strong> ' + escapeHTML(mine.revision_notes) + '</div>' : '') +
                    '<p class="small muted">Each worker can submit once per bounty.</p>';
            })
            .catch(function() {
                // If the status can't be loaded, keep the submit form.
            });
    }

    /* ============ CREATE BOUNTY ============ */

    function createBountyPage() {
        if (!protectedPage('bounties/new')) return;
        if (getRole() !== 'business') {
            app.innerHTML = '<section class="page"><div class="container"><div class="empty-state"><span class="empty-illustration">' + icon('shield', 28) + '</span><h3>Business account required</h3><p>Only business accounts can publish bounties. You can still explore open opportunities as a worker.</p><a class="btn btn-primary" href="#/bounties">Explore bounties</a></div></div></section>';
            return;
        }

        app.innerHTML =
            '<section class="page"><div class="container"><a class="back-link" href="#/dashboard">' + icon('arrowLeft', 16) + ' Back to dashboard</a>' +
            '<div class="page-header"><span class="eyebrow">Create a task</span><h1>Start with a clear finish line.</h1><p>Define the scope before asking someone to commit. Your draft is private until you publish.</p></div>' +
            '<section class="panel ai-draft" id="ai-draft" aria-labelledby="ai-draft-title"><span class="eyebrow">Draft with AI</span><h2 id="ai-draft-title">Describe the goal in your own words.</h2>' +
            '<p class="small muted">The assistant fills in the form below. You review and change everything before you publish. Nothing is saved until you submit the form.</p>' +
            '<div class="field"><label for="ai-goal">Your goal</label><textarea id="ai-goal" rows="3" maxlength="4000" placeholder="e.g. I run a bakery and need a one-page site with our menu, hours and a contact form."></textarea></div>' +
            '<div class="form-actions"><button class="btn btn-primary btn-sm" id="ai-draft-btn" type="button">Draft the task</button><span class="small muted" id="ai-status" aria-live="polite"></span></div>' +
            '<div id="ai-notes" class="ai-notes" hidden></div></section>' +
            '<div class="form-layout"><form id="create-bounty-form" class="form task-form" novalidate>' +
            '<div id="create-error" class="form-error" hidden role="alert"></div>' +

            '<section class="task-step panel"><span class="task-step-no">01 / Scope and outcome</span>' +
            '<div class="form-grid">' +
            '<div class="field span-2"><label for="bounty-title">Task title</label><input id="bounty-title" name="title" required minlength="3" maxlength="200" placeholder="e.g. Build a responsive landing page"></div>' +
            '<div class="field span-2"><label for="bounty-description">What should be different when this is done?</label><textarea id="bounty-description" name="description" required minlength="10" maxlength="10000" placeholder="Explain the problem, desired outcome, and context"></textarea></div>' +
            '<div class="field"><label for="bounty-category">Category</label><select id="bounty-category" name="category" required><option value="dev">Development</option><option value="design">Design</option><option value="content">Content</option><option value="marketing">Marketing</option><option value="other">Other</option></select></div>' +
            '<div class="field"><label for="bounty-difficulty">Difficulty</label><select id="bounty-difficulty" name="difficulty" required><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>' +
            '</div></section>' +

            '<section class="task-step panel"><span class="task-step-no">02 / Deliverables and acceptance criteria</span>' +
            '<div class="form-grid">' +
            '<div class="field"><label for="bounty-submission-type">What the worker submits</label><select id="bounty-submission-type" name="submission_type" required><option value="github">GitHub link</option><option value="url">Website or URL</option><option value="file">File</option><option value="text">Written response</option></select></div>' +
            '<div class="field span-2"><label for="bounty-requirements">Requirements (optional)</label><textarea id="bounty-requirements" name="requirements" maxlength="10000" placeholder="List the key requirements, one per line"></textarea><span class="field-hint">Avoid requesting sensitive personal information.</span></div>' +
            '<div class="field span-2"><label for="bounty-criteria">Acceptance criteria (optional)</label><textarea id="bounty-criteria" name="acceptance_criteria" rows="4" placeholder="' + escapeHTML(CRITERIA_PLACEHOLDER) + '"></textarea><span class="field-hint">' + escapeHTML(CRITERIA_HINT) + '</span></div>' +
            '<div class="field span-2"><label for="bounty-checklist">Done means (optional)</label><textarea id="bounty-checklist" name="completion_checklist" rows="3" maxlength="2000" placeholder="One item per line, e.g. Contact form sends an email"></textarea><span class="field-hint">Workers see this before they start. Up to 10 items, 3–200 characters each.</span></div>' +
            '</div></section>' +

            executionSectionHTML() +
            '<section class="task-step panel"><span class="task-step-no">03 / Reward and dates</span>' +
            '<div class="form-grid">' +
            '<div class="field"><label for="bounty-reward">Fixed reward</label><div class="row-sm" style="gap:8px"><input id="bounty-reward" name="reward_amount" type="number" required min="0.01" max="1000000" step="0.01" placeholder="15000.00" style="flex:1;min-width:0"><select id="bounty-currency" name="currency" aria-label="Reward currency" style="width:auto"><option value="NGN">NGN</option></select></div><span class="field-hint">Up to two decimal places. The currency is one your region supports.</span></div>' +
            '<div class="field"><label for="bounty-deadline">Deadline</label><input id="bounty-deadline" name="deadline" type="datetime-local" required><span class="field-hint">Choose a future date and time.</span></div>' +
            '</div></section>' +
            '<div data-budget-slot></div>' +

            '<section class="task-step panel"><span class="task-step-no">04 / Publish</span>' +
            '<div class="notice warning">Demo notice: creating a bounty does not deposit funds. Payments are simulated in this prototype.</div>' +
            '<div class="form-actions"><button class="btn btn-primary" id="create-bounty-btn" type="submit">Publish task ' + icon('arrow', 16) + '</button></div></section>' +
            '</form>' +

            '<aside class="helper-panel task-preview" aria-label="Worker preview"><span class="task-step-no">Worker preview</span>' +
            '<span class="status-pill">Draft, not published</span>' +
            '<h3 id="preview-title" class="preview-heading">Your task title</h3>' +
            '<p id="preview-reward" class="preview-reward"><strong>—</strong> <span>fixed reward</span></p>' +
            '<p class="small muted" id="preview-deadline">Deadline not set</p>' +
            '<ul class="criteria-list" id="preview-criteria"><li class="muted">Criteria appear here as you type them.</li></ul>' +
            '</aside></div></div></section>';

        on($('#create-bounty-form'), 'submit', submitBounty);
        on($('#create-bounty-form'), 'input', updateTaskPreview);
        wireAiDraft();
        loadCurrencies();
        wireExecution();
        mountFeature('budgetGuidance', app.querySelector('[data-budget-slot]'));
        updateTaskPreview();
    }

    // AI Task Architect: fills the create form from a plain-language goal. Saves nothing itself.
    // Reward currencies come from the server, so the list always matches what a bounty may use.
    function loadCurrencies() {
        var select = document.getElementById('bounty-currency');
        if (!select) return;
        api('/api/global/regions').then(function(res) {
            var list = (res && res.currencies) || [];
            if (!list.length) return;
            var fallback = res.default_currency || 'NGN';
            select.innerHTML = list.map(function(c) {
                return '<option value="' + escapeHTML(c.code) + '"' + (c.code === fallback ? ' selected' : '') + '>' + escapeHTML(c.code) + '</option>';
            }).join('');
        }).catch(function() { /* keep the NGN default */ });
    }

    function wireAiDraft() {
        var btn = $('#ai-draft-btn');
        var status = $('#ai-status');
        if (!btn) return;
        function setStatus(text) { if (status) status.textContent = text; }

        api('/api/ai/status').then(function(info) {
            if (!info.enabled) {
                btn.disabled = true;
                setStatus('AI drafting is not set up on this server yet. You can still fill in the form below.');
                return;
            }
            setStatus(info.model_connected ? info.remaining + ' of ' + info.limit + ' AI drafts left today' :
                'Rules-based drafting. No AI model is connected, so review every field.');
        }).catch(function() { setStatus(''); });

        btn.addEventListener('click', function() {
            var goal = String(($('#ai-goal') || {}).value || '').trim();
            if (goal.length < 10) return toast('Describe the goal in at least 10 characters.', 'error');
            btn.disabled = true;
            setStatus('Drafting…');
            api('/api/ai/bounty-draft', { method: 'POST', body: { prompt: goal } })
                .then(function(result) {
                    applyAiDraft(result.draft);
                    showAiNotes(result);
                    if (result.usage) {
                        setStatus(result.usage.limit - result.usage.used + ' of ' + result.usage.limit + ' AI drafts left today');
                    } else {
                        setStatus('Rules-based draft. Review every field.');
                    }
                    toast('Draft filled in. Review it before you publish.', 'success');
                })
                .catch(function(error) {
                    setStatus('');
                    toast(friendlyApiError(error, 'The draft could not be made. Try again.'), 'error');
                })
                .then(function() { btn.disabled = false; });
        });
    }

    function applyAiDraft(draft) {
        function set(id, value) { var el = $('#' + id); if (el && value !== null && value !== undefined) el.value = value; }
        set('bounty-title', draft.title);
        set('bounty-description', draft.description);
        set('bounty-category', draft.category);
        set('bounty-difficulty', draft.difficulty);
        set('bounty-submission-type', draft.submission_type);
        set('bounty-requirements', (draft.requirements || []).join('\n'));
        set('bounty-criteria', (draft.acceptance_criteria || []).map(function(c) {
            var rule = c.rule;
            var spec = '';
            if (rule && rule.type === 'min_words') spec = ' | words:' + rule.min;
            else if (rule && rule.type === 'link_required') spec = ' | link';
            else if (rule && rule.type === 'link_host') spec = ' | host:' + rule.hosts.join(',');
            return c.text + spec;
        }).join('\n'));
        if (draft.suggested_reward) set('bounty-reward', draft.suggested_reward.amount);
        if (draft.suggested_deadline) {
            var d = new Date(draft.suggested_deadline);
            var pad = function(n) { return String(n).padStart(2, '0'); };
            set('bounty-deadline', d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()));
        }
        applyExecutionDraft(draft);
        updateTaskPreview();
    }

    function showAiNotes(result) {
        var box = $('#ai-notes');
        if (!box) return;
        var draft = result.draft;
        var section = function(title, items) {
            if (!items || !items.length) return '';
            return '<div><strong class="small">' + escapeHTML(title) + '</strong><ul>' + items.map(function(i) { return '<li>' + escapeHTML(i) + '</li>'; }).join('') + '</ul></div>';
        };
        var reason = draft.execution_reason ? '<p class="small"><strong>Suggested format:</strong> ' + escapeHTML(draft.execution_reason) + ' Change it if it does not fit.</p>' : '';
        var reward = draft.suggested_reward ?
            '<p class="small"><strong>Suggested reward: ' + escapeHTML(draft.suggested_reward.amount) + '.</strong> ' + escapeHTML(draft.suggested_reward.note) + ' This is a suggestion, not a decision.</p>' : '';
        box.innerHTML = reason + reward +
            section('Questions to answer before publishing', draft.questions) +
            section('Missing or unclear', draft.missing_info) +
            section('Please check', result.issues);
        box.hidden = box.innerHTML.trim() === '';
    }

    // Keeps the worker preview in step with the form. Reads only; never changes what is submitted.
    function updateTaskPreview() {
        var title = ($('#bounty-title') || {}).value || '';
        var reward = ($('#bounty-reward') || {}).value || '';
        var deadline = ($('#bounty-deadline') || {}).value || '';
        var criteriaText = ($('#bounty-criteria') || {}).value || '';
        var titleEl = $('#preview-title');
        var rewardEl = $('#preview-reward');
        var deadlineEl = $('#preview-deadline');
        var criteriaEl = $('#preview-criteria');
        if (!titleEl) return;
        titleEl.textContent = title.trim() || 'Your task title';
        rewardEl.innerHTML = '<strong>' + (reward ? escapeHTML(money(reward)) : '—') + '</strong> <span>fixed reward</span>';
        var d = deadline ? new Date(deadline) : null;
        deadlineEl.textContent = d && !isNaN(d.getTime()) ? 'Due ' + dateText(d.toISOString()) : 'Deadline not set';
        var lines = criteriaText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
        criteriaEl.innerHTML = lines.length ?
            lines.map(function(line, i) {
                return '<li class="criterion-line"><span class="criterion-id">C' + String(i + 1).padStart(2, '0') + '</span> <span>' + escapeHTML(line.split('|')[0].trim()) + '</span></li>';
            }).join('') :
            '<li class="muted">Criteria appear here as you type them.</li>';
    }

    function submitBounty(event) {
        event.preventDefault();
        var form = event.currentTarget;
        var button = $('#create-bounty-btn');
        var errorBox = $('#create-error');
        errorBox.hidden = true;

        var values = new FormData(form);
        var title = String(values.get('title') || '').trim();
        var description = String(values.get('description') || '').trim();
        var reward = String(values.get('reward_amount') || '').trim();
        var deadlineRaw = String(values.get('deadline') || '');
        var requirements = String(values.get('requirements') || '').trim();

        if (!title || !description) return showFormError(errorBox, 'Enter a title and description.');
        if (!/^\d+(?:\.\d{1,2})?$/.test(reward) || Number(reward) <= 0) {
            return showFormError(errorBox, 'Enter a valid positive reward with up to two decimal places.');
        }
        var deadline = new Date(deadlineRaw);
        if (!deadlineRaw || isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
            return showFormError(errorBox, 'Choose a deadline in the future.');
        }

        var criteria;
        try {
            criteria = parseCriteriaText(values.get('acceptance_criteria'));
        } catch (parseError) {
            return showFormError(errorBox, parseError.message);
        }
        var execution;
        try {
            execution = executionPayload(values);
        } catch (executionError) {
            return showFormError(errorBox, executionError.message);
        }
        var checklist = String(values.get('completion_checklist') || '').split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
        if (checklist.length > 10) return showFormError(errorBox, 'Use up to 10 items in the completion checklist.');
        if (checklist.some(function(item) { return item.length < 3 || item.length > 200; })) {
            return showFormError(errorBox, 'Each checklist item needs 3-200 characters.');
        }
        var payload = {
            title: title,
            description: description,
            category: values.get('category'),
            difficulty: values.get('difficulty'),
            reward_amount: Number(reward).toFixed(2),
            currency: String(values.get('currency') || 'NGN'),
            deadline: deadline.toISOString(),
            submission_type: values.get('submission_type'),
            requirements: requirements,
            acceptance_criteria: criteria,
            completion_checklist: checklist
        };
        Object.assign(payload, execution);

        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Publishing…';

        api('/api/bounties', { method: 'POST', body: payload })
            .then(function(bounty) {
                toast('Bounty created successfully.', 'success');
                if (bounty && bounty.id) go('bounties/' + encodeURIComponent(bounty.id));
                else go('dashboard');
            })
            .catch(function(error) {
                showFormError(errorBox, friendlyApiError(error, 'Could not create this bounty. Check the form and try again.'));
            })
            .then(function() {
                if (document.contains(button)) {
                    button.disabled = false;
                    button.innerHTML = 'Publish bounty ' + icon('arrow', 16);
                }
            });
    }

    /* ============ DASHBOARD ============ */

    function dashboardPage() {
        if (!protectedPage('dashboard')) return;
        var role = getRole();

        app.innerHTML =
            '<section class="page"><div class="container"><div class="market-top"><div><span class="eyebrow">Your workspace</span><h1>Welcome, ' + escapeHTML((state.user.name || 'there').split(' ')[0]) + '</h1><p>Manage your Bounty activity and keep track of what\'s happening next.</p></div>' +
            (role === 'business' ?
                '<a class="btn" href="#/projects/new">Plan a project</a> <a class="btn btn-primary" href="#/bounties/new">' + icon('plus', 17) + ' Create a bounty</a>' :
                '<a class="btn btn-primary" href="#/bounties">Explore bounties ' + icon('arrow', 16) + '</a>') +
            '</div><div id="dashboard-content"><div class="loading-line"><span class="spinner"></span> Loading your dashboard…</div></div></div></section>';
        var target = $('#dashboard-content');

        api('/api/dashboard/' + encodeURIComponent(state.user.id))
            .then(function(data) {
                var s = (data && data.stats) || {};
                var ownBounties = (data && data.active_bounties) || [];
                var submissions = (data && data.recent_submissions) || [];

                var firstTake = s.minutes_to_first_take == null ? 'No takers yet' :
                    (Number(s.minutes_to_first_take) < 60 ? s.minutes_to_first_take + ' min' : Math.round(Number(s.minutes_to_first_take) / 60) + ' h');
                var stats = role === 'business' ? [
                    ['Active bounties', nz(s.active_bounties, 0)],
                    ['Completed', nz(s.completed_bounties, 0)],
                    ['Pending review', nz(s.pending_submissions, 0)],
                    ['Total spent', money(nz(s.total_spent, 0))],
                    ['Average time to first taker', firstTake],
                    ['Visits confirmed', nz(s.visits_confirmed, 0)]
                ] : [
                    ['Active bounties', nz(s.active_bounties, 0)],
                    ['Completed', nz(s.completed_bounties, 0)],
                    ['Recorded earnings', money(nz(s.total_earned, nz(state.user.total_earned, 0)))]
                ];

                var list = role === 'business' ? ownBounties : submissions;

                var statsHTML = stats.map(function(pair) {
                    var label = pair[0];
                    var value = pair[1];
                    var shown = typeof value === 'number' ? value.toLocaleString() : escapeHTML(value);
                    return '<article class="stat-card"><span>' + escapeHTML(label) + '</span><strong>' + shown + '</strong></article>';
                }).join('');

                var listHTML = list.length ?
                    '<div class="dashboard-list">' + list.map(function(item) { return dashboardItem(item, role); }).join('') + '</div>' :
                    '<div class="empty-state"><span class="empty-illustration">' + icon('file', 28) + '</span><h3>' + (role === 'business' ? 'No bounties listed here yet' : 'No submissions to show yet') + '</h3><p>' + (role === 'business' ? 'Create your first bounty to start receiving submissions.' : 'Explore the marketplace and submit work to a bounty that fits your skills.') + '</p>' +
                    (role === 'business' ? '<a class="btn btn-primary" href="#/bounties/new">Create a bounty</a>' : '<a class="btn btn-primary" href="#/bounties">Explore bounties</a>') + '</div>';

                target.innerHTML =
                    '<div class="dashboard-grid">' + statsHTML + '</div>' +
                    '<section class="dashboard-section"><h2>' + (role === 'business' ? 'Your bounties' : 'Your submissions') + '</h2>' + listHTML + '</section>';
                if (role === 'business') loadMyProjects(target);
                else loadRevisionRequests(target);
            })
            .catch(function(error) {
                target.innerHTML =
                    '<div class="notice warning">' + icon('alert', 16) + ' The dashboard could not load your data. ' + escapeHTML(friendlyApiError(error, 'Try signing in again.')) + '</div>' +
                    '<div class="hero-actions"><a class="btn btn-primary" href="#/bounties">Explore bounties</a><button class="btn" id="retry-dashboard" type="button">Retry</button></div>';
                on($('#retry-dashboard'), 'click', dashboardPage);
            });
    }

    function dashboardItem(item, role) {
        var title = item.title || item.bounty_title || 'Untitled item';
        var status = item.status || 'unknown';
        var date = item.created_at || item.submitted_at || item.deadline;
        var id = item.id;
        var link = id && role === 'business' ?
            '<a class="btn btn-sm" href="#/bounties/' + encodeURIComponent(id) + '">View bounty</a>' :
            '';
        return '<article class="dashboard-item"><div><h3>' + escapeHTML(title) + '</h3><p>' + escapeHTML(date ? dateText(date) : 'Date unavailable') + ' · ' + escapeHTML(titleCase(item.category || item.submission_type || 'Bounty activity')) + '</p></div><div class="dashboard-item-actions"><span class="status-pill ' + statusClass(status) + '">' + escapeHTML(statusLabel(status)) + '</span>' + link + '</div></article>';
    }

    /* ============ CRITERIA ============ */

    var CRITERIA_PLACEHOLDER = 'One per line. Examples:\nAt least 150 words | words:150\nLink to a GitHub repo | host:github.com\nCode is readable';
    var CRITERIA_HINT = 'Add "| words:N", "| link", or "| host:domain.com" to make a check automatic. Lines without a rule are reviewed by you. Checks never reject work.';

    // One criterion per line: "Text", "Text | words:150", "Text | link", "Text | host:github.com,gitlab.com"
    function parseCriteriaText(text) {
        var lines = String(text || '').split('\n').map(function(line) { return line.trim(); }).filter(Boolean);
        return lines.map(function(line, index) {
            var parts = line.split('|');
            var label = parts[0].trim();
            var spec = (parts[1] || '').trim().toLowerCase();
            var rule = null;
            if (parts.length > 1 && !spec) throw new Error('Criterion ' + (index + 1) + ' has an empty rule after the |.');
            if (spec) {
                if (/^words:\s*\d+$/.test(spec)) {
                    rule = { type: 'min_words', min: parseInt(spec.split(':')[1], 10) };
                } else if (spec === 'link') {
                    rule = { type: 'link_required' };
                } else if (/^host:\s*[a-z0-9.,\s-]+$/.test(spec)) {
                    rule = { type: 'link_host', hosts: spec.split(':')[1].split(',').map(function(h) { return h.trim(); }).filter(Boolean) };
                } else {
                    throw new Error('Criterion ' + (index + 1) + ' rule must be words:N, link, or host:domain.com');
                }
            }
            return { text: label, rule: rule };
        });
    }

    function describeRule(rule) {
        if (!rule) return 'Reviewer check';
        if (rule.type === 'min_words') return 'Automatic: at least ' + rule.min + ' words';
        if (rule.type === 'link_required') return 'Automatic: link required';
        if (rule.type === 'link_host') return 'Automatic: link must be on ' + rule.hosts.join(', ');
        return 'Reviewer check';
    }

    function criteriaListHTML(criteria) {
        if (!criteria || !criteria.length) return '';
        return '<ul class="criteria-list">' + criteria.map(function(c) {
            return '<li><strong>' + escapeHTML(c.text) + '</strong> <span class="small muted">· ' + escapeHTML(describeRule(c.rule)) + '</span></li>';
        }).join('') + '</ul>';
    }

    // Renders a submission check report. Findings are suggestions: nothing here rejects work.
    function checksHTML(data) {
        if (!data.results || !data.results.length) return '<p class="small muted">This bounty has no acceptance criteria.</p>';
        var labels = { confirmed_fail: 'Not met', possible_issue: 'Possible issue', passed: 'Met', not_checked: 'Not checked' };
        var classes = { confirmed_fail: 'fail', possible_issue: 'possible', passed: 'pass', not_checked: 'not-checked' };
        var sources = { automatic: 'Automatic check', ai: 'AI suggestion', none: '' };
        var s = data.summary || {};
        var head = [(s.confirmed_fail || 0) + ' not met', (s.possible_issue || 0) + ' possible', (s.passed || 0) + ' met', (s.not_checked || 0) + ' not checked'].join(' · ');
        var items = data.results.map(function(r, i) {
            var key = labels[r.status] ? r.status : 'not_checked';
            return '<li class="rubric-item"><span class="criterion-id">C' + String(i + 1).padStart(2, '0') + '</span>' +
                '<div><span class="check-pill check-' + classes[key] + '">' + escapeHTML(labels[key]) + '</span>' +
                (sources[r.source] ? ' <span class="small muted">' + escapeHTML(sources[r.source]) + '</span>' : '') +
                '<p class="rubric-text">' + escapeHTML(r.text) + '</p><p class="small muted">' + escapeHTML(r.reason || '') + '</p>' +
                (r.evidence ? '<blockquote class="evidence">“' + escapeHTML(r.evidence) + '”</blockquote>' : '') + '</div></li>';
        }).join('');
        var notes = (data.notes || []).map(function(n) { return '<li>' + escapeHTML(n) + '</li>'; }).join('');
        var headline = (s.confirmed_fail || 0) > 0 ? 'Some automatic checks fail. Review before deciding.' :
            (s.possible_issue || s.not_checked || 0) > 0 ? 'Some items need your review.' : 'Everything checked is met.';
        return '<div class="checks-result rubric"><div class="rubric-head"><strong>Acceptance rubric</strong><span class="small muted">' + escapeHTML(head) + '</span></div>' +
            '<p class="small muted">' + escapeHTML(headline) + '</p>' +
            (data.ai_error ? '<p class="small muted">The AI check did not finish. The automatic results are shown.</p>' : '') +
            (data.ai_used === false && !data.ai_error ? '<p class="small muted">AI assessment is off on this server, so subjective criteria need your review.</p>' : '') +
            '<ol class="rubric-list">' + items + '</ol>' +
            '<ul class="small muted check-notes">' + notes + '</ul></div>';
    }

    /* ============ BUSINESS REVIEW TOOLS ============ */



    function wireSubmissionTools(list, bounty) {
        $$('[data-checks]', list).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var out = btn.closest('[data-submission]').querySelector('[data-checks-out]');
                btn.disabled = true;
                api('/api/ai/submissions/' + encodeURIComponent(btn.getAttribute('data-checks')) + '/check', { method: 'POST' })
                    .then(function(data) { out.innerHTML = checksHTML(data); })
                    .catch(function(error) { out.innerHTML = '<p class="small muted">' + escapeHTML(friendlyApiError(error, 'Could not run checks.')) + '</p>'; })
                    .then(function() { btn.disabled = false; });
            });
        });
        $$('[data-verify]', list).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var out = btn.closest('[data-submission]').querySelector('[data-verify-out]');
                btn.disabled = true;
                api('/api/verification/submissions/' + encodeURIComponent(btn.getAttribute('data-verify')), { method: 'POST' })
                    .then(function(report) { mountFeature('verificationReport', out, report); })
                    .catch(function(error) { out.innerHTML = '<p class="small muted">' + escapeHTML(friendlyApiError(error, 'Could not create the report.')) + '</p>'; })
                    .then(function() { btn.disabled = false; });
            });
        });
        $$('[data-revise]', list).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var box = btn.closest('[data-submission]').querySelector('[data-revise-box]');
                if (box) box.hidden = !box.hidden;
            });
        });
        $$('[data-revise-send]', list).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var card = btn.closest('[data-submission]');
                var notes = String(card.querySelector('textarea').value || '').trim();
                var deadlineInput = card.querySelector('[data-revise-deadline]');
                var deadlineValue = deadlineInput ? deadlineInput.value : '';
                if (notes.length < 5) return toast('Explain what needs to change (at least 5 characters).', 'error');
                if (deadlineValue && new Date(deadlineValue).getTime() <= Date.now()) return toast('The proposed deadline must be in the future.', 'error');
                inlineConfirm(btn, 'Send this back to the worker for changes?', 'Send back', function() {
                btn.disabled = true;
                var body = { notes: notes };
                if (deadlineValue) body.proposed_deadline = new Date(deadlineValue).toISOString();
                api('/api/submissions/' + encodeURIComponent(btn.getAttribute('data-revise-send')) + '/request-revision', { method: 'POST', body: body })
                    .then(function() {
                        toast('Changes requested. The worker has been notified.', 'success');
                        bountyDetailPage(bounty.id);
                    })
                    .catch(function(error) {
                        toast(friendlyApiError(error, 'Could not send this back.'), 'error');
                        btn.disabled = false;
                    });
                });
            });
        });
    }

    /* ============ WORKER REVISIONS ============ */

    function revisionCardHTML(s) {
        var id = escapeHTML(s.id);
        return '<article class="dashboard-item revise-card" data-resubmit-card="' + id + '"><div class="revise-body">' +
            '<h3>' + escapeHTML(s.bounty_title || 'Bounty') + '</h3>' +
            '<p class="small"><strong>Changes requested:</strong> ' + escapeHTML(s.revision_notes || 'No details given.') + '</p>' +
            (s.proposed_deadline ? '<div class="proposal"><p class="small"><strong>Proposed new deadline:</strong> ' + escapeHTML(dateText(s.proposed_deadline)) + '. Accept to move the task deadline, or decline to keep it.</p><div class="form-actions"><button class="btn btn-sm btn-primary" type="button" data-accept-deadline="' + id + '">Accept new deadline</button> <button class="btn btn-sm" type="button" data-decline-deadline="' + id + '">Decline</button></div></div>' : '') +
            '<div class="field"><label for="rs-title-' + id + '">Title</label><input id="rs-title-' + id + '" data-f="title" value="' + escapeHTML(s.title || '') + '" minlength="3" maxlength="200" required></div>' +
            '<div class="field"><label for="rs-desc-' + id + '">Updated notes for the reviewer</label><textarea id="rs-desc-' + id + '" data-f="description" rows="4" minlength="10" maxlength="10000" required>' + escapeHTML(s.description || '') + '</textarea></div>' +
            '<div class="field"><label for="rs-link-' + id + '">Project link (optional)</label><input id="rs-link-' + id + '" data-f="link" type="url" value="' + escapeHTML(s.github_link || '') + '" maxlength="2048"></div>' +
            '<div class="form-error" data-resubmit-error hidden role="alert"></div>' +
            '<button class="btn btn-primary btn-sm" type="button" data-resubmit="' + id + '">Resubmit work</button>' +
            '</div></article>';
    }

    function loadRevisionRequests(target) {
        api('/api/submissions/mine').then(function(rows) {
            var waiting = (rows || []).filter(function(s) { return s.status === 'revision_requested'; });
            if (!waiting.length) return;
            var section = document.createElement('section');
            section.className = 'dashboard-section';
            section.id = 'revision-requests';
            section.innerHTML = '<h2>Changes requested</h2>' + waiting.map(revisionCardHTML).join('');
            target.insertBefore(section, target.firstChild);
            $$('[data-accept-deadline], [data-decline-deadline]', section).forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var accept = btn.hasAttribute('data-accept-deadline');
                    var id = btn.getAttribute(accept ? 'data-accept-deadline' : 'data-decline-deadline');
                    btn.disabled = true;
                    api('/api/submissions/' + encodeURIComponent(id) + (accept ? '/accept-deadline' : '/decline-deadline'), { method: 'POST' })
                        .then(function() {
                            toast(accept ? 'New deadline accepted.' : 'Proposal declined. The deadline stays the same.', 'success');
                            dashboardPage();
                        })
                        .catch(function(error) {
                            toast(friendlyApiError(error, 'Could not update the deadline.'), 'error');
                            btn.disabled = false;
                        });
                });
            });
            $$('[data-resubmit]', section).forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var card = btn.closest('[data-resubmit-card]');
                    var errorBox = card.querySelector('[data-resubmit-error]');
                    var title = card.querySelector('[data-f="title"]').value.trim();
                    var description = card.querySelector('[data-f="description"]').value.trim();
                    var link = card.querySelector('[data-f="link"]').value.trim();
                    errorBox.hidden = true;
                    if (title.length < 3) return showFormError(errorBox, 'Title needs at least 3 characters.');
                    if (description.length < 10) return showFormError(errorBox, 'Notes need at least 10 characters.');
                    btn.disabled = true;
                    api('/api/submissions/' + encodeURIComponent(btn.getAttribute('data-resubmit')) + '/resubmit', {
                        method: 'POST',
                        body: { title: title, description: description, github_link: link || null }
                    }).then(function() {
                        toast('Resubmitted. The business has been notified.', 'success');
                        dashboardPage();
                    }).catch(function(error) {
                        showFormError(errorBox, friendlyApiError(error, 'Could not resubmit.'));
                        btn.disabled = false;
                    });
                });
            });
        }).catch(function() { /* the rest of the dashboard still shows */ });
    }

    /* ============ PROJECTS ============ */

    function projectTaskHTML(t) {
        var deps = t.depends_on || [];
        var waiting = deps.filter(function(d) { return d.status !== 'completed'; });
        var status = t.status || 'open';
        return '<article class="dashboard-item"><div><h3><a href="#/bounties/' + encodeURIComponent(t.id) + '">' + escapeHTML(t.title) + '</a></h3>' +
            '<p class="small muted">' + escapeHTML(titleCase(t.category)) + ' · ' + escapeHTML(titleCase(t.difficulty)) + ' · ' + escapeHTML(money(t.reward_amount)) + ' · due ' + escapeHTML(dateText(t.deadline)) + '</p>' +
            (deps.length ? '<p class="small">' + (waiting.length ? 'Waiting on: ' + escapeHTML(waiting.map(function(d) { return d.title; }).join(', ')) : 'All prerequisites complete') + '</p>' : '') +
            criteriaListHTML(t.acceptance_criteria) +
            '</div><div class="dashboard-item-actions"><span class="status-pill ' + statusClass(status) + '">' + escapeHTML(titleCase(status)) + '</span>' +
            (t.blocked && status === 'open' ? '<span class="small muted">Blocked</span>' : '') + '</div></article>';
    }

    // Live progress for the project owner and workers on it. Hidden for anyone else.
    function loadProjectProgress(id, target) {
        if (!isAuthenticated()) return;
        var box = document.createElement('section');
        box.className = 'panel project-progress';
        box.id = 'project-progress';
        box.innerHTML = '<div class="loading-line"><span class="spinner"></span> Loading progress…</div>';
        target.appendChild(box);
        var labels = { ready: 'Ready to start', blocked: 'Waiting', in_progress: 'Revision requested', under_review: 'Under review', completed: 'Completed', closed: 'Closed', expired: 'Expired' };
        var classes = { ready: 'pass', blocked: 'not-checked', in_progress: 'possible', under_review: 'possible', completed: 'pass', closed: 'not-checked', expired: 'not-checked' };
        api('/api/projects/' + encodeURIComponent(id) + '/progress').then(function(pr) {
            var rows = pr.tasks.map(function(t, i) {
                var waiting = t.waiting_on && t.waiting_on.length ? ' <span class="small muted">Waits for: ' + escapeHTML(t.waiting_on.map(function(w) { return w.title; }).join(', ')) + '</span>' : '';
                var over = t.overdue ? ' <span class="check-pill check-fail">Overdue</span>' : '';
                return '<li class="rubric-item"><span class="criterion-id">' + String(i + 1).padStart(2, '0') + '</span><div>' +
                    '<span class="check-pill check-' + (classes[t.state] || 'not-checked') + '">' + escapeHTML(labels[t.state] || t.state) + '</span>' + over +
                    '<p class="rubric-text">' + escapeHTML(t.title) + '</p>' + waiting + '</div></li>';
            }).join('');
            var bottlenecks = pr.bottlenecks.length ? '<p class="small"><strong>Holding things up most:</strong> ' + pr.bottlenecks.map(function(b) { return escapeHTML(b.title) + ' (blocks ' + b.blocks_count + ')'; }).join(', ') + '</p>' : '';
            var gaps = pr.missing_prerequisites.length ? '<ul class="check-notes small">' + pr.missing_prerequisites.map(function(m) { return '<li>' + escapeHTML(m.task) + ' needs ' + escapeHTML(m.needs) + '. ' + escapeHTML(m.reason) + '</li>'; }).join('') + '</ul>' : '';
            box.innerHTML = '<div class="rubric-head"><strong>Progress</strong><span class="small muted">' + pr.completed + ' of ' + pr.total + ' done · ' + pr.percent + '%' + (pr.overdue_count ? ' · ' + pr.overdue_count + ' overdue' : '') + '</span></div>' +
                '<div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pr.percent + '"><div class="progress-fill" style="width:' + pr.percent + '%"></div></div>' +
                bottlenecks + '<ol class="rubric-list">' + rows + '</ol>' + gaps;
        }).catch(function() { box.remove(); });
    }

    function projectDetailPage(id) {
        app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to marketplace</a><div id="project-content"><div class="loading-line"><span class="spinner"></span> Loading project…</div></div></div></section>';
        var target = $('#project-content');
        api('/api/projects/' + encodeURIComponent(id)).then(function(p) {
            var tasks = p.tasks || [];
            var done = tasks.filter(function(t) { return t.status === 'completed'; }).length;
            target.innerHTML = '<div class="page-header"><span class="eyebrow">Project · ' + done + ' of ' + tasks.length + ' tasks completed</span><h1>' + escapeHTML(p.title) + '</h1><p>' + escapeHTML(p.description) + '</p><p class="small muted">By ' + escapeHTML(p.business_name || 'Business') + '</p></div>' +
                (tasks.length ? '<div class="dashboard-list">' + tasks.map(projectTaskHTML).join('') + '</div>' : '<p class="muted">This project has no tasks yet.</p>');
            loadProjectProgress(id, target);
            mountFeature('projectMilestones', target, p);
        }).catch(function(error) {
            target.innerHTML = '<div class="notice warning">' + icon('alert', 16) + ' ' + escapeHTML(friendlyApiError(error, 'This project could not be loaded.')) + '</div>';
        });
    }

    function renumberTasks() {
        $$('.task-row').forEach(function(row, i) {
            row.querySelector('[data-task-number]').textContent = String(i + 1);
        });
    }

    function addTaskRow() {
        var container = $('#task-rows');
        var row = document.createElement('fieldset');
        row.className = 'task-row';
        row.innerHTML = '<legend>Task <span data-task-number></span></legend>' +
            '<div class="form-grid">' +
            '<div class="field span-2"><label>Task title</label><input data-f="title" required minlength="3" maxlength="200"></div>' +
            '<div class="field span-2"><label>Task description</label><textarea data-f="description" required minlength="10" maxlength="10000"></textarea></div>' +
            '<div class="field"><label>Category</label><select data-f="category"><option value="dev">Development</option><option value="design">Design</option><option value="content">Content</option><option value="marketing">Marketing</option><option value="other">Other</option></select></div>' +
            '<div class="field"><label>Difficulty</label><select data-f="difficulty"><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>' +
            '<div class="field"><label>Reward amount (NGN)</label><input data-f="reward" type="number" required min="0.01" max="1000000" step="0.01"></div>' +
            '<div class="field"><label>Deadline</label><input data-f="deadline" type="datetime-local" required></div>' +
            '<div class="field"><label>Submission type</label><select data-f="submission_type"><option value="github">GitHub</option><option value="url">URL</option><option value="file">File</option><option value="text">Text</option></select></div>' +
            '<div class="field"><label>Waits for tasks</label><input data-f="depends" placeholder="e.g. 1 or 1,2 (leave empty if none)"><span class="field-hint">Use the task numbers in this form.</span></div>' +
            '<div class="field span-2"><label>Acceptance criteria (optional)</label><textarea data-f="criteria" rows="3" placeholder="' + escapeHTML(CRITERIA_PLACEHOLDER) + '"></textarea><span class="field-hint">' + escapeHTML(CRITERIA_HINT) + '</span></div>' +
            '</div><button class="btn btn-sm" type="button" data-remove-task>Remove task</button>';
        container.appendChild(row);
        renumberTasks();
        on(row.querySelector('[data-remove-task]'), 'click', function() {
            if ($$('.task-row').length <= 1) return toast('A project needs at least one task.', 'error');
            row.remove();
            renumberTasks();
        });
    }

    // Reads every task row. Throws an Error with a readable message on the first problem.
    function readTaskRows() {
        return $$('.task-row').map(function(row, i) {
            function val(name) { return String(row.querySelector('[data-f="' + name + '"]').value || '').trim(); }
            var label = 'Task ' + (i + 1) + ': ';
            var reward = val('reward');
            if (!/^\d+(?:\.\d{1,2})?$/.test(reward) || Number(reward) <= 0) throw new Error(label + 'enter a positive reward with up to two decimal places.');
            var deadline = new Date(val('deadline'));
            if (!val('deadline') || isNaN(deadline.getTime())) throw new Error(label + 'choose a deadline.');
            var depsText = val('depends');
            var depends = depsText ? depsText.split(',').map(function(x) { return Number(x.trim()) - 1; }) : [];
            if (depends.some(function(d) { return !Number.isInteger(d) || d < 0; })) throw new Error(label + 'waits-for must be task numbers like 1 or 1,2.');
            return {
                title: val('title'),
                description: val('description'),
                category: val('category'),
                difficulty: val('difficulty'),
                reward_amount: Number(reward).toFixed(2),
                deadline: deadline.toISOString(),
                submission_type: val('submission_type'),
                depends_on: depends,
                acceptance_criteria: parseCriteriaText(row.querySelector('[data-f="criteria"]').value)
            };
        });
    }

    function submitProject(event) {
        event.preventDefault();
        var errorBox = $('#project-error');
        var button = $('#create-project-btn');
        errorBox.hidden = true;
        var title = $('#project-title').value.trim();
        var description = $('#project-description').value.trim();
        var tasks;
        try {
            tasks = readTaskRows();
        } catch (parseError) {
            return showFormError(errorBox, parseError.message);
        }
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Creating…';
        api('/api/projects', { method: 'POST', body: { title: title, description: description, tasks: tasks } })
            .then(function(project) {
                toast('Project created.', 'success');
                go('projects/' + encodeURIComponent(project.id));
            })
            .catch(function(error) {
                showFormError(errorBox, friendlyApiError(error, 'Could not create this project.'));
            })
            .then(function() {
                if (document.contains(button)) {
                    button.disabled = false;
                    button.innerHTML = 'Create project ' + icon('arrow', 16);
                }
            });
    }

    // The planner gives every task this placeholder reward. The server refuses to publish it unless confirmed.
    var PLACEHOLDER_REWARD_AMOUNT = 5000;

    function approveDraft(draft, button) {
        var plan = JSON.parse(JSON.stringify(draft.plan));
        var valid = true;
        plan.tasks.forEach(function(t, i) {
            var value = Number($('#plan-reward-' + i).value);
            if (!(value >= 0.01 && value <= 1000000)) valid = false;
            t.reward_amount = value.toFixed(2);
        });
        if (!valid) return toast('Every task needs a reward between 0.01 and 1,000,000.', 'error');
        if (!$('#plan-confirm-rewards').checked) return toast('Confirm the rewards before you approve the project.', 'error');

        button.disabled = true;
        api('/api/projects/plan/' + encodeURIComponent(draft.id) + '/approve', { method: 'POST', body: { plan: plan, confirm_rewards: true } })
            .then(function(project) {
                toast('Project created.', 'success');
                go('projects/' + encodeURIComponent(project.id));
            })
            .catch(function(error) {
                toast(friendlyApiError(error, 'Could not approve this draft.'), 'error');
                button.disabled = false;
            });
    }

    function renderPlanDraft(draft) {
        var output = $('#ai-plan-output');
        var plan = draft.plan;
        var rulesNote = draft.source === 'rules' ? '<p class="notice">Drafted by our rules engine, not an AI model. Review every task and set its reward.</p>' : '';
        output.innerHTML = '<div class="plan-draft">' + rulesNote + '<h3>' + escapeHTML(plan.title) + '</h3><p class="small muted">' + escapeHTML(plan.description) + '</p>' +
            '<ol class="plan-tasks">' + plan.tasks.map(function(t, i) {
                var deps = (t.depends_on || []).map(function(d) { return d + 1; });
                var placeholder = Number(t.reward_amount) === PLACEHOLDER_REWARD_AMOUNT;
                return '<li><strong>' + escapeHTML(t.title) + '</strong> <span class="small muted">· ' + escapeHTML(titleCase(t.category)) +
                    (deps.length ? ' · waits for task ' + escapeHTML(deps.join(', ')) : '') + '</span>' +
                    '<p class="small">' + escapeHTML(t.description) + '</p>' + criteriaListHTML(t.acceptance_criteria) +
                    '<div class="field"><label for="plan-reward-' + i + '">Reward (NGN)</label>' +
                    '<input id="plan-reward-' + i + '" type="number" min="0.01" max="1000000" step="0.01" value="' + escapeHTML(String(Number(t.reward_amount))) + '">' +
                    (placeholder ? '<span class="field-hint">Placeholder amount. Set the real reward for this task.</span>' : '') + '</div></li>';
            }).join('') + '</ol>' +
            '<label class="portfolio-row"><input type="checkbox" id="plan-confirm-rewards"> <span>I have set each task’s reward. Any amount left as a placeholder is not a real price.</span></label>' +
            '<p class="small muted">This is a draft. Nothing is published until you approve it.</p>' +
            '<button class="btn btn-primary" id="approve-draft-btn" type="button">Approve and create project</button></div>';
        on($('#approve-draft-btn'), 'click', function() { approveDraft(draft, this); });
    }

    function generateAiPlan(event) {
        event.preventDefault();
        var errorBox = $('#ai-plan-error');
        var button = $('#ai-plan-btn');
        errorBox.hidden = true;
        var prompt = $('#ai-prompt').value.trim();
        if (prompt.length < 10) return showFormError(errorBox, 'Describe the project in at least 10 characters.');
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Drafting…';
        api('/api/projects/plan', { method: 'POST', body: { prompt: prompt } })
            .then(function(draft) { renderPlanDraft(draft); })
            .catch(function(error) {
                var message = friendlyApiError(error, 'The draft could not be created.');
                if (error && error.status === 503) message = 'AI drafting is not set up on this server yet. You can still build the plan yourself below.';
                showFormError(errorBox, message);
            })
            .then(function() {
                if (document.contains(button)) {
                    button.disabled = false;
                    button.innerHTML = 'Generate draft';
                }
            });
    }

    function projectNewPage() {
        if (!protectedPage('projects/new')) return;
        if (getRole() !== 'business') {
            app.innerHTML = '<section class="page"><div class="container"><div class="notice warning">Only business accounts can plan projects.</div></div></section>';
            return;
        }
        app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/dashboard">' + icon('arrowLeft', 16) + ' Back to dashboard</a>' +
            '<div class="page-header"><span class="eyebrow">Plan a project</span><h1>Break work into linked tasks</h1><p>Workers can only start a task once the tasks it waits for are completed.</p></div>' +
            '<section class="panel"><h2>Draft with AI</h2><p class="small muted">Describe the project and the AI suggests a plan. You review it before anything is created.</p>' +
            '<form id="ai-plan-form" class="form"><div id="ai-plan-error" class="form-error" hidden role="alert"></div>' +
            '<div class="field"><label for="ai-prompt">Describe the project</label><textarea id="ai-prompt" name="prompt" required minlength="10" maxlength="1000" rows="4" placeholder="e.g. Launch a landing page for a coffee brand, with copy, a build and a QA pass"></textarea></div>' +
            '<button class="btn btn-primary" id="ai-plan-btn" type="submit">Generate draft</button></form><div id="ai-plan-output"></div></section>' +
            '<section class="panel"><h2>Or build the plan yourself</h2>' +
            '<form id="project-form" class="form"><div id="project-error" class="form-error" hidden role="alert"></div>' +
            '<div class="form-grid"><div class="field span-2"><label for="project-title">Project title</label><input id="project-title" name="title" required minlength="3" maxlength="200"></div>' +
            '<div class="field span-2"><label for="project-description">Project description</label><textarea id="project-description" name="description" required minlength="10" maxlength="10000"></textarea></div></div>' +
            '<div id="task-rows"></div>' +
            '<div class="form-actions"><button class="btn" id="add-task-btn" type="button">Add task</button> <button class="btn btn-primary" id="create-project-btn" type="submit">Create project ' + icon('arrow', 16) + '</button></div>' +
            '</form></section></div></section>';
        addTaskRow();
        addTaskRow();
        on($('#ai-plan-form'), 'submit', generateAiPlan);
        on($('#add-task-btn'), 'click', addTaskRow);
        on($('#project-form'), 'submit', submitProject);
    }

    function loadMyProjects(target) {
        var section = document.createElement('section');
        section.className = 'dashboard-section';
        section.id = 'my-projects';
        section.innerHTML = '<h2>Your projects</h2><div class="loading-line"><span class="spinner"></span> Loading projects…</div>';
        target.appendChild(section);
        api('/api/projects/mine').then(function(rows) {
            if (!rows.length) {
                section.innerHTML = '<h2>Your projects</h2><p class="muted">No projects yet. <a class="inline-link" href="#/projects/new">Plan your first project</a>.</p>';
                return;
            }
            section.innerHTML = '<h2>Your projects</h2><div class="dashboard-list">' + rows.map(function(p) {
                return '<article class="dashboard-item"><div><h3><a href="#/projects/' + encodeURIComponent(p.id) + '">' + escapeHTML(p.title) + '</a></h3>' +
                    '<p class="small muted">' + p.completed_count + ' of ' + p.task_count + ' tasks completed</p></div></article>';
            }).join('') + '</div>';
        }).catch(function(error) {
            section.innerHTML = '<h2>Your projects</h2><p class="muted">' + escapeHTML(friendlyApiError(error, 'Projects could not load.')) + '</p>';
        });
    }

    /* ============ APP SHELL ============ */

    function notFoundPage() {
        app.innerHTML = '<section class="page"><div class="container"><div class="empty-state"><span class="empty-illustration">' + icon('search', 28) + '</span><h3>That page doesn\'t exist</h3><p>The link may be outdated, or the page may have moved.</p><a class="btn btn-primary" href="#/">Go to homepage</a></div></div></section>';
    }

    function logout() {
        // Ask the server to revoke this session. The local sign-out happens either way.
        api('/api/auth/logout', { method: 'POST', auth: false }).catch(function() {});
        setSession(null, '');
        state.mobileMenu = false;
        state.themeMenu = false;
        sessionStorage.removeItem('bounty_after_auth');
        toast('You have been logged out.', 'success');
        go('home');
    }

    /* ============ MOTION ============ */

    var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Splits a plain-text heading into words so each one rises in sequence.
    // Runs after each route change: page entrance, headline split, and scroll reveals.
    var scrollHeaderReady = false;
    function renderHeader() {
        // Header shows on every page now, for a consistent navigation anchor.
        removeHomeThemePicker();
        header.hidden = false;

        // Navigation lives in one sidebar, opened from the Menu button. Hospitality comes first,
        // then the marketplace, then everything else grouped by purpose.
        var authed = isAuthenticated();
        var role = authed ? getRole() : '';
        var groups = [];
        groups.push(['Services', [headerLink('services', 'Hospitality')]]);
        groups.push(['Work', authed ?
            [headerLink('bounties', 'Marketplace'), headerLink('dashboard', 'Dashboard')]
                .concat(role === 'worker' ? [headerLink('recommended', 'For you'), headerLink('invitations', 'Invitations'), headerLink('work', 'My work')] : []) :
            [headerLink('bounties', 'Marketplace')]]);
        if (authed && role === 'business') {
            groups.push(['People', [headerLink('talent', 'Talent pool')]]);
        }
        groups.push(['Help', [headerLink('how-it-works', 'How it works'), headerLink('protection', 'Trust & safety')]]);
        var sideLinks = groups.map(function(g) {
            return '<div class="side-group"><p class="side-label">' + g[0] + '</p>' + g[1].join('') + '</div>';
        }).join('');
        var accountLinks = authed ?
            '<div class="side-group"><p class="side-label">Account</p><a href="#/profile">Profile</a><button type="button" id="mobile-logout">Log out</button></div>' :
            '<div class="side-group"><p class="side-label">Account</p><a href="#/auth/login">Log in</a><a href="#/auth/signup">Create account</a></div>';

        var authActions = authed ?
            '<div class="header-user">' + bellHTML() +
            '<a class="user-name" href="#/profile">' + escapeHTML((state.user.name || 'Member').split(' ')[0]) + '</a>' +
            '<button class="btn btn-sm btn-quiet" id="logout-btn" type="button" title="Log out" aria-label="Log out">' + icon('logout', 16) + '</button></div>' :
            '<a class="btn btn-sm btn-quiet desktop-auth" href="#/auth/login">Log in</a><a class="btn btn-primary btn-sm desktop-auth" href="#/auth/signup">Get started</a>';

        header.className = 'site-header';
        header.innerHTML =
            '<div class="header-inner">' +
            '<button class="menu-button" id="menu-btn" type="button" aria-expanded="' + state.mobileMenu + '" aria-controls="side-menu">' +
            icon(state.mobileMenu ? 'close' : 'menu', 18) + '<span>Menu</span></button>' +
            '<a class="brand" href="#/" aria-label="Bounty home"><span class="brand-mark">B</span><span class="brand-word">Bounty</span></a>' +
            '<span class="header-spacer"></span>' +
            '<div class="header-tail">' +
            themePickerHTML() +
            authActions +
            '</div>' +
            '</div>';

        // The sidebar sits outside the header: the header's backdrop blur would otherwise
        // trap a fixed element inside the bar.
        var sideRoot = document.getElementById('side-root');
        if (!sideRoot) {
            sideRoot = document.createElement('div');
            sideRoot.id = 'side-root';
            document.body.appendChild(sideRoot);
        }
        sideRoot.innerHTML =
            '<div class="side-scrim' + (state.mobileMenu ? ' open' : '') + '" id="side-scrim" aria-hidden="true"></div>' +
            '<nav id="side-menu" class="side-menu' + (state.mobileMenu ? ' open' : '') + '" aria-label="Main navigation">' +
            '<div class="side-head"><span class="brand-word">Menu</span>' +
            '<button class="icon-button" id="side-close" type="button" aria-label="Close menu">' + icon('close', 18) + '</button></div>' +
            sideLinks + accountLinks +
            '</nav>';

        bindThemePicker(header);
        on($('#bell-btn', header), 'click', function() { go('notifications'); });
        on($('#menu-btn', header), 'click', function() {
            state.mobileMenu = !state.mobileMenu;
            state.themeMenu = false;
            renderHeader();
            if (state.mobileMenu) { var first = $('#side-menu a', sideRoot); if (first) first.focus(); }
        });
        on($('#side-close', sideRoot), 'click', function() { state.mobileMenu = false; renderHeader(); $('#menu-btn', header).focus(); });
        on($('#side-scrim', sideRoot), 'click', function() { state.mobileMenu = false; renderHeader(); });
        on($('#logout-btn', header), 'click', logout);
        on($('#mobile-logout', sideRoot), 'click', logout);
    }

    function bindThemePicker(root) {
        on($('#theme-picker-trigger', root), 'click', function() {
            state.themeMenu = !state.themeMenu;
            renderHeader();
        });
        $$('[data-theme-choice]', root).forEach(function(button) {
            button.addEventListener('click', function() {
                state.themeMenu = false;
                applyTheme(button.getAttribute('data-theme-choice'));
            });
        });
    }

    function renderHomeThemePicker() {
        var box = document.getElementById('home-theme-picker');
        if (!box) {
            box = document.createElement('div');
            box.id = 'home-theme-picker';
            box.style.cssText = 'position:fixed;top:14px;right:14px;z-index:60;';
            document.body.appendChild(box);
        }
        box.innerHTML = themePickerHTML();
        bindThemePicker(box);
    }

    function removeHomeThemePicker() {
        var box = document.getElementById('home-theme-picker');
        if (box && box.parentNode) box.parentNode.removeChild(box);
    }

    function renderFooter() {
        var authLink = isAuthenticated() ?
            '<a href="#/bounties">Explore bounties</a>' :
            '<a href="#/auth/signup">Create an account</a>';
        footer.innerHTML =
            '<div class="container footer-inner"><div><a class="footer-brand" href="#/">Bounty<span class="gradient-text">.</span></a><p class="footer-copy">More access to meaningful opportunities.</p></div>' +
            '<nav class="footer-links" aria-label="Footer navigation"><a href="#/how-it-works">How it works</a>' + authLink + (state.user && state.user.is_admin ? '<a href="#/admin">Admin</a><a href="#/admin/assessments">Skill checks review</a>' : '') + '<a href="#/terms">Terms</a><a href="#/privacy">Privacy</a></nav></div>' +
            '<div class="container demo-disclaimer">Demo environment: payments are simulated. No real funds are transferred.</div>';
    }

    function homePage() {
        app.innerHTML =
            '<div class="announce-bar"><a href="#/how-it-works">New: see how a bounty moves from request to result <span aria-hidden="true">→</span></a></div>' +
            '<section class="hero"><div class="container hero-grid"><div class="hero-copy animate-in"><span class="eyebrow"><span class="eyebrow-dot"></span> A wider world of opportunity</span><h1>Your skills deserve a global stage.</h1><p>Bounty connects people with meaningful tasks and rewards. Find work you can prove, build your reputation, and open doors beyond your location.</p><div class="hero-actions"><a class="btn btn-primary" href="#/auth/signup">Get started for free ' + icon('arrow', 17) + '</a><a class="btn" href="#/how-it-works">See how it works</a></div><div class="hero-proof"><span>Built around skills, clear requirements, and real work.</span></div></div>' +
            '<div class="hero-art animate-in delay-2" aria-label="Illustration of a sample bounty card"><div class="orb"></div><div class="preview-card"><div class="preview-top"><span class="preview-label">Opportunity spotlight</span><span class="live-pill">Demo preview</span></div><span class="category-label"><span class="category-icon">' + icon('code', 16) + '</span> Development</span><h2>Build a landing page</h2><p>Create a clean, responsive experience for a growing business.</p><div class="preview-reward"><div><small>Illustrative reward</small><strong>₦15,000</strong></div><span class="tag">Beginner friendly</span></div><div class="preview-tags"><span class="tag">HTML &amp; CSS</span><span class="tag">Responsive</span><span class="tag">Portfolio</span></div></div><div class="float-note one"><span class="float-icon">' + icon('globe', 18) + '</span><div><strong>Opportunities without borders</strong><small>Skills can travel</small></div></div><div class="float-note two"><span class="float-icon">' + icon('shield', 18) + '</span><div><strong>Clear expectations</strong><small>Know what success means</small></div></div></div></div></section>' +
            '<div class="logo-strip"><div class="container logo-strip-inner"><p>Opportunities across skill sets</p><span class="category-word">Development</span><span class="category-word">Design</span><span class="category-word">Content</span><span class="category-word">Marketing</span><span class="category-word">And more</span></div></div>' +
            '<section class="section"><div class="container"><div class="section-heading center"><span class="eyebrow">Why Bounty</span><h2>Opportunity should be easier to reach.</h2><p>Good work can come from anywhere. Bounty is designed to make opportunities clearer, more accessible, and easier to act on.</p></div><div class="feature-grid"><article class="feature-card animate-in"><span class="feature-icon">' + icon('globe', 24) + '</span><h3>Wider access</h3><p>Discover task-based opportunities without relying only on personal connections or location.</p></article><article class="feature-card animate-in delay-1"><span class="feature-icon">' + icon('file', 24) + '</span><h3>Clear expectations</h3><p>Every bounty can define its scope, requirements, deadline, and reward before work begins.</p></article><article class="feature-card animate-in delay-2"><span class="feature-icon">' + icon('shield', 24) + '</span><h3>Visible progress</h3><p>Keep submissions and review status organized so workers and businesses can follow the process.</p></article></div></div></section>' +
            '<section class="section-tight"><div class="container split-section"><div><span class="eyebrow">A straightforward process</span><div class="section-heading"><h2>From opportunity to completed work.</h2><p>Bounty is built around a simple workflow that helps both sides understand what happens next.</p></div><ul class="check-list"><li><span class="checkmark">✓</span><span>Businesses describe the task, reward, deadline, and requirements.</span></li><li><span class="checkmark">✓</span><span>Workers find relevant opportunities and submit work.</span></li><li><span class="checkmark">✓</span><span>Businesses review submissions and update the outcome.</span></li></ul><div class="hero-actions"><a class="btn" href="#/how-it-works">Explore the process ' + icon('arrow', 16) + '</a></div></div><div class="split-visual"><h3>How a bounty moves forward</h3><div class="mini-step"><span class="step-number">01</span><div><strong>Publish the task</strong><p>Describe the outcome, requirements, and deadline.</p></div></div><div class="mini-step"><span class="step-number">02</span><div><strong>Submit the work</strong><p>Workers provide a link or submission that matches the task.</p></div></div><div class="mini-step"><span class="step-number">03</span><div><strong>Review the result</strong><p>The business checks the submission and records its decision.</p></div></div><p class="small">Payments in this prototype are simulated; no real funds move.</p></div></div></section>' +
            '<section class="section"><div class="container"><div class="cta-panel"><h2>Your next opportunity could start with one task.</h2><p>Create an account to explore the marketplace, see full bounty details, and take your next step.</p><div class="hero-actions"><a class="btn btn-primary" href="#/auth/signup">Create your account ' + icon('arrow', 16) + '</a><a class="btn btn-outline-light" href="#/how-it-works">How it works</a></div></div></div></section>';
    }

    function howPage() {
        var steps = [
            ['Create or find a task', 'Businesses publish a task with a clear description, category, reward, deadline, and requirements. Workers can explore opportunities after signing in.'],
            ['Understand the requirements', 'Read the scope and submission instructions before committing time. Ask for clarity when needed and make sure the deadline works for you.'],
            ['Submit your work', 'Complete the task and provide the requested submission, such as a repository link, URL, file, or written response when supported.'],
            ['Review the submission', 'The business reviews submitted work against the stated requirements and approves or rejects it.'],
            ['Track the result', 'Check the dashboard and submission status to understand what happened next.'],
            ['Payment transparency', 'This prototype records simulated payment status only. It does not send real money or create a real Monad transaction.']
        ];
        var cards = steps.map(function(s, i) {
            return '<article class="step-card animate-in ' + (i % 3 ? 'delay-1' : '') + '"><span class="step-number">' + String(i + 1).padStart(2, '0') + '</span><h3>' + escapeHTML(s[0]) + '</h3><p>' + escapeHTML(s[1]) + '</p></article>';
        }).join('');

        var closing = isAuthenticated() ?
            '<div class="cta-panel" style="margin-top:42px"><h2>Ready to get started?</h2><p>Head to the marketplace to find work or check your dashboard for updates.</p><div class="hero-actions"><a class="btn btn-primary" href="#/bounties">Explore bounties ' + icon('arrow', 16) + '</a><a class="btn btn-outline-light" href="#/dashboard">Go to dashboard</a></div></div>' :
            '<div class="cta-panel" style="margin-top:42px"><h2>Ready to explore?</h2><p>Create an account to access the protected bounty marketplace.</p><div class="hero-actions"><a class="btn btn-primary" href="#/auth/signup">Create an account ' + icon('arrow', 16) + '</a><a class="btn btn-outline-light" href="#/auth/login">Log in</a></div></div>';

        app.innerHTML =
            '<section class="page"><div class="container"><div class="page-header"><span class="eyebrow">Simple by design</span><h1>How Bounty works</h1><p>A clear path from a well-defined task to reviewed work. Payment functionality in this demo is simulated.</p></div><div class="steps-grid">' + cards + '</div>' +
            '<div class="trust-note" style="margin-top:22px">' + icon('shield', 23) + '<div><strong>Clear about what is live</strong><p>Bounty is an evolving prototype. Only features connected to the current backend are functional. Simulated payments are not real payouts or proof of escrow.</p></div></div>' +
            closing + '</div></section>';
    }

    function applyTheme(mode) {
        mode = normalizeThemeMode(mode);
        state.themeMode = mode;
        if (mode === 'system') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', mode);
        }
        try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* ignore */ }
        renderHeader();
    }

    // True if the viewport is currently rendering dark, whether by explicit choice or by OS.
    function currentDark() {
        var attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'dark') return true;
        if (attr === 'light') return false;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function themePickerHTML() {
        var current = normalizeThemeMode(state.themeMode);
        // The icon on the trigger follows the effective scheme, not the stored mode,
        // so a user in 'system' sees the real sun or moon.
        var triggerIcon = current === 'system' ? (currentDark() ? 'moon' : 'sun') : THEME_MODES[current].icon;
        var options = Object.keys(THEME_MODES).map(function(key) {
            var m = THEME_MODES[key];
            return '<button type="button" class="theme-option" data-theme-choice="' + key + '" aria-pressed="' + (key === current) + '">' +
                '<span class="theme-option-icon">' + icon(m.icon, 16) + '</span>' +
                '<span class="theme-option-text"><strong>' + escapeHTML(m.label) + '</strong><small>' + escapeHTML(m.description) + '</small></span>' +
                '</button>';
        }).join('');
        return '<div class="theme-menu-wrap">' +
            '<button class="theme-trigger" id="theme-picker-trigger" type="button" aria-haspopup="true" aria-expanded="' + (state.themeMenu ? 'true' : 'false') + '" aria-controls="theme-menu" aria-label="Choose colour mode">' +
            icon(triggerIcon, 18) +
            '</button>' +
            (state.themeMenu ? '<div class="theme-popover" id="theme-menu" role="menu">' + options + '</div>' : '') +
            '</div>';
    }

    function render() {
        state.mobileMenu = false;
        state.themeMenu = false;
        renderHeader();
        renderFooter();

        var route = currentRoute();
        if (route === 'home' || route === '') homePage();
        else if (route === 'how-it-works') howPage();
        else if (route === 'auth/login' || route === 'login') authPage('login');
        else if (route === 'auth/signup' || route === 'signup') authPage('signup');
        else if (route === 'auth/forgot') forgotPage();
        else if (route === 'reset') resetPage();
        else if (route === 'admin') adminPage();
        else if (route === 'terms') legalPage('terms');
        else if (route === 'privacy') legalPage('privacy');
        else if (route.indexOf('worker/') === 0) workerProfilePage(decodeURIComponent(route.slice('worker/'.length)));
        else if (route === 'bounties') browsePage();
        else if (route === 'bounties/new') createBountyPage();
        else if (route === 'dashboard') dashboardPage();
        else if (route === 'profile') profilePage();
        else if (route === 'notifications') notificationsPage();
        else if (route.indexOf('business/') === 0) businessProfilePage(decodeURIComponent(route.slice('business/'.length)));
        else if (route === 'projects/new') projectNewPage();
        else if (route.indexOf('projects/') === 0) projectDetailPage(decodeURIComponent(route.slice('projects/'.length)));
        else if (route.indexOf('bounties/') === 0) bountyDetailPage(decodeURIComponent(route.slice('bounties/'.length)));
        else if (featureRoute(route)) featureRoute(route).render(route);
        else notFoundPage();

        renderHeader();
        renderFooter();
        app.focus({ preventScroll: true });
        if (window.BountyFeatures && window.BountyFeatures.afterRender) window.BountyFeatures.afterRender();
        if (isAuthenticated()) {
            loadNotifications();
            checkOnboarding();
        }
    }

    /* ============ ACCOUNT: VERIFY, RESET, PORTFOLIO, LEGAL ============ */

    var REPORT_REASONS = [
        ['unpaid', 'Reward not paid'],
        ['unfair_rejection', 'Unfair rejection'],
        ['spam', 'Spam or fake listing'],
        ['abusive', 'Abusive behavior'],
        ['other', 'Something else']
    ];

    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function queryParam(name) {
        var query = location.hash.split('?')[1] || '';
        return new URLSearchParams(query).get(name) || '';
    }

    // Keeps the cached user in step with the server's view (admin flag).
    function syncVerified(me) {
        if (!state.user || !me) return;
        var changed = false;
        if (me.is_admin === true && state.user.is_admin !== true) {
            state.user.is_admin = true;
            changed = true;
        }
        if (me.is_admin === false && state.user.is_admin === true) {
            state.user.is_admin = false;
            changed = true;
        }
        if (!changed) return;
        setSession(state.user, getToken());
        renderFooter();
    }

    function accountCard(title, intro, bodyHTML) {
        return '<section class="container auth-shell"><div class="auth-intro"><span class="eyebrow">' + icon('shield', 15) + ' Bounty account</span><h1>' + escapeHTML(title) + '</h1><p>' + escapeHTML(intro) + '</p></div><section class="auth-card">' + bodyHTML + '</section></section>';
    }

    function forgotPage() {
        app.innerHTML = accountCard('Reset your password.', 'Enter the email on your account and we will send a link to choose a new password.',
            '<h2>Forgot password</h2><form id="forgot-form" class="form" novalidate>' +
            '<div id="forgot-error" class="form-error" hidden role="alert"></div>' +
            '<div id="forgot-note" class="notice" hidden role="status"></div>' +
            '<div class="field"><label for="forgot-email">Email address</label><input id="forgot-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="254"></div>' +
            '<button class="btn btn-primary btn-block" type="submit" id="forgot-submit">Send reset link ' + icon('arrow', 16) + '</button></form>' +
            '<p class="auth-switch"><a class="inline-link" href="#/auth/login">← Back to log in</a></p>');

        on($('#forgot-form'), 'submit', function(event) {
            event.preventDefault();
            var errorBox = $('#forgot-error');
            var note = $('#forgot-note');
            errorBox.hidden = true;
            note.hidden = true;

            var email = String($('#forgot-email').value || '').trim().toLowerCase();
            if (!EMAIL_PATTERN.test(email)) return showFormError(errorBox, 'Enter a valid email address.');

            var button = $('#forgot-submit');
            button.disabled = true;
            api('/api/auth/forgot', { method: 'POST', body: { email: email }, auth: false })
                .then(function(data) {
                    note.textContent = (data && data.message) || 'If an account exists for that email, a reset link has been sent.';
                    note.hidden = false;
                })
                .catch(function(error) {
                    showFormError(errorBox, friendlyApiError(error, 'Could not send the reset link. Try again later.'));
                })
                .then(function() {
                    if (document.contains(button)) button.disabled = false;
                });
        });
    }

    function resetPage() {
        var token = queryParam('token');
        if (!token) {
            app.innerHTML = accountCard('Reset link problem.', 'This link is incomplete.',
                '<h2>Link not valid</h2><p>This reset link is missing its code. Request a new one.</p><a class="btn btn-primary btn-block" href="#/auth/forgot">Request a new link</a>');
            return;
        }

        app.innerHTML = accountCard('Choose a new password.', 'Pick a password you have not used on Bounty before.',
            '<h2>New password</h2><form id="reset-form" class="form" novalidate>' +
            '<div id="reset-error" class="form-error" hidden role="alert"></div>' +
            '<div class="field"><label for="reset-password">New password</label><input id="reset-password" name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required minlength="8" maxlength="128"></div>' +
            '<div class="field"><label for="reset-confirm">Confirm new password</label><input id="reset-confirm" name="confirm" type="password" autocomplete="new-password" placeholder="Type it again" required minlength="8" maxlength="128"></div>' +
            '<button class="btn btn-primary btn-block" type="submit" id="reset-submit">Update password ' + icon('arrow', 16) + '</button></form>' +
            '<p class="auth-switch"><a class="inline-link" href="#/auth/forgot">Request a new link</a></p>');

        on($('#reset-form'), 'submit', function(event) {
            event.preventDefault();
            var errorBox = $('#reset-error');
            errorBox.hidden = true;

            var password = $('#reset-password').value;
            var confirm = $('#reset-confirm').value;
            if (password.length < 8) return showFormError(errorBox, 'Use a password with at least 8 characters.');
            if (password !== confirm) return showFormError(errorBox, 'The two passwords do not match.');

            var button = $('#reset-submit');
            button.disabled = true;
            api('/api/auth/reset', { method: 'POST', body: { token: token, password: password }, auth: false })
                .then(function() {
                    setSession(null, '');
                    toast('Password updated. Log in with your new password.', 'success');
                    go('auth/login');
                })
                .catch(function(error) {
                    showFormError(errorBox, friendlyApiError(error, 'Could not reset your password.'));
                })
                .then(function() {
                    if (document.contains(button)) button.disabled = false;
                });
        });
    }

    function workerProfilePage(id) {
        app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a><div class="loading-line"><span class="spinner"></span> Loading profile…</div></div></section>';

        api('/api/profile/worker/' + encodeURIComponent(id), { auth: false })
            .then(function(w) {
                var skills = String(w.skills || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                var categories = (w.categories || []).map(categoryLabel);
                var completed = (w.completed || []).map(function(b) {
                    return '<li><strong>' + escapeHTML(b.title) + '</strong> <span class="small muted">· ' + escapeHTML(categoryLabel(b.category)) + ' · ' + escapeHTML(dateText(b.completed_at)) + '</span></li>';
                }).join('');
                var reviews = (w.reviews || []).map(function(r) {
                    return '<article class="dashboard-item"><div><strong>' + escapeHTML(r.reviewer_name) + '</strong> <span class="small muted">· ' + escapeHTML(r.bounty_title) + ' · ' + escapeHTML(dateText(r.created_at)) + '</span>' +
                        (r.comment ? '<p>' + escapeHTML(r.comment) + '</p>' : '') + '</div><span class="tag">' + Number(r.rating) + ' / 5</span></article>';
                }).join('');

                app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a>' +
                    '<div class="detail-layout"><article class="panel">' +
                    '<div class="ux-row ux-gap16"><div class="avatar ux-avatar ux-avatar-lg">' + avatarInner(w) + '</div>' +
                    '<div><h1 class="detail-title ux-m0">' + escapeHTML(w.name) + '</h1>' +
                    '<p class="small muted">' + escapeHTML(w.location || 'Location not set') + '</p></div></div>' +
                    (w.bio ? '<section class="detail-section"><h2>About</h2><div class="detail-description">' + escapeHTML(w.bio) + '</div></section>' : '') +
                    (skills.length ? '<section class="detail-section"><h2>Skills (self-reported)</h2><div class="card-tags">' + skills.map(function(s) { return '<span class="tag">' + escapeHTML(s) + '</span>'; }).join('') + '</div></section>' : '') +
                    (categories.length ? '<section class="detail-section"><h2>Works in</h2><div class="card-tags">' + categories.map(function(c) { return '<span class="tag">' + escapeHTML(c) + '</span>'; }).join('') + '</div></section>' : '') +
                    (w.portfolio && w.portfolio.items && w.portfolio.items.length ?
                        '<section class="detail-section"><h2>Verified work on Bounty</h2>' +
                        (w.portfolio.summary ? '<p class="small muted">Summary written by this worker. Bounty has not verified it. Check it against the work below.</p><div class="detail-description">' + escapeHTML(w.portfolio.summary) + '</div>' : '') +
                        '<ul class="check-list">' + w.portfolio.items.map(function(item) {
                            return '<li><strong>' + escapeHTML(item.title) + '</strong> <span class="small muted">· ' + escapeHTML(item.bounty_title) + ' · ' + escapeHTML(item.category_label) + ' · ' + escapeHTML(dateText(item.completed_at)) + '</span>' +
                                (item.excerpt ? '<p class="small">' + escapeHTML(item.excerpt) + '</p>' : '') + '</li>';
                        }).join('') + '</ul></section>' : '') +
                    '<div data-reputation-slot></div><div data-talent-slot></div><section class="detail-section"><h2>Completed bounties</h2>' + (completed ? '<ul class="check-list">' + completed + '</ul>' : '<p class="muted">No completed bounties yet.</p>') + '</section>' +
                    '<section class="detail-section"><h2>Reviews</h2>' + (w.review_count ? '<p>' + escapeHTML(String(w.review_average)) + ' average from ' + escapeHTML(String(w.review_count)) + ' review(s)</p>' + reviews : '<p class="muted">No reviews yet.</p>') + '</section>' +
                    '</article><aside class="panel detail-sidebar"><span class="reward-label">Reputation</span><div class="reward-big">' + escapeHTML(String(w.review_count ? w.review_average : 'New')) + (w.review_count ? ' / 5' : '') + '</div>' +
                    '<dl class="definition-list"><div><dt>Completed bounties</dt><dd>' + escapeHTML(String(w.completed_count)) + '</dd></div>' +
                    (w.website ? '<div><dt>Website</dt><dd>' + escapeHTML(w.website) + '</dd></div>' : '') + '</dl></aside></div></div></section>';
                mountFeature('workerReputation', app.querySelector('[data-reputation-slot]'), w);
                mountFeature('talentActions', app.querySelector('[data-talent-slot]'), w);
            })
            .catch(function(error) {
                app.innerHTML = '<section class="page"><div class="container"><a class="back-link" href="#/bounties">' + icon('arrowLeft', 16) + ' Back to bounties</a><div class="empty-state"><h3>Profile not available</h3><p>' + escapeHTML(friendlyApiError(error, 'This profile could not be loaded.')) + '</p></div></div></section>';
            });
    }

    function legalPage(kind) {
        var isTerms = kind === 'terms';
        var sections = isTerms ? [
            ['Who we are', ['Bounty is a task marketplace where businesses post tasks with rewards and workers submit work for review. Bounty is operated by [legal entity name], registered in [country]. Contact: [support email].']],
            ['Your account', ['You must give accurate information when you sign up. Keep your password private. Verify your email before you post a bounty or submit work. You are responsible for activity on your account.']],
            ['Posting and submitting work', ['Businesses must describe tasks clearly and pay approved rewards as agreed. Workers must submit only work they have the right to share, and must not submit copied, fake, or automated work.']],
            ['Payments', ['The current version of Bounty is a prototype. Payments are simulated and no real money moves. Before real payments start, these terms will be updated to cover payment handling, fees, and refunds.']],
            ['Reviews and reports', ['Reviews must be honest and based on real work. Fake reviews, harassment, or abuse can lead to removal of content and suspension of the account. Anyone involved in a bounty can report it.']],
            ['Suspension and removal', ['We may remove content or suspend accounts that break these terms, abuse the platform, or put other users at risk.']],
            ['Liability', ['Bounty is provided as is, and to the extent the law allows we are not liable for indirect losses. [Liability and warranty wording to be reviewed by a lawyer before launch.]']],
            ['Governing law', ['These terms are governed by the laws of [country]. [To be confirmed with counsel.]']],
            ['Changes', ['We may update these terms. We will tell users about material changes before they take effect.']]
        ] : [
            ['What we collect', ['Account details you give us (name, email, role). Profile details you add (bio, skills, photo, website, location). Bounties, submissions, reviews and reports you create. Basic technical data such as IP address, used to keep the service secure.']],
            ['How we use it', ['To run the marketplace, sign you in, reset your password, send you account and activity notifications, and keep the service secure.']],
            ['What is public', ['Your name, profile details, public reviews, and completed bounty titles appear on your public profile. Your email address is never shown publicly.']],
            ['Who we share it with', ['Service providers that help us run Bounty: hosting, database, and email delivery. When payments go live, our payment partner will receive the details it needs to process payments. We do not sell your personal data.']],
            ['Security', ['Passwords are stored as one-way hashes. Password reset links are stored only as hashes and expire. All traffic should use HTTPS.']],
            ['How long we keep it', ['We keep your account while it is active. You can ask us to delete your account and its personal data, subject to records we must keep by law.']],
            ['Your rights', ['You can ask to see, correct, or delete your personal data. Contact [privacy email]. [Compliance with the Nigeria Data Protection Act 2023 to be reviewed by counsel.]']],
            ['Children', ['Bounty is not intended for anyone under 18.']],
            ['Changes', ['We will post changes to this page and update the date below.']]
        ];

        var body = sections.map(function(s) {
            return '<section class="detail-section"><h2>' + escapeHTML(s[0]) + '</h2>' + s[1].map(function(p) { return '<p>' + escapeHTML(p) + '</p>'; }).join('') + '</section>';
        }).join('');

        app.innerHTML = '<section class="page"><div class="container"><div class="page-header"><span class="eyebrow">Legal</span><h1>' + (isTerms ? 'Terms of use' : 'Privacy policy') + '</h1><p>Draft for the Bounty beta. Final wording must be reviewed by a qualified lawyer before public launch.</p></div>' +
            '<article class="panel">' + body + '<p class="small muted">Last updated: [date]</p></article>' +
            '<p class="auth-switch"><a class="inline-link" href="#/' + (isTerms ? 'privacy' : 'terms') + '">' + (isTerms ? 'Privacy policy' : 'Terms of use') + '</a></p></div></section>';
    }

    // A detail section owned by a feature module. The module decides what to show for this account.
    function addFeatureSection(bounty, id, mount) {
        var main = $('.detail-layout > article');
        if (!isAuthenticated() || !main) return;
        var section = document.createElement('section');
        section.className = 'detail-section';
        section.id = id;
        main.appendChild(section);
        mountFeature(mount, section, bounty);
    }

    // Task workspace: messages between the business and the workers on this task.
    // Hidden for anyone who is not on the task (the server answers 403).
    function addWorkspace(bounty) {
        var main = $('.detail-layout > article');
        if (!isAuthenticated() || !main) return;
        var section = document.createElement('section');
        section.className = 'detail-section';
        section.id = 'workspace';
        section.innerHTML = '<h2>Task workspace</h2><p class="small muted">Visible only to the business and the workers on this task.</p><div id="workspace-thread"><div class="loading-line"><span class="spinner"></span> Loading messages…</div></div>';
        main.appendChild(section);
        var thread = section.querySelector('#workspace-thread');
        var messagesUrl = '/api/bounties/' + encodeURIComponent(bounty.id) + '/messages';

        function paint(messages) {
            var list = messages.length ? messages.map(function(m) {
                var mine = String(m.sender_id) === String(state.user.id);
                return '<div class="message' + (mine ? ' mine' : '') + '"><div class="small muted">' + escapeHTML(m.sender_name) + (m.from_business ? ' · Business' : '') + ' · ' + escapeHTML(new Date(m.created_at).toLocaleString()) + '</div><p>' + escapeHTML(m.body).replace(/\n/g, '<br>') + '</p></div>';
            }).join('') : '<p class="muted">No messages yet. Start the conversation below.</p>';
            thread.innerHTML = '<div class="message-list">' + list + '</div>' +
                '<form id="workspace-form" class="form"><div class="field"><label for="workspace-input">Message</label><textarea id="workspace-input" rows="3" maxlength="2000" placeholder="Write a message about this task"></textarea></div>' +
                '<div class="form-error" id="workspace-error" hidden role="alert"></div><div class="form-actions"><button class="btn btn-primary btn-sm" id="workspace-send" type="submit">Send message</button></div></form>';
            on(thread.querySelector('#workspace-form'), 'submit', function(event) {
                event.preventDefault();
                var input = thread.querySelector('#workspace-input');
                var errorBox = thread.querySelector('#workspace-error');
                var send = thread.querySelector('#workspace-send');
                var body = input.value.trim();
                errorBox.hidden = true;
                if (!body) return showFormError(errorBox, 'Write a message first.');
                send.disabled = true;
                api(messagesUrl, { method: 'POST', body: { body: body } })
                    .then(function() { return api(messagesUrl); })
                    .then(paint)
                    .catch(function(error) {
                        send.disabled = false;
                        showFormError(errorBox, friendlyApiError(error, 'Message not sent.'));
                    });
            });
        }

        api(messagesUrl).then(paint).catch(function(error) {
            if (error && (error.status === 401 || error.status === 403)) { section.remove(); return; }
            thread.innerHTML = '<p class="muted">' + escapeHTML(friendlyApiError(error, 'Messages could not load.')) + '</p>';
        });
    }

    function addReviewAndReport(bounty) {
        var sidebar = $('.detail-sidebar');
        var main = $('.detail-layout > article');
        if (!isAuthenticated() || !sidebar || !main) return;

        var me = String(state.user.id);
        var businessId = bounty.business && bounty.business.id;
        var winnerId = bounty.winner && bounty.winner.id;
        var isOwner = String(businessId) === me;
        var isWinner = !!winnerId && String(winnerId) === me;
        var completed = String(bounty.status || '').toLowerCase() === 'completed';

        // Review: only after completion, and only for the business and the winner.
        if (completed && (isOwner || isWinner)) {
            var counterpart = isOwner ? (bounty.winner && bounty.winner.name) : (bounty.business && bounty.business.name);
            var counterpartLink = isOwner && winnerId ? ' <a class="inline-link small" href="#/worker/' + escapeHTML(winnerId) + '">View profile</a>' : '';
            var reviewHTML = '<section class="detail-section" id="review-section"><h2>Rate ' + escapeHTML(counterpart || 'your counterpart') + '</h2>' + (counterpartLink ? '<p class="small">' + counterpartLink + '</p>' : '') +
                '<form id="review-form" class="form" novalidate><div id="review-error" class="form-error" hidden role="alert"></div>' +
                '<div class="field"><label for="review-rating">Rating</label><select id="review-rating" name="rating">' +
                '<option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Fair</option><option value="2">2 · Poor</option><option value="1">1 · Very poor</option></select></div>' +
                '<div class="field"><label for="review-comment">Comment (optional)</label><textarea id="review-comment" name="comment" maxlength="500" placeholder="What went well, or what could be better?"></textarea></div>' +
                '<button class="btn btn-primary" type="submit" id="review-submit">Submit review</button></form></section>';
            // Placed at the top of the sidebar so it is seen without scrolling past the whole bounty.
            sidebar.insertAdjacentHTML('afterbegin', reviewHTML);

            on($('#review-form'), 'submit', function(event) {
                event.preventDefault();
                var errorBox = $('#review-error');
                errorBox.hidden = true;
                var button = $('#review-submit');
                button.disabled = true;
                api('/api/reviews', {
                    method: 'POST',
                    body: {
                        bounty_id: bounty.id,
                        rating: Number($('#review-rating').value),
                        comment: String($('#review-comment').value || '').trim() || null
                    }
                }).then(function() {
                    $('#review-section').innerHTML = '<h2>Thanks for your review</h2><p class="muted">Your rating helps everyone on Bounty find reliable people and businesses.</p>';
                    toast('Review submitted.', 'success');
                }).catch(function(error) {
                    if (error.status === 409) {
                        $('#review-section').innerHTML = '<h2>Already reviewed</h2><p class="muted">You have already reviewed this bounty.</p>';
                    } else {
                        showFormError(errorBox, friendlyApiError(error, 'Could not submit your review.'));
                        button.disabled = false;
                    }
                });
            });
        }

        // Report: shown to the business and to workers who have a submission on this bounty.
        function addReportButton(show) {
            if (!show) return;
            var wrap = document.createElement('div');
            wrap.className = 'report-box';
            wrap.style.marginTop = '18px';
            wrap.innerHTML = '<button class="btn btn-sm btn-quiet" type="button" id="report-toggle">Report this bounty</button>' +
                '<form id="report-form" class="form ux-mt12" hidden novalidate><div id="report-error" class="form-error" hidden role="alert"></div>' +
                '<div class="field"><label for="report-reason">Reason</label><select id="report-reason" name="reason">' +
                REPORT_REASONS.map(function(r) { return '<option value="' + r[0] + '">' + escapeHTML(r[1]) + '</option>'; }).join('') +
                '</select></div><div class="field"><label for="report-details">Details (optional)</label><textarea id="report-details" name="details" maxlength="1000" placeholder="Tell us what happened"></textarea></div>' +
                '<button class="btn btn-sm" type="submit" id="report-submit">Send report</button></form>';
            sidebar.appendChild(wrap);

            on($('#report-toggle'), 'click', function() {
                var form = $('#report-form');
                form.hidden = !form.hidden;
            });

            on($('#report-form'), 'submit', function(event) {
                event.preventDefault();
                var errorBox = $('#report-error');
                errorBox.hidden = true;
                var button = $('#report-submit');
                button.disabled = true;
                api('/api/reports', {
                    method: 'POST',
                    body: {
                        bounty_id: bounty.id,
                        reason: $('#report-reason').value,
                        details: String($('#report-details').value || '').trim() || null
                    }
                }).then(function() {
                    $('#report-form').hidden = true;
                    toast('Report sent. Thank you for helping keep Bounty fair.', 'success');
                }).catch(function(error) {
                    if (error.status === 409) {
                        showFormError(errorBox, 'You have already reported this bounty.');
                    } else {
                        showFormError(errorBox, friendlyApiError(error, 'Could not send your report.'));
                    }
                    button.disabled = false;
                });
            });
        }

        if (isOwner) {
            addReportButton(true);
        } else {
            api('/api/dashboard/' + encodeURIComponent(state.user.id))
                .then(function(data) {
                    var mine = ((data && data.recent_submissions) || []).some(function(s) {
                        return String(s.bounty_id) === String(bounty.id);
                    });
                    addReportButton(mine || isWinner);
                })
                .catch(function() {});
        }
    }

    /* ============ ADMIN: REPORTS ============ */

    var ADMIN_FILTERS = ['open', 'resolved', 'dismissed', 'all'];

    function reasonLabel(value) {
        for (var i = 0; i < REPORT_REASONS.length; i++) {
            if (REPORT_REASONS[i][0] === value) return REPORT_REASONS[i][1];
        }
        return titleCase(value || 'other');
    }

    function adminPage() {
        if (!isAuthenticated()) return requireAuth('admin');
        if (!state.user.is_admin) {
            // The cached login may predate the admin flag, so ask the server before refusing.
            api('/api/profile/me').then(function(me) {
                syncVerified(me);
                if (me.is_admin === true) return adminPage();
                app.innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h3>Admins only</h3><p>This page is for the Bounty team.</p><a class="btn" href="#/">Back to homepage</a></div></div></section>';
            }).catch(function() {
                app.innerHTML = '<section class="page"><div class="container"><div class="empty-state"><h3>Admins only</h3><p>Could not confirm your admin access. Try signing in again.</p><a class="btn" href="#/">Back to homepage</a></div></div></section>';
            });
            return;
        }

        var filter = ADMIN_FILTERS.indexOf(queryParam('status')) !== -1 ? queryParam('status') : 'open';
        app.innerHTML = '<section class="page"><div class="container">' +
            '<div class="page-header"><span class="eyebrow">Admin</span><h1>Reports</h1><p>Review reports on bounties. Resolve or dismiss each one with a short note. The person who reported it is notified.</p></div>' +
            '<nav class="card-tags" aria-label="Filter reports">' + ADMIN_FILTERS.map(function(f) {
                return '<a class="tag' + (f === filter ? ' active' : '') + '" href="#/admin?status=' + f + '">' + escapeHTML(titleCase(f)) + '</a>';
            }).join('') + '</nav>' +
            '<div id="admin-list" class="ux-mt18"><div class="loading-line"><span class="spinner"></span> Loading reports…</div></div></div></section>';

        api('/api/admin/reports?status=' + encodeURIComponent(filter))
            .then(function(rows) {
                var list = $('#admin-list');
                if (!rows.length) {
                    list.innerHTML = '<div class="empty-state"><h3>No ' + escapeHTML(filter === 'all' ? '' : filter + ' ') + 'reports</h3><p>Nothing needs attention here.</p></div>';
                    return;
                }
                list.innerHTML = rows.map(function(r) {
                    var open = r.status === 'open';
                    return '<article class="panel ux-mb16" data-report="' + escapeHTML(r.id) + '">' +
                        '<div class="ux-row-between"><h3 class="ux-m0">' + escapeHTML(reasonLabel(r.reason)) + '</h3>' +
                        '<span class="status-pill ' + statusClass(r.status) + '">' + escapeHTML(titleCase(r.status)) + '</span></div>' +
                        '<p><a href="#/bounties/' + encodeURIComponent(r.bounty_id) + '">' + escapeHTML(r.bounty_title) + '</a> <span class="small muted">· bounty ' + escapeHTML(titleCase(r.bounty_status || '')) + '</span></p>' +
                        '<p class="small muted">Reported by ' + escapeHTML(r.reporter_name) + ' (' + escapeHTML(titleCase(r.reporter_role || '')) + ') · ' + escapeHTML(dateText(r.created_at)) +
                        ' · Business: ' + escapeHTML(r.business_name || '—') + ' · Winner: ' + escapeHTML(r.winner_name || 'none yet') + '</p>' +
                        (r.details ? '<div class="detail-description">' + escapeHTML(r.details) + '</div>' : '<p class="small muted">No details given.</p>') +
                        (r.admin_note ? '<p class="small"><strong>Admin note:</strong> ' + escapeHTML(r.admin_note) + '</p>' : '') +
                        (r.resolved_at ? '<p class="small muted">Closed ' + escapeHTML(dateText(r.resolved_at)) + '</p>' : '') +
                        (open ?
                            '<div class="field ux-mt12"><label for="note-' + escapeHTML(r.id) + '">Note to the reporter (optional)</label><textarea id="note-' + escapeHTML(r.id) + '" maxlength="1000" placeholder="What did you decide and why?"></textarea></div>' +
                            '<div class="ux-actions"><button class="btn btn-primary btn-sm" type="button" data-decision="resolved">Resolve</button><button class="btn btn-sm" type="button" data-decision="dismissed">Dismiss</button></div>' :
                            '') +
                        '</article>';
                }).join('');
            })
            .catch(function(error) {
                $('#admin-list').innerHTML = '<div class="empty-state"><h3>Could not load reports</h3><p>' + escapeHTML(friendlyApiError(error, 'Try again in a moment.')) + '</p></div>';
            });
    }

    on(document, 'click', function(event) {
        var button = event.target.closest ? event.target.closest('[data-decision]') : null;
        if (!button) return;
        var card = button.closest('[data-report]');
        var reportId = card.getAttribute('data-report');
        var noteBox = $('#note-' + reportId);
        var note = noteBox ? String(noteBox.value || '').trim() : '';
        var decision = button.getAttribute('data-decision');
        var question = decision === 'resolved' ?
            'Resolve this report? The person who filed it will be notified.' :
            'Dismiss this report? The person who filed it will be notified.';
        if (!window.confirm(question)) return;

        $$('[data-decision]', card).forEach(function(b) { b.disabled = true; });
        api('/api/admin/reports/' + encodeURIComponent(reportId), {
            method: 'PATCH',
            body: { status: decision, admin_note: note || null }
        }).then(function() {
            toast('Report ' + decision + '.', 'success');
            adminPage();
        }).catch(function(error) {
            toast(friendlyApiError(error, 'Could not update this report.'), 'error');
            $$('[data-decision]', card).forEach(function(b) { b.disabled = false; });
        });
    });

    /* ============ FEATURE KIT ============
       Feature modules in public/features/ load before this file. They use the helpers below
       through window.BountyKit and register screens and mount points on window.BountyFeatures. */
    window.BountyKit = {
        api: api, $: $, $$: $$, on: on, escapeHTML: escapeHTML, icon: icon, go: go, toast: toast,
        friendlyApiError: friendlyApiError, showFormError: showFormError, dateText: dateText,
        titleCase: titleCase, statusClass: statusClass, getRole: getRole,
        isAuthenticated: isAuthenticated, currentRoute: currentRoute, queryParam: queryParam,
        app: app, state: state
    };

    function featureRoute(route) {
        var features = window.BountyFeatures && window.BountyFeatures.routes;
        if (!features) return null;
        for (var i = 0; i < features.length; i++) {
            if (features[i].match(route)) return features[i];
        }
        return null;
    }

    function mountFeature(name, container, data) {
        var mounts = window.BountyFeatures && window.BountyFeatures.mounts;
        if (container && mounts && typeof mounts[name] === 'function') mounts[name](container, data);
    }

    function init() {
        // Read the saved mode (set pre-paint by the inline script in index.html).
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
        state.themeMode = normalizeThemeMode(saved);
        // The inline script already set data-theme for light/dark; for system we leave it off.
        if (state.themeMode === 'system') document.documentElement.removeAttribute('data-theme');
        // Repaint the header when the OS scheme flips, so the Sun/Moon icon updates in System mode.
        if (window.matchMedia) {
            var mq = window.matchMedia('(prefers-color-scheme: dark)');
            var listener = function() { if (state.themeMode === 'system') renderHeader(); };
            if (mq.addEventListener) mq.addEventListener('change', listener);
            else if (mq.addListener) mq.addListener(listener);
        }

        if (state.user && !state.user.id) setSession(null, '');
        // Old builds kept the login token in localStorage. Remove it so it cannot be read there.
        localStorage.removeItem(TOKEN_KEY);
        // Confirm the saved user still has a valid session cookie before showing them as signed in.
        if (state.user) {
            api('/api/profile/me', { auth: false }).then(function(me) {
                syncVerified(me);
            }).catch(function() {
                setSession(null, '');
            });
        }

        window.addEventListener('hashchange', function() { render(); });

        document.addEventListener('click', function(event) {
            var anchor = event.target.closest ? event.target.closest('a[href^="#/"]') : null;
            if (!anchor) return;
            var href = anchor.getAttribute('href');
            var protectedRoutes = ['#/bounties', '#/dashboard', '#/bounties/new', '#/projects/new'];
            var isProtected = protectedRoutes.indexOf(href) !== -1 || href.indexOf('#/bounties/') === 0;
            if (!isAuthenticated() && isProtected) {
                event.preventDefault();
                sessionStorage.setItem('bounty_after_auth', href.slice(2));
                go('auth/login');
                toast('Sign in to access the marketplace.');
            }
        });

        document.addEventListener('click', function(event) {
            if (state.themeMenu && !(event.target.closest && event.target.closest('.theme-menu-wrap'))) {
                state.themeMenu = false;
                renderHeader();
            }
            // Choosing a page closes the sidebar, so the page is what the person sees next.
            if (state.mobileMenu && event.target.closest && event.target.closest('#side-menu a')) {
                state.mobileMenu = false;
                renderHeader();
            }
        });

        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && state.mobileMenu) {
                state.mobileMenu = false;
                renderHeader();
                var btn = document.getElementById('menu-btn');
                if (btn) btn.focus();
            }
        });

        render();
    }

    init();
})();