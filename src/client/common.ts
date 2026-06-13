import { dispatchBelloLanguageChanged } from './language-events.js';

/**
 * BelloTreno - Common UI Logic
 */

const translations = window.translations || {};

type Language = NonNullable<Window["currentLang"]>;
type ThemePreference = NonNullable<Window["currentTheme"]>;

function isLanguage(value: unknown): value is Language {
    return value === 'zh' || value === 'en' || value === 'it';
}

function isThemePreference(value: unknown): value is ThemePreference {
    return value === 'auto' || value === 'light' || value === 'dark';
}

function normalizeLanguage(value: unknown): Language {
    return isLanguage(value) ? value : 'zh';
}

function normalizeThemePreference(value: unknown): ThemePreference {
    return isThemePreference(value) ? value : 'auto';
}

window.currentLang = normalizeLanguage(window.currentLang);
window.currentTheme = normalizeThemePreference(window.currentTheme);

function blurActiveElement() {
    if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }
}

// ========== Language Management ==========

function initLanguage() {
    window.currentLang = normalizeLanguage(document.documentElement.getAttribute('data-lang') || window.currentLang);
    updateLanguage();
}

function updateLanguage() {
    window.currentLang = normalizeLanguage(window.currentLang);
    const langNames: Record<Language, string> = { zh: 'CN', en: 'EN', it: 'IT' };
    const currentLangEl = document.getElementById('currentLang');
    if (currentLangEl) currentLangEl.textContent = langNames[window.currentLang];
    const langMap: Record<Language, string> = { zh: 'zh-CN', en: 'en', it: 'it' };
    document.documentElement.lang = langMap[window.currentLang] || window.currentLang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = key && typeof translations !== 'undefined' && translations[window.currentLang]
            ? translations[window.currentLang][key]
            : null;

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
        visitorCountEl.textContent = template.replace('{count}', String(window.visitorCountData));
    }

    document.documentElement.removeAttribute('data-lang-loading');
}

function changeLang(lang: Language) {
    window.currentLang = lang;
    document.documentElement.setAttribute('data-lang', lang);
    localStorage.setItem('language', lang);
    updateLanguage();
    dispatchBelloLanguageChanged(window.currentLang);
}

// ========== Theme Management ==========

function initTheme() {
    const storedTheme = localStorage.getItem('theme') || 'auto';
    window.currentTheme = normalizeThemePreference(storedTheme);
    applyTheme();
    updateThemeDisplay();
}

function applyTheme() {
    window.currentTheme = normalizeThemePreference(window.currentTheme);
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
    const themeIcons: Record<ThemePreference, string> = { 'auto': 'contrast', 'light': 'light_mode', 'dark': 'dark_mode' };
    const currentThemeIconEl = document.getElementById('currentThemeIcon');
    if (currentThemeIconEl) {
        currentThemeIconEl.textContent = themeIcons[window.currentTheme];
    }
}

function changeTheme(theme: ThemePreference) {
    window.currentTheme = theme;
    localStorage.setItem('theme', theme);
    applyTheme();
    updateThemeDisplay();
}

// ========== UI Interactions ==========

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindLanguageControls() {
    document.querySelectorAll<HTMLElement>('[data-lang-option]').forEach((control) => {
        if (control.dataset.btBound) return;
        control.dataset.btBound = 'true';
        control.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const lang = control.dataset.lang;
            if (isLanguage(lang)) {
                changeLang(lang);
            }
            blurActiveElement();
        });
    });
}

function bindThemeControls() {
    document.querySelectorAll<HTMLElement>('[data-theme-option]').forEach((control) => {
        if (control.dataset.btBound) return;
        control.dataset.btBound = 'true';
        control.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const theme = control.dataset.themeOption;
            if (isThemePreference(theme)) {
                changeTheme(theme);
            }
            blurActiveElement();
        });
    });
}

function bindBackToTopControl() {
    const backToTop = document.querySelector<HTMLButtonElement>('.back-to-top');
    if (!backToTop || backToTop.dataset.btBound) return;
    backToTop.dataset.btBound = 'true';
    backToTop.addEventListener('click', () => {
        scrollToTop();
    });
}

function bindGlobalControls() {
    bindLanguageControls();
    bindThemeControls();
    bindBackToTopControl();
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
window.initTheme = initTheme;
window.applyTheme = applyTheme;
window.updateThemeDisplay = updateThemeDisplay;
window.initVisitorCounter = initVisitorCounter;

// ========== XSS: HTML 转义工具 ==========
// 用于将 API 返回的字符串安全地插入 innerHTML
function escapeHtml(str: unknown): string {
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
    bindGlobalControls();

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
