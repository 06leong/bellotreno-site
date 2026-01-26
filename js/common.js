/**
 * BelloTreno 通用逻辑
 * 处理语言切换、主题切换及全局 UI 交互
 */

// 全局状态由 i18n.js 提供 translations，此处管理当前状态
window.currentLang = 'zh';
window.currentTheme = 'auto';

// ========== 语言管理 ==========

function initLanguage() {
    const savedLang = localStorage.getItem('language');
    if (savedLang) {
        window.currentLang = savedLang;
    } else {
        const browserLang = navigator.language.toLowerCase();
        if (browserLang.startsWith('zh')) {
            window.currentLang = 'zh';
        } else if (browserLang.startsWith('it')) {
            window.currentLang = 'it';
        } else {
            window.currentLang = 'en';
        }
    }
    updateLanguage();
}

function updateLanguage() {
    const langNames = { zh: 'Chinese', en: 'English', it: 'Italiano' };
    const currentLangEl = document.getElementById('currentLang');
    if (currentLangEl) currentLangEl.textContent = langNames[window.currentLang];
    document.documentElement.lang = window.currentLang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = (typeof translations !== 'undefined' && translations[window.currentLang]) ? translations[window.currentLang][key] : null;

        if (translation) {
            const tagName = el.tagName.toLowerCase();

            // 如果是 Material Web Components 或明确需要 label 的元素
            if (tagName.startsWith('md-') || el.hasAttribute('label')) {
                el.setAttribute('label', translation);
            }

            // 如果是输入框或带有 placeholder 的元素
            if (el.hasAttribute('placeholder')) {
                el.setAttribute('placeholder', translation);
            }

            // 只有当元素不是复杂的 Material 组件（如 md-outlined-select）时，才直接更新 textContent
            const isComplexM3 = tagName === 'md-outlined-select' || tagName === 'md-outlined-text-field' || tagName === 'md-select';

            if (!isComplexM3) {
                // 如果元素内部有 slot="headline" 的 div（常见于 M3 select-option），更新那个 div
                const headline = el.querySelector('[slot="headline"]');
                if (headline) {
                    headline.textContent = translation;
                } else {
                    el.textContent = translation;
                }
            }
        }
    });

    // 更新访客计数显示
    const visitorCountEl = document.getElementById('visitorCount');
    if (visitorCountEl && window.visitorCountData !== undefined) {
        const template = (typeof translations !== 'undefined' && translations[window.currentLang]) ? translations[window.currentLang]['visitor_counter'] : '{count}';
        visitorCountEl.textContent = template.replace('{count}', window.visitorCountData);
    }

    // 触发页面特定的语言更新钩子
    if (window.onLanguageChanged) window.onLanguageChanged();
}

function changeLang(lang) {
    window.currentLang = lang;
    localStorage.setItem('language', lang);
    updateLanguage();
    const langMenu = document.getElementById('langMenu');
    if (langMenu) langMenu.classList.remove('show');
}

// ========== 主题管理 ==========

function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'auto';
    window.currentTheme = savedTheme;
    applyTheme();
    updateThemeDisplay();
}

function applyTheme() {
    if (window.currentTheme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
        document.documentElement.setAttribute('data-theme', window.currentTheme);
    }
}

function updateThemeDisplay() {
    const themeKey = `theme_${window.currentTheme}`;
    const currentThemeEl = document.getElementById('currentTheme');
    if (currentThemeEl && typeof translations !== 'undefined') {
        currentThemeEl.textContent = translations[window.currentLang][themeKey];
        currentThemeEl.setAttribute('data-i18n', themeKey);
    }
}

function changeTheme(theme) {
    window.currentTheme = theme;
    localStorage.setItem('theme', theme);
    applyTheme();
    updateThemeDisplay();
    const themeMenu = document.getElementById('themeMenu');
    if (themeMenu) themeMenu.classList.remove('show');
}

// ========== UI 交互 ==========

function toggleLangMenu() {
    const menu = document.getElementById('langMenu');
    if (menu) {
        menu.classList.toggle('show');
        const themeMenu = document.getElementById('themeMenu');
        if (themeMenu) themeMenu.classList.remove('show');
    }
}

function toggleThemeMenu() {
    const menu = document.getElementById('themeMenu');
    if (menu) {
        menu.classList.toggle('show');
        const langMenu = document.getElementById('langMenu');
        if (langMenu) langMenu.classList.remove('show');
    }
}

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function initVisitorCounter() {
    const workerUrl = 'https://site-counter.bellotreno.workers.dev/';
    try {
        const response = await fetch(workerUrl);
        const data = await response.json();
        window.visitorCountData = data.count;
        updateLanguage(); // 重新触发语言更新以显示数字
    } catch (error) {
        console.error('Failed to fetch visitor count:', error);
    }
}

// 导出到全局
window.initLanguage = initLanguage;
window.updateLanguage = updateLanguage;
window.changeLang = changeLang;
window.initTheme = initTheme;
window.applyTheme = applyTheme;
window.updateThemeDisplay = updateThemeDisplay;
window.changeTheme = changeTheme;
window.toggleLangMenu = toggleLangMenu;
window.toggleThemeMenu = toggleThemeMenu;
window.scrollToTop = scrollToTop;
window.initVisitorCounter = initVisitorCounter;

// 全局初始化绑定
document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    initTheme();
    initVisitorCounter();

    // 点击外部关闭下拉菜单
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.lang-switch') && !e.target.closest('.theme-switch')) {
            const langMenu = document.getElementById('langMenu');
            const themeMenu = document.getElementById('themeMenu');
            if (langMenu) langMenu.classList.remove('show');
            if (themeMenu) themeMenu.classList.remove('show');
        }
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (window.currentTheme === 'auto') {
            applyTheme();
        }
    });

    // 回到顶部按钮显示隐藏
    window.addEventListener('scroll', () => {
        const backToTop = document.querySelector('.back-to-top');
        if (backToTop) {
            if (window.scrollY > 300) {
                backToTop.classList.add('show');
            } else {
                backToTop.classList.remove('show');
            }
        }
    });
});
