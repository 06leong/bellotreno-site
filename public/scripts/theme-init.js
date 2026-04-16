(function () {
    var root = document.documentElement;

    var theme = localStorage.getItem('theme');
    if (theme === 'dark' || theme === 'light') {
        root.setAttribute('data-theme', theme);
    } else {
        var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }

    var lang = localStorage.getItem('language');
    if (!lang) {
        var bl = navigator.language.toLowerCase();
        lang = bl.startsWith('zh') ? 'zh' : bl.startsWith('it') ? 'it' : 'en';
    }
    if (lang !== 'zh') {
        root.setAttribute('data-lang-loading', '');
    }
    root.setAttribute('data-lang', lang);
    var langMap = { zh: 'zh-CN', en: 'en', it: 'it' };
    root.lang = langMap[lang] || lang;
    window.currentLang = lang;
})();
