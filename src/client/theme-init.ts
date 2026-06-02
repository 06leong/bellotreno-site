(function () {
    function readTheme() {
        try {
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'dark' || savedTheme === 'light') {
                return savedTheme;
            }
        } catch (error) {
            // Ignore storage errors and fall back to the system preference.
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function readLang() {
        try {
            const savedLang = localStorage.getItem('language');
            if (savedLang === 'zh' || savedLang === 'en' || savedLang === 'it') {
                return savedLang;
            }
        } catch (error) {
            // Ignore storage errors and fall back to the browser language.
        }
        const bl = navigator.language.toLowerCase();
        return bl.startsWith('zh') ? 'zh' : bl.startsWith('it') ? 'it' : 'en';
    }

    function applyPreferences(targetRoot) {
        if (!targetRoot) return;

        const theme = readTheme();
        const lang = readLang();
        const langMap = { zh: 'zh-CN', en: 'en', it: 'it' };

        targetRoot.setAttribute('data-theme', theme);
        targetRoot.setAttribute('data-lang', lang);
        targetRoot.lang = langMap[lang] || lang;
        if (lang !== 'zh') {
            targetRoot.setAttribute('data-lang-loading', '');
        } else {
            targetRoot.removeAttribute('data-lang-loading');
        }
        window.currentLang = lang;
    }

    applyPreferences(document.documentElement);

    if (!window.__btThemeSwapGuard) {
        window.__btThemeSwapGuard = true;
        document.addEventListener('astro:before-swap', function (event) {
            const newDocument = Reflect.get(event, 'newDocument');
            applyPreferences(newDocument && newDocument.documentElement);
        });
        document.addEventListener('astro:after-swap', function () {
            applyPreferences(document.documentElement);
        });
    }
})();
