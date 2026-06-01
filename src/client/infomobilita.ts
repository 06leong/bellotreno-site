// @ts-nocheck
export {};

/**
 * BelloTreno Infomobilità 模块
 * 负责抓取、解析并展示 RFI RSS 实时公告
 * 已集成 common.js 共享逻辑
 */

const RSS_BASE_URLS = {
    updates: 'https://www.rfi.it/content/rfi/it/news-e-media/infomobilita.rss.updates',
    notices: 'https://www.rfi.it/content/rfi/it/news-e-media/infomobilita.rss.notices'
};

const REGIONS = {
    all: '',
    abruzzo: '.abruzzo',
    basilicata: '.basilicata',
    calabria: '.calabria',
    campania: '.campania',
    emilia_romagna: '.emilia_romagna',
    friuli_venezia_giulia: '.friuli_venezia_giulia',
    lazio: '.lazio',
    liguria: '.liguria',
    lombardia: '.lombardia',
    marche: '.marche',
    molise: '.molise',
    piemonte: '.piemonte',
    puglia: '.puglia',
    sardegna: '.sardegna',
    sicilia: '.sicilia',
    toscana: '.toscana',
    trentino_alto_adige: '.trentino_alto_adige',
    umbria: '.umbria',
    valle_d_aosta: '.valle_d_aosta',
    veneto: '.veneto'
};

let currentMode = 'updates';
let currentRegion = 'all';
let currentFetchController = null;


document.addEventListener('astro:page-load', () => {
    fetchRSS();
});

window.onLanguageChanged = () => {
    fetchRSS();
};

window.changeDropdownRegion = function (val, text, i18nKey) {
    const btnText = document.getElementById('regionBtnText');
    if (btnText) {
        btnText.textContent = text;
        if (i18nKey) {
            btnText.setAttribute('data-i18n', i18nKey);
        } else {
            btnText.removeAttribute('data-i18n');
        }
    }

    currentRegion = val;
    fetchRSS();

    // Close the dropdown cleanly
    if (document.activeElement) {
        document.activeElement.blur();
    }
};

function switchInfoMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;


    document.getElementById('modeUpdatesBtn').classList.toggle('active', mode === 'updates');
    document.getElementById('modeNoticesBtn').classList.toggle('active', mode === 'notices');

    fetchRSS();
}

window.switchInfoMode = switchInfoMode;

/**
 * 切换加载动画显示
 */
function toggleLoading(show) {
    const loader = document.getElementById('infoLoading');
    const content = document.getElementById('rssContent');
    if (loader && content) {
        loader.style.display = show ? 'flex' : 'none';
        content.style.opacity = show ? '0.3' : '1';

    }
}

function replaceContent(element, children = []) {
    if (!element) return;
    element.replaceChildren(...children);
}

function createInfoMessage(text, color = 'var(--text-grey)') {
    const message = document.createElement('div');
    message.style.cssText = `text-align:center;padding:40px;color:${color}`;
    message.textContent = text;
    return message;
}

function createMaterialIcon(name, className = 'material-symbols-outlined text-[16px]') {
    const icon = document.createElement('span');
    icon.className = className;
    icon.textContent = name;
    return icon;
}

function createRSSCard({ title, safeLink, formattedDate, region }) {
    const rssCard = document.createElement('div');
    rssCard.className = 'card bg-base-100/65 backdrop-blur-3xl shadow-glass border border-base-content/10 hover:bg-base-100/75 hover:shadow-lg transition-all mb-4';

    const body = document.createElement('div');
    body.className = 'card-body p-6';

    const heading = document.createElement('h3');
    heading.className = 'card-title text-lg text-base-content leading-snug';
    heading.textContent = title;

    const metaRow = document.createElement('div');
    metaRow.className = 'flex items-center justify-between gap-3 mt-4 flex-wrap';

    const meta = document.createElement('div');
    meta.className = 'flex items-center gap-2 text-sm text-base-content/60';

    const time = document.createElement('span');
    time.className = 'flex items-center gap-1';
    time.append(createMaterialIcon('schedule'), document.createTextNode(` ${formattedDate}`));
    meta.appendChild(time);

    if (region) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-sm badge-ghost custom-info-badge';
        badge.textContent = region;
        meta.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const anchor = document.createElement('a');
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'btn btn-sm custom-readmore-btn rounded-full px-4 gap-1';
    anchor.href = safeLink;

    const readMore = document.createElement('span');
    readMore.setAttribute('data-i18n', 'read_more');
    readMore.textContent = getI18n('read_more');

    anchor.append(readMore, createMaterialIcon('open_in_new'));
    actions.appendChild(anchor);
    metaRow.append(meta, actions);
    body.append(heading, metaRow);
    rssCard.appendChild(body);

    return rssCard;
}

