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
