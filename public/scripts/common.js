/**
 * BelloTreno - Common UI Logic
 */

window.currentLang = window.currentLang || 'zh';
window.currentTheme = 'auto';

// ========== Language Management ==========

function initLanguage() {
    const lang = document.documentElement.getAttribute('data-lang');
    if (lang) {
        window.currentLang = lang;
    }
    updateLanguage();
}

function updateLanguage() {
    const langNames = { zh: 'CN', en: 'EN', it: 'IT' };
    const currentLangEl = document.getElementById('currentLang');
    if (currentLangEl) currentLangEl.textContent = langNames[window.currentLang];
    const langMap = { zh: 'zh-CN', en: 'en', it: 'it' };
    document.documentElement.lang = langMap[window.currentLang] || window.currentLang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = (typeof translations !== 'undefined' && translations[window.currentLang]) ? translations[window.currentLang][key] : null;

        if (translation) {
            if (el.hasAttribute('placeholder')) {
                el.setAttribute('placeholder', translation);
            }
            el.textContent = translation;
        }
    });

    const visitorCountEl = document.getElementById('visitorCount');
    if (visitorCountEl && window.visitorCountData !== undefined) {
        const template = (typeof translations !== 'undefined' && translations[window.currentLang]) ? translations[window.currentLang]['visitor_counter'] : '{count}';
        visitorCountEl.textContent = template.replace('{count}', window.visitorCountData);
    }

    if (window.onLanguageChanged) window.onLanguageChanged();

    document.documentElement.removeAttribute('data-lang-loading');
}

function changeLang(lang) {
    window.currentLang = lang;
    localStorage.setItem('language', lang);
    updateLanguage();
}

// ========== Theme Management ==========

function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'auto';
    window.currentTheme = savedTheme;
    applyTheme();
    updateThemeDisplay();
}

function applyTheme() {
    const root = document.documentElement;
    root.classList.add('theme-transitioning');

    if (window.currentTheme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
        root.setAttribute('data-theme', window.currentTheme);
    }

    setTimeout(() => root.classList.remove('theme-transitioning'), 350);
}

function updateThemeDisplay() {
    const themeIcons = { 'auto': 'contrast', 'light': 'light_mode', 'dark': 'dark_mode' };
    const currentThemeIconEl = document.getElementById('currentThemeIcon');
    if (currentThemeIconEl) {
        currentThemeIconEl.textContent = themeIcons[window.currentTheme];
    }
}

function changeTheme(theme) {
    window.currentTheme = theme;
    localStorage.setItem('theme', theme);
    applyTheme();
    updateThemeDisplay();
}

// ========== UI Interactions ==========

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function initVisitorCounter() {
    const workerUrl = window.COUNTER_URL || 'https://site-counter.bellotreno.workers.dev/';
    try {
        const response = await fetch(workerUrl);
        const data = await response.json();
        window.visitorCountData = data.count;
        updateLanguage();
    } catch (error) {
        console.error('Failed to fetch visitor count:', error);
    }
}

// Export to global
window.initLanguage = initLanguage;
window.updateLanguage = updateLanguage;
window.changeLang = changeLang;
window.initTheme = initTheme;
window.applyTheme = applyTheme;
window.updateThemeDisplay = updateThemeDisplay;
window.changeTheme = changeTheme;
window.scrollToTop = scrollToTop;
window.initVisitorCounter = initVisitorCounter;

document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    initTheme();
    initVisitorCounter();

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (window.currentTheme === 'auto') {
            applyTheme();
        }
    });

    window.addEventListener('scroll', () => {
        const backToTop = document.querySelector('.back-to-top');
        if (backToTop) {
            backToTop.classList.toggle('show', window.scrollY > 300);
        }
    });
});