async function fetchRSS() {
    if (currentFetchController) {
        currentFetchController.abort();
    }
    currentFetchController = new AbortController();
    const signal = currentFetchController.signal;

    toggleLoading(true);
    const contentContainer = document.getElementById('rssContent');

    const regionSuffix = REGIONS[currentRegion] || '';
    const targetUrl = `${RSS_BASE_URLS[currentMode]}${regionSuffix}.xml`;

    const proxyBase = window.PROXY_BASE || 'https://ah.bellotreno.workers.dev';
    const proxyUrl = `${proxyBase}/?url=${encodeURIComponent(targetUrl)}&ts=${Date.now()}`;

    try {
        const response = await fetch(proxyUrl, { signal });
        if (!response.ok) throw new Error('Network response was not ok');
        const xmlText = await response.text();

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const itemsArray = Array.from(xmlDoc.querySelectorAll("item"));

        if (itemsArray.length === 0) {
            const message = createInfoMessage(getI18n('no_info_found'));
            message.setAttribute('data-i18n', 'no_info_found');
            replaceContent(contentContainer, [message]);
            return;
        }


        itemsArray.sort((a, b) => {
            const dateA = new Date(a.querySelector("pubDate")?.textContent || 0);
            const dateB = new Date(b.querySelector("pubDate")?.textContent || 0);
            return dateB - dateA;
        });

        renderRSS(itemsArray);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Error fetching RSS:', error);
        replaceContent(contentContainer, [createInfoMessage(`Error: ${error.message}`, 'var(--train-red)')]);
    } finally {
        currentFetchController = null;
        toggleLoading(false);
    }
}

function renderRSS(items) {
    const contentContainer = document.getElementById('rssContent');
    replaceContent(contentContainer);

    items.forEach(item => {
        const title = item.querySelector("title")?.textContent || '';
        const link = item.querySelector("link")?.textContent || '#';
        const pubDateStr = item.querySelector("pubDate")?.textContent || '';
        const region = item.querySelector("region")?.textContent || item.getElementsByTagName("rfi:region")[0]?.textContent || '';

        const date = new Date(pubDateStr);
        let formattedDate = pubDateStr;

        if (!isNaN(date.getTime())) {
            const options = {
                timeZone: 'Europe/Rome',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            };
            const locale = window.currentLang === 'zh' ? 'zh-CN' : (window.currentLang === 'it' ? 'it-IT' : 'en-GB');
            formattedDate = new Intl.DateTimeFormat(locale, options).format(date);
        }

        const safeLink = /^https?:\/\//.test(link) ? link : '#';

        const rssCard = createRSSCard({ title, safeLink, formattedDate, region });
        contentContainer.appendChild(rssCard);
    });
}

/**
 * 简单的辅助函数，获取当前语言下的翻译，带回退
 */
function getI18n(key) {
    if (typeof translations !== 'undefined' && translations[window.currentLang] && translations[window.currentLang][key]) {
        return translations[window.currentLang][key];
    }

    if (key === 'read_more') {
        const fallbacks = { zh: '阅读全文', en: 'Read more', it: 'Leggi tutto' };
        return fallbacks[window.currentLang] || fallbacks.en;
    }
    return key;
}
