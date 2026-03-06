/**
 * BelloTreno 主题预初始化
 * 在 <head> 中阻塞加载，在页面渲染前同步设置 data-theme 属性
 * 仅处理用户明确选择的主题（dark/light）
 * auto 模式由 CSS @media (prefers-color-scheme) 原生处理
 */
(function () {
    var theme = localStorage.getItem('theme');
    if (theme === 'dark' || theme === 'light') {
        document.documentElement.setAttribute('data-theme', theme);
    }
    // auto 或无设置时：不设置 data-theme 属性
    // CSS 的 @media (prefers-color-scheme: dark) 会自动匹配系统偏好
    // 后续 common.js 的 initTheme() 会补充设置完整的 data-theme
})();
