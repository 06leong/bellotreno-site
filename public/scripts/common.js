/**
 * BelloTreno - Common UI Logic
 */

var SUPPORTED_LOCALES = ['it', 'en', 'zh'];
var DEFAULT_LOCALE = 'it';

window.currentLang = window.currentLang || DEFAULT_LOCALE;
window.currentTheme = 'auto';

// ========== Language Management ==========

function isSupportedLocale(lang) {
    return SUPPORTED_LOCALES.includes(lang);
}

function getRouteLocale() {
    const firstSegment = window.location.pathname.split('/').filter(Boolean)[0];
    return isSupportedLocale(firstSegment) ? firstSegment : null;
}

function setLocalePreference(lang) {
    try {
        localStorage.setItem('language', lang);
    } catch (error) {
        // Ignore storage errors; the URL remains the source of truth.
    }

    try {
        const secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `bt_locale=${encodeURIComponent(lang)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
    } catch (error) {
        // Cookie persistence is best-effort only.
    }
}

function localePath(path, lang = window.currentLang || DEFAULT_LOCALE) {
    const targetLang = isSupportedLocale(lang) ? lang : DEFAULT_LOCALE;
    const url = new URL(path || '/', window.location.origin);

    if (url.origin !== window.location.origin) {
        return url.href;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (isSupportedLocale(parts[0])) {
        parts.shift();
    }

    url.pathname = parts.length ? `/${targetLang}/${parts.join('/')}` : `/${targetLang}/`;
    return `${url.pathname}${url.search}${url.hash}`;
}

function currentLocalePath(lang) {
    return localePath(`${window.location.pathname}${window.location.search}${window.location.hash}`, lang);
}

function initLanguage() {
    const lang = getRouteLocale() || document.documentElement.getAttribute('data-lang') || DEFAULT_LOCALE;
    if (lang) {
        window.currentLang = lang;
        document.documentElement.setAttribute('data-lang', lang);
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
    if (!isSupportedLocale(lang)) return;

    window.currentLang = lang;
    setLocalePreference(lang);
    window.location.href = currentLocalePath(lang);
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
    // 每个会话只计数一次，防止 Astro ClientRouter 页面跳转重复触发
    if (sessionStorage.getItem('_btCounted')) {
        // 已计过数：只更新显示，不再发网络请求
        if (window.visitorCountData !== undefined) updateLanguage();
        return;
    }
    const workerUrl = window.COUNTER_URL || 'https://site-counter.bellotreno.workers.dev/';
    try {
        const response = await fetch(workerUrl);
        const data = await response.json();
        window.visitorCountData = data.count;
        sessionStorage.setItem('_btCounted', '1');
        updateLanguage();
    } catch (error) {
        console.error('Failed to fetch visitor count:', error);
    }
}

// Export to global
window.initLanguage = initLanguage;
window.updateLanguage = updateLanguage;
window.changeLang = changeLang;
window.localePath = localePath;
window.initTheme = initTheme;
window.applyTheme = applyTheme;
window.updateThemeDisplay = updateThemeDisplay;
window.changeTheme = changeTheme;
window.scrollToTop = scrollToTop;
window.initVisitorCounter = initVisitorCounter;

// ========== XSS: HTML 转义工具 ==========
// 用于将 API 返回的字符串安全地插入 innerHTML
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

document.addEventListener('astro:page-load', () => {
    initLanguage();
    initTheme();
    initVisitorCounter();

    if (!window._commonInitialized) {
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
        window._commonInitialized = true;
    }
});
