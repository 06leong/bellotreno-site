(function () {
    function readTheme() {
        try {
            var savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'dark' || savedTheme === 'light') {
                return savedTheme;
            }
        } catch (error) {
            // Ignore storage errors and fall back to the system preference.
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function readLang() {
        var routeLang = readRouteLang();
        if (routeLang) return routeLang;

        try {
            var savedLang = localStorage.getItem('language');
            if (isSupportedLang(savedLang)) {
                return savedLang;
            }
        } catch (error) {
            // Ignore storage errors and fall back to the browser language.
        }
        var bl = navigator.language.toLowerCase();
        if (bl.startsWith('zh')) return 'zh';
        if (bl.startsWith('en')) return 'en';
        return 'it';
    }

    function isSupportedLang(lang) {
        return lang === 'zh' || lang === 'en' || lang === 'it';
    }

    function readRouteLang() {
        var firstSegment = window.location.pathname.split('/').filter(Boolean)[0];
        return isSupportedLang(firstSegment) ? firstSegment : null;
    }

    function applyPreferences(targetRoot) {
        if (!targetRoot) return;

        var theme = readTheme();
        var lang = readLang();
        var langMap = { zh: 'zh-CN', en: 'en', it: 'it' };

        targetRoot.setAttribute('data-theme', theme);
        targetRoot.setAttribute('data-lang', lang);
        targetRoot.lang = langMap[lang] || lang;
        targetRoot.removeAttribute('data-lang-loading');
        window.currentLang = lang;
    }

    applyPreferences(document.documentElement);

    if (!window.__btThemeSwapGuard) {
        window.__btThemeSwapGuard = true;
        document.addEventListener('astro:before-swap', function (event) {
            applyPreferences(event.newDocument && event.newDocument.documentElement);
        });
        document.addEventListener('astro:after-swap', function () {
            applyPreferences(document.documentElement);
        });
    }
})();
