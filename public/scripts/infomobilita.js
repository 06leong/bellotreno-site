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
let isFetching = false;


document.addEventListener('DOMContentLoaded', () => {
    initRegionSelect();
    fetchRSS();
});


window.onLanguageChanged = () => {
    fetchRSS();
};

function initRegionSelect() {
    // Legacy select initialization removed
}

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

async function fetchRSS() {
    if (isFetching) return;
    isFetching = true;

    toggleLoading(true);
    const contentContainer = document.getElementById('rssContent');

    const regionSuffix = REGIONS[currentRegion] || '';
    const targetUrl = `${RSS_BASE_URLS[currentMode]}${regionSuffix}.xml`;


    const requestKey = `${currentMode}_${currentRegion}`;

    const proxyUrl = `https://ah.bellotreno.workers.dev/?url=${encodeURIComponent(targetUrl)}&ts=${Date.now()}`;

    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error('Network response was not ok');
        const xmlText = await response.text();


        if (requestKey !== `${currentMode}_${currentRegion}`) return;

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const itemsArray = Array.from(xmlDoc.querySelectorAll("item"));

        if (itemsArray.length === 0) {
            contentContainer.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-grey);" data-i18n="no_info_found">${getI18n('no_info_found')}</div>`;
            return;
        }


        itemsArray.sort((a, b) => {
            const dateA = new Date(a.querySelector("pubDate")?.textContent || 0);
            const dateB = new Date(b.querySelector("pubDate")?.textContent || 0);
            return dateB - dateA;
        });

        renderRSS(itemsArray);
    } catch (error) {
        console.error('Error fetching RSS:', error);
        contentContainer.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--train-red);">Error: ${error.message}</div>`;
    } finally {
        isFetching = false;
        toggleLoading(false);
    }
}

function renderRSS(items) {
    const contentContainer = document.getElementById('rssContent');
    contentContainer.innerHTML = '';

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

        const rssCard = document.createElement('div');
        rssCard.className = 'card bg-base-100 shadow-sm border border-base-200 hover:shadow-md transition-shadow mb-4';
        rssCard.innerHTML = `
            <div class="card-body p-6">
                <h3 class="card-title text-lg text-base-content leading-snug">${title}</h3>
                <div class="flex items-center justify-between gap-3 mt-4 flex-wrap">
                    <div class="flex items-center gap-2 text-sm text-base-content/60">
                        <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">schedule</span> ${formattedDate}</span>
                        ${region ? `<span class="badge badge-sm badge-ghost text-[#006a6a] dark:text-[#4db6ac] bg-[#006a6a]/10 dark:bg-[#4db6ac]/10 border-transparent">${region}</span>` : ''}
                    </div>
                    <div class="card-actions">
                        <a href="${link}" target="_blank" class="btn btn-sm bg-[#006a6a] hover:bg-[#005050] text-white dark:bg-[#4db6ac] dark:text-gray-900 dark:hover:bg-[#3ca096] border-none rounded-full px-4 gap-1">
                            <span data-i18n="read_more">${getI18n('read_more')}</span>
                            <span class="material-symbols-outlined text-[16px]">open_in_new</span>
                        </a>
                    </div>
                </div>
            </div>
        `;
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
