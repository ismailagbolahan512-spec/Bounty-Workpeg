// Sets data-theme before stylesheets paint, so a saved Light/Dark choice does not flash the
// wrong scheme on reload. System mode leaves the attribute off; tokens.css then follows
// prefers-color-scheme. Runs synchronously, loaded from <head>, no CSP violation.
(function () {
    try {
        var saved = localStorage.getItem('bounty_theme');
        if (saved === 'light' || saved === 'dark') {
            document.documentElement.setAttribute('data-theme', saved);
        }
    } catch (e) { /* storage disabled — fall through to system */ }
})();
