/**
 * BelloTreno 主应用逻辑
 * 包含所有核心功能和事件处理
 */


let currentTrainData = null;
let currentTriple = null;
let searchMode = 'train';
let disambiguationData = null;
let currentSmartCaringData = null;
let currentTrainCategory = '';
let currentSwissFormationData = null;
let swissRequestSeq = 0;


const API_BASE = window.API_BASE;
const NOTIFY_BASE = window.NOTIFY_BASE;

async function fetchStatistiche() {
    try {
        const res = await fetch(API_BASE + '/statistiche/0');
        if (!res.ok) return;
        const data = await res.json();
        const circolanti = document.getElementById('statsCircolanti');
        const giorno = document.getElementById('statsGiorno');
        const bar = document.getElementById('statsBar');
        if (circolanti) circolanti.textContent = data.treniCircolanti.toLocaleString();
        if (giorno) giorno.textContent = data.treniGiorno.toLocaleString();
        if (bar) bar.classList.remove('opacity-0');
    } catch (e) {
        console.error('Stats fetch failed:', e);
    }
}




function updateSearchLabel() {
    const trainSearch = document.getElementById('trainSearch');
    const searchIcon = document.getElementById('searchIcon');
    if (!trainSearch) return;

    if (searchMode === 'train') {
        trainSearch.placeholder = translations[window.currentLang].search_label_train;
        if (searchIcon) searchIcon.textContent = 'train';
    } else {
        trainSearch.placeholder = translations[window.currentLang].search_label_station;
        if (searchIcon) searchIcon.textContent = 'location_on';
    }
}


function switchSearchMode(mode) {
    searchMode = mode;

    updateSearchLabel();


    const trainSearch = document.getElementById('trainSearch');
    if (trainSearch) trainSearch.value = '';


    const results = document.getElementById('results');
    const disambiguation = document.getElementById('disambiguation');
    if (results) results.style.display = 'none';
    if (disambiguation) disambiguation.style.display = 'none';
    currentSmartCaringData = null;
    currentSwissFormationData = null;
    swissRequestSeq++;
    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
    if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
}



window.onLanguageChanged = function () {

    updateSearchLabel();


    if (disambiguationData) {
        renderDisambiguation();
    }


    if (currentTrainData) {
        render(currentTrainData);
    }
    if (currentSmartCaringData) {
        renderSmartCaring(currentSmartCaringData);
    }
};


function goHome() {
    window.location.href = '/';
}




function formatDuration(duration) {
    if (!duration) return 'N/A';
    const parts = duration.split(':');
    if (parts.length === 2) {
        const hours = parseInt(parts[0]);
        const mins = parseInt(parts[1]);
        // zh: 无分隔空格（「1小时30分钟」），其他语言：加空格（「1h 30min」）
        return formatDurationMinutes((hours * 60) + mins);
    }
    return duration;
}

function formatDurationMinutes(totalMinutes) {
    if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return 'N/A';
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const t = translations[window.currentLang] || translations.en;
    return window.currentLang === 'zh'
        ? `${hours}${t.hours}${mins}${t.minutes}`
        : `${hours}${t.hours} ${mins}${t.minutes}`;
}


function translateStatus(text) {
    if (!text) return "";

    // Global cleanup: remove trailing dot from "min."
    text = text.replace(/min\./gi, "min");

    if (window.currentLang === 'zh') {
        return text
            .replace(/non partito/gi, "未出发")
            .replace(/con un anticipo di/gi, "提前")
            .replace(/con un ritardo di/gi, "晚点")
            .replace(/in orario/gi, "准点")
            .replace(/(\d+)\s*min/g, "$1分钟");
    } else if (window.currentLang === 'en') {
        return text
            .replace(/non partito/gi, "Not Departed")
            .replace(/con un anticipo di/gi, "Early:")
            .replace(/con un ritardo di/gi, "Delay:")
            .replace(/in orario/gi, "On Time");
    } else if (window.currentLang === 'it') {
        return text
            .replace(/con un anticipo di/gi, "Anticipo:")
            .replace(/con un ritardo di/gi, "Ritardo:");
    }

    return text;
}

function formatT(ms) {
    if (!ms) return null;
    return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
}

function renderTimeHtml(label, schedMs, realMs, delayMin) {
    const sched = formatT(schedMs);
    const real = formatT(realMs);
    const timeToShow = real || sched || '--:--';
    // Only colorize if we have a real time.
    const colorClass = real ? ((delayMin > 0) ? 'late' : 'early') : '';
    return `<div class="time-item"><span class="time-label">${label}</span><span class="time-val-real tabular-nums ${colorClass}">${timeToShow}</span></div>`;
}




function saveRecentSearch(trainNumber, trainInfo) {
    try {
        let recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');

        const searchItem = {
            id: trainNumber,
            name: `${trainNumber} ${trainInfo.origine || ''} → ${trainInfo.destinazione || ''}`.trim(),
            type: 'train',
            timestamp: Date.now()
        };

        recentSearches = recentSearches.filter(item => !(item.type === 'train' && item.id === trainNumber));
        recentSearches.unshift(searchItem);

        if (recentSearches.length > 5) {
            recentSearches = recentSearches.slice(0, 5);
        }

        localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
        renderRecentSearches();
    } catch (err) {
        console.error('Failed to save recent search:', err);
    }
}


function saveRecentStationSearch(stationId, stationName) {
    try {
        let recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');

        const searchItem = {
            id: stationId,
            name: stationName,
            type: 'station',
            timestamp: Date.now()
        };

        recentSearches = recentSearches.filter(item => !(item.type === 'station' && item.id === stationId));
        recentSearches.unshift(searchItem);

        if (recentSearches.length > 5) {
            recentSearches = recentSearches.slice(0, 5);
        }

        localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
        renderRecentSearches();
    } catch (err) {
        console.error('Failed to save recent station search:', err);
    }
}


function loadRecentSearches() {
    try {

        const oldData = localStorage.getItem('recentTrains');
        if (oldData && !localStorage.getItem('recentSearches')) {
            const oldSearches = JSON.parse(oldData);
            const newSearches = oldSearches.map(item => ({
                id: item.number,
                name: `${item.number} ${item.origin || ''} → ${item.destination || ''}`.trim(),
                type: 'train',
                timestamp: item.timestamp
            }));
            localStorage.setItem('recentSearches', JSON.stringify(newSearches));
            localStorage.removeItem('recentTrains');
        }

        const recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');
        if (recentSearches.length > 0) {
            renderRecentSearches();
        }
    } catch (err) {
        console.error('Failed to load recent searches:', err);
    }
}


function renderRecentSearches() {
    try {
        const recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');
        const container = document.getElementById('recentSearchesContainer');
        const chipsContainer = document.getElementById('recentSearchesChips');

        if (recentSearches.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        chipsContainer.innerHTML = '';

        recentSearches.forEach(item => {
            const chip = document.createElement('div');
            chip.className = 'assist-chip';


            const icon = item.type === 'station' ? 'location_on' : 'train';

            chip.innerHTML = `
                <span class="material-symbols-outlined chip-icon">${icon}</span>
                <span class="chip-label"></span>
                <span class="chip-remove">
                    <span class="material-symbols-outlined">close</span>
                </span>
            `;
            chip.querySelector('.chip-label').textContent = item.name;
            chip.querySelector('.chip-remove').addEventListener('click', (e) => {
                removeRecentSearch(item.id, item.type, e);
            });

            chip.querySelector('.chip-label').addEventListener('click', () => {
                if (item.type === 'train') {
                    if (searchMode !== 'train') {
                        switchSearchMode('train');
                    }
                    document.getElementById('trainSearch').value = item.id;
                    startSearch(item.id);
                } else if (item.type === 'station') {
                    goToStationBoard(item.id, item.name);
                }
            });

            chipsContainer.appendChild(chip);
        });
    } catch (err) {
        console.error('Failed to render recent searches:', err);
    }
}


function removeRecentSearch(id, type, event) {
    if (event) {
        event.stopPropagation();
    }

    try {
        let recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]');
        recentSearches = recentSearches.filter(item => !(item.id === id && item.type === type));
        localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
        renderRecentSearches();
    } catch (err) {
        console.error('Failed to remove recent search:', err);
    }
}



async function startSearch(input) {
    document.getElementById('results').style.display = 'none';
    document.getElementById('disambiguation').style.display = 'none';

    if (searchMode === 'train') {

        const trainNumber = input.replace(/\D+/g, '').trim();

        if (!trainNumber) {
            const msg = currentLang === 'zh' ? "请输入有效的车次号" :
                currentLang === 'it' ? "Inserire un numero di treno valido" :
                    "Please enter a valid train number";
            return alert(msg);
        }

        try {
            const autoRes = await fetch(`${API_BASE}/cercaNumeroTrenoTrenoAutocomplete/${trainNumber}`);
            const autoText = await autoRes.text();
            if (!autoText.trim()) {
                const msg = window.currentLang === 'zh' ? "未找到该车次" :
                    window.currentLang === 'it' ? "Treno non trovato" :
                        "Train not found";
                return alert(msg);
            }

            const lines = autoText.trim().split('\n');
            if (lines.length > 1) {
                showDisambiguation(lines);
            } else {
                fetchDetails(lines[0].split('|')[1]);
            }
        } catch (err) {
            const msg = currentLang === 'zh' ? "搜索失败" :
                currentLang === 'it' ? "Ricerca fallita" :
                    "Search failed";
            alert(msg);
        }
    } else if (searchMode === 'station') {

        const keyword = input.trim();

        if (!keyword) {
            const msg = window.currentLang === 'zh' ? "请输入车站名" :
                window.currentLang === 'it' ? "Inserire il nome della stazione" :
                    "Please enter station name";
            return alert(msg);
        }

        try {
            const stationRes = await fetch(`${API_BASE}/cercaStazione/${encodeURIComponent(keyword)}`);
            const stationData = await stationRes.json();

            if (!stationData || stationData.length === 0) {
                const msg = translations[window.currentLang].no_station_found;
                return alert(msg);
            }

            showStationDisambiguation(stationData);
        } catch (err) {
            console.error('车站搜索失败:', err);
            const msg = window.currentLang === 'zh' ? "搜索失败" :
                window.currentLang === 'it' ? "Ricerca fallita" :
                    "Search failed";
            alert(msg);
        }
    }
}



function showDisambiguation(lines) {
    disambiguationData = lines;
    renderDisambiguation();
}

function renderDisambiguation() {
    if (!disambiguationData) return;

    const list = document.getElementById('choicesList');
    const panel = document.getElementById('disambiguation');
    list.innerHTML = '';

    disambiguationData.forEach(line => {
        const [label, triple] = line.split('|');
        const [tNum, sID, ts] = triple.split('-');
        const dateObj = new Date(parseInt(ts));
        const dateStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Rome' });

        const div = document.createElement('div');
        div.className = 'choice-item ripple';
        div.innerHTML = `
            <div style="font-size:1.1rem; font-weight:bold; color:var(--color-primary)">${label}</div>
            <div style="font-size:0.9rem; color:var(--color-base-content); opacity:0.6; margin-top:4px">
                <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle">calendar_month</span> ${translations[currentLang].depart_date}: ${dateStr} 
                | <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle">location_on</span> ${translations[currentLang].origin_station}: ${sID}
            </div>
        `;
        div.onclick = () => {
            panel.style.display = 'none';
            disambiguationData = null;
            fetchDetails(triple);
        };
        list.appendChild(div);
    });
    panel.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}


function showStationDisambiguation(stations) {
    const list = document.getElementById('choicesList');
    const panel = document.getElementById('disambiguation');
    const panelTitle = panel.querySelector('h3');

    const titleText = currentLang === 'zh' ? '选择车站：' :
        currentLang === 'it' ? 'Seleziona stazione:' :
            'Select station:';
    panelTitle.textContent = titleText;

    list.innerHTML = '';

    stations.forEach(station => {
        const div = document.createElement('div');
        div.className = 'choice-item ripple';
        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px">
                <span class="material-symbols-outlined" style="font-size:24px; color:var(--color-primary)">location_on</span>
                <div>
                    <div style="font-size:1.1rem; font-weight:bold; color:var(--color-primary)">${station.nomeLungo}</div>
                    <div style="font-size:0.9rem; color:var(--color-base-content); opacity:0.6; margin-top:2px">ID: ${station.id}</div>
                </div>
            </div>
        `;
        div.onclick = () => {
            panel.style.display = 'none';
            saveRecentStationSearch(station.id, station.nomeLungo);
            goToStationBoard(station.id, station.nomeLungo);
        };
        list.appendChild(div);
    });

    panel.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}



async function fetchDetails(triple) {
    currentTriple = triple;
    currentSmartCaringData = null;
    currentSwissFormationData = null;
    const requestSeq = ++swissRequestSeq;
    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
    if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
    const [tNum, originID, ts] = triple.split('-');
    try {
        const res = await fetch(`${API_BASE}/andamentoTreno/${originID}/${tNum}/${ts}`);
        if (res.status === 204) {
            const msg = currentLang === 'zh' ? "该班次暂无实时数据（可能已过期或尚未生成）" :
                currentLang === 'it' ? "Nessun dato in tempo reale per questo treno (potrebbe essere scaduto o non ancora generato)" :
                    "No real-time data for this train (may be expired or not yet generated)";
            return alert(msg);
        }
        const data = await res.json();
        currentTrainData = data;
        currentTrainCategory = resolveTrainCategory(data);
        render(data);
        fetchSmartCaring(data.numeroTreno);
        loadSwissFormation(data, triple, requestSeq);


        const trainNumber = `${data.compCategoria || ''} ${data.numeroTreno || tNum}`.trim();
        saveRecentSearch(trainNumber, data);
    } catch (err) {
        const msg = currentLang === 'zh' ? "详情加载失败" :
            currentLang === 'it' ? "Impossibile caricare i dettagli" :
                "Failed to load details";
        alert(msg);
    }
}

async function loadSwissFormation(data, triple, requestSeq) {
    if (!window.BelloSwiss || !window.BelloSwiss.shouldQuery(data, currentTrainCategory)) {
        if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
        return;
    }

    window.BelloSwiss.renderLoadingCard();

    try {
        const swissData = await window.BelloSwiss.fetchSwissEc(data, currentTrainCategory);
        if (requestSeq !== swissRequestSeq || triple !== currentTriple) return;

        if (!swissData?.available) {
            currentSwissFormationData = null;
            window.BelloSwiss.hideFormationCard();
            render(currentTrainData);
            return;
        }

        currentSwissFormationData = swissData;
        render(currentTrainData);
    } catch (err) {
        if (requestSeq !== swissRequestSeq || triple !== currentTriple) return;
        console.error('Swiss formation fetch failed:', err);
        currentSwissFormationData = null;
        if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
        render(currentTrainData);
    }
}


async function refreshTrainData() {
    if (!currentTriple) return;
    const refreshBtn = document.querySelector('.refresh-btn');
    if (refreshBtn) {
        refreshBtn.style.opacity = '0.5';
        refreshBtn.style.pointerEvents = 'none';
    }
    await fetchDetails(currentTriple);
    if (refreshBtn) {
        setTimeout(() => {
            refreshBtn.style.opacity = '1';
            refreshBtn.style.pointerEvents = 'auto';
        }, 1000);
    }
}

function getDefaultRouteDisplay(data) {
    return {
        origin: (data.origineEstera && data.origineEstera !== data.destinazione) ? data.origineEstera : data.origine,
        destination: (data.destinazioneEstera && data.destinazioneEstera !== data.origine) ? data.destinazioneEstera : data.destinazione
    };
}

function resolveRouteDisplay(data, timelineStops) {
    const fallback = getDefaultRouteDisplay(data);
    const stops = Array.isArray(timelineStops) ? timelineStops : [];
    const hasSwissData = currentSwissFormationData?.available && stops.some((stop) => stop.source === 'swiss' || stop.swissStop);
    if (!hasSwissData || stops.length < 2) return fallback;

    const displayableStops = stops.filter((stop) => {
        if (!stop?.stazione) return false;
        return !(window.BelloSwiss?.isTechnicalSwissStop && window.BelloSwiss.isTechnicalSwissStop(stop.swissStop || stop));
    });

    const first = displayableStops[0] || stops[0];
    const last = displayableStops[displayableStops.length - 1] || stops[stops.length - 1];

    return {
        origin: first?.stazione || fallback.origin,
        destination: last?.stazione || fallback.destination
    };
}

function resolveDurationDisplay(data, timelineStops) {
    const fallback = formatDuration(data.compDurata);
    const stops = Array.isArray(timelineStops) ? timelineStops : [];
    const hasSwissData = currentSwissFormationData?.available && stops.some((stop) => stop.source === 'swiss' || stop.swissStop);
    if (!hasSwissData || stops.length < 2) return fallback;

    const displayableStops = stops.filter((stop) => {
        if (!stop?.stazione) return false;
        return !(window.BelloSwiss?.isTechnicalSwissStop && window.BelloSwiss.isTechnicalSwissStop(stop.swissStop || stop));
    });

    const first = displayableStops[0];
    const last = displayableStops[displayableStops.length - 1];
    const startMs = Number(first?.partenza_teorica || first?.arrivo_teorico || first?.programmata || 0);
    const endMs = Number(last?.arrivo_teorico || last?.partenza_teorica || last?.programmata || 0);
    const diffMinutes = Math.round((endMs - startMs) / 60000);

    if (!Number.isFinite(diffMinutes) || diffMinutes <= 0 || diffMinutes > 48 * 60) {
        return fallback;
    }

    return formatDurationMinutes(diffMinutes);
}



function render(data) {
    document.getElementById('results').style.display = 'block';
    const card = document.getElementById('trainCard');
    const timeline = document.getElementById('timelineBody');
    const timelineStops = window.BelloSwiss
        ? window.BelloSwiss.mergeTimelineStops(data.fermate || [], currentSwissFormationData)
        : (data.fermate || []);

    if (window.BelloSwiss) {
        if (currentSwissFormationData?.available) {
            window.BelloSwiss.renderFormationCard(currentSwissFormationData);
        } else {
            window.BelloSwiss.hideFormationCard();
        }
    }


    let catCode = (data.categoria || "").trim();


    if (data.compNumeroTreno && data.compNumeroTreno.toUpperCase().includes("EC FR")) {
        catCode = "FR";
    }

    if (!catCode && data.compNumeroTreno) {
        const match = data.compNumeroTreno.match(/([A-Z]+)/);
        if (match) catCode = match[1];
    }


    if (data.compNumeroTreno && data.compNumeroTreno.toUpperCase().includes("TS")) {
        catCode = "TS";
    }

    let operator = CLIENT_MAP[data.codiceCliente] || "Other";
    let operatorLink = CLIENT_LINK_MAP[operator] || "#";


    if (catCode === "TS") {
        operator = "FondazioneFS";
        operatorLink = "https://www.fondazionefs.it";
    }

    const category = CAT_MAP[catCode] || data.categoriaDescrizione || catCode || "Treno";

    const operatorHTML = operatorLink !== "#" ? `<a href="${operatorLink}" target="_blank" style="color: inherit; text-decoration: none;">${operator}</a>` : operator;

    const imageKey = `${data.codiceCliente}-${catCode}`;
    let categoryImage = CAT_IMAGE_MAP[imageKey];


    if (data.codiceCliente === 77) {
        categoryImage = "pic/TTI.png";
    }

    if (operator === "Trenord" && currentSwissFormationData?.available && ['REG', 'RE', 'RV', 'S'].includes(catCode)) {
        categoryImage = "pic/Tilo.png";
    }

    const categoryHTML = categoryImage ? `<img src="${categoryImage}" alt="${category}" style="height: 1.3rem; vertical-align: middle; margin-left: 8px;">` : category;

    const routeDisplay = resolveRouteDisplay(data, timelineStops);
    const displayOrigin = routeDisplay.origin;
    const displayDest = routeDisplay.destination;
    const delayMsg = translateStatus((data.compRitardoAndamento ?? [])[0] ?? '');
    const isEarly = delayMsg.includes(translations[currentLang].early_by) ||
        delayMsg.includes(translations[currentLang].on_time) ||
        delayMsg.toLowerCase().includes("anticipo") ||
        delayMsg.toLowerCase().includes("orario") ||
        delayMsg.toLowerCase().includes("early");

    const formattedDuration = resolveDurationDisplay(data, timelineStops);


    const badgeClass = window.getBadgeClass ? window.getBadgeClass(catCode) : '';

    const trainNumBadge = badgeClass
        ? `<span class="train-badge ${badgeClass}">${data.compNumeroTreno}</span>`
        : `<b>${data.compNumeroTreno}</b>`;

    card.innerHTML = `
        <div class="refresh-btn" onclick="refreshTrainData()" title="${currentLang === 'zh' ? '刷新' : currentLang === 'it' ? 'Aggiorna' : 'Refresh'}">
            <span class="material-symbols-outlined">refresh</span>
        </div>
        <div class="op-cat-row" style="display: flex; align-items: center; gap: 8px;">${operatorHTML} <span class="opacity-50">·</span> ${categoryHTML}</div>
        <div class="train-info-wrapper flex flex-col sm:flex-row items-start gap-3 mt-2">
            <div class="flex-1 min-w-0">
                <div class="train-route mb-2">${escapeHtml(displayOrigin)} <span class="opacity-40 font-normal material-symbols-outlined align-middle mx-1">arrow_forward</span> ${escapeHtml(displayDest)}</div>
                <div class="train-meta flex items-center gap-3 flex-wrap">
                    <span class="flex items-center gap-2 text-sm uppercase tracking-wider font-semibold opacity-80">${translations[currentLang].train_num}: ${trainNumBadge}</span>
                    <span class="opacity-30">|</span>
                    <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[16px] opacity-60">schedule</span> <b>${formattedDuration}</b></span>
                </div>
            </div>
            <div class="train-status-section">
                <div class="train-delay tabular-nums ${isEarly ? '' : 'late'}">${delayMsg}</div>
                <div class="train-last-position flex items-start sm:items-center gap-1 justify-start sm:justify-end">
                    <span class="material-symbols-outlined mt-[2px] sm:mt-0" style="font-size:12px">location_on</span>
                    ${data.stazioneUltimoRilevamento} (${data.compOraUltimoRilevamento || '--:--'})
                </div>
            </div>
        </div>
    `;


    if (data.subTitle && data.subTitle.trim()) {
        const esc = window.escapeHtml || (s => s);
        card.innerHTML += `
            <div class="alert-box">
                <span class="material-symbols-outlined" style="font-size:20px">campaign</span>
                <span>${esc(data.subTitle)}</span>
            </div>
        `;
    }


    timeline.innerHTML = '';

    let lastReachedIdx = -1;

    if (!data.nonPartito) {
        timelineStops.forEach((f, i) => {
            if (f.arrivoReale !== null || f.partenzaReale !== null) lastReachedIdx = i;
        });
    }

    const totalStations = timelineStops.length;
    const timelineFragments = [];

    timelineStops.forEach((f, i) => {
        const isLast = i === totalStations - 1;
        const isFirst = i === 0;
        const isSwissStop = f.source === 'swiss';

        let dotClass = 'dot-future';
        let lineClass = 'line-future';

        if (lastReachedIdx >= 0) {
            if (i < lastReachedIdx) {
                dotClass = 'dot-passed';
                lineClass = 'line-passed';
            } else if (i === lastReachedIdx) {
                dotClass = 'dot-current';
                lineClass = 'line-future';
            }
        }

        const stationItemClasses = ['station-item', dotClass, lineClass];
        if (isSwissStop) stationItemClasses.push('station-source-swiss');

        const pPlat = f.binarioProgrammatoPartenzaDescrizione || f.binarioProgrammatoArrivoDescrizione;
        const ePlat = f.binarioEffettivoPartenzaDescrizione || f.binarioEffettivoArrivoDescrizione;
        let platHTML = `<span class="plat-normal">${ePlat || pPlat || "--"}</span>`;

        const stayMinutes = (f.partenza_teorica && f.arrivo_teorico) ? Math.round((f.partenza_teorica - f.arrivo_teorico) / 60000) : null;
        const stayTime = stayMinutes ? `${stayMinutes} ${translations[currentLang].minutes}` : "N/A";

        let directionBadge = '';
        if (f.orientamento) {
            let directionText = '';
            if (f.orientamento === 'A') {
                directionText = `Executive ${translations[currentLang].in_tail}`;
            } else if (f.orientamento === 'B') {
                directionText = `Executive ${translations[currentLang].in_head}`;
            } else {
                directionText = f.orientamento;
            }
            directionBadge = `<span class="direction-badge">${directionText}</span>`;
        }

        const timeHtmlArr = !isFirst ? renderTimeHtml(translations[currentLang].arrival, (f.arrivo_teorico || f.programmata), f.arrivoReale, f.ritardoArrivo) : '';
        const timeHtmlDep = !isLast ? renderTimeHtml(translations[currentLang].departure, (f.partenza_teorica || f.programmata), f.partenzaReale, f.ritardoPartenza) : '';
        const sourceBadge = isSwissStop
            ? `<span class="source-badge source-badge-swiss">${escapeHtml(translations[currentLang].swiss_source || 'CH')}</span>`
            : '';
        const stationNameHTML = isSwissStop
            ? `<span class="station-name-static">${escapeHtml(f.stazione)}</span>`
            : `<span class="station-link" data-station-id="${f.id}" data-station-name="${escapeHtml(f.stazione)}">${escapeHtml(f.stazione)}</span>`;
        const progressivoHTML = isSwissStop
            ? `<div class="text-[0.65rem] font-mono opacity-40 mt-2" title="opentransportdata.swiss">CH</div>`
            : `<div class="text-[0.65rem] font-mono opacity-30 mt-2" title="Progressivo">P:${f.progressivo || '--'}</div>`;

        timelineFragments.push(`
            <div class="${stationItemClasses.join(' ')} stagger-item animate-fade-in" style="--stagger-idx: ${i}">
                <div class="station-dot-wrapper">
                    <div class="station-dot"></div>
                </div>
                <div class="station-card glass-border shadow-glass hover:bg-base-content/5 transition-colors group">
                    <div class="station-name-col">
                        <div class="station-name group-hover:text-primary transition-colors flex items-center flex-wrap">
                            ${stationNameHTML}
                            ${sourceBadge}
                            ${(!isFirst && !isLast && stayTime !== "N/A") ? `<span class="hidden sm:flex opacity-50 text-[0.85rem] font-medium items-center gap-0.5 ml-2 tracking-normal" style="font-family: var(--font-sans)"><span class="material-symbols-outlined icon-hourglass-desktop">hourglass_empty</span> ${stayTime}</span>` : ''}
                        </div>
                        ${directionBadge ? `<div class="flex items-center gap-2 mt-1 flex-wrap">${directionBadge}</div>` : ''}
                    </div>
                    
                    <div class="station-time-col tabular-nums">
                        ${timeHtmlArr}
                        ${timeHtmlDep}
                    </div>

                    <div class="station-plat-col flex flex-col items-center justify-center">
                        ${(!isFirst && !isLast && stayTime !== "N/A") ? `<div class="flex sm:hidden items-center justify-center gap-0.5 opacity-60 text-[0.8rem] font-medium tracking-normal mb-3" style="font-family: var(--font-sans)"><span class="material-symbols-outlined icon-hourglass-mobile">hourglass_empty</span> ${stayTime}</div>` : ''}
                        <div class="text-[0.8rem] uppercase tracking-wider font-semibold opacity-60 mb-1.5">${translations[currentLang].platform}</div>
                        <div class="text-2xl">${platHTML}</div>
                        ${progressivoHTML}
                    </div>
                </div>
            </div>
        `);
    });
    timeline.innerHTML = timelineFragments.join('');

    window.scrollTo({ top: 0, behavior: 'smooth' });
}


const SC_SKIP_CATS = ['IC', 'ICN', 'EC', 'EN'];
const SC_FULL_CATS = ['FR', 'FA', 'FB'];
const DESC_TO_CAT = {
    'FRECCIAROSSA': 'FR', 'FRECCIARGENTO': 'FA', 'FRECCIABIANCA': 'FB',
    'INTERCITY': 'IC', 'INTERCITY NOTTE': 'ICN',
    'REGIONALE': 'REG', 'REGIONALE VELOCE': 'RV', 'METROPOLITANO': 'MET',
    'EUROCITY': 'EC', 'EURONIGHT': 'EN'
};

function resolveTrainCategory(data) {
    const comp = (data.compNumeroTreno || '').trim().toUpperCase();
    if (comp.includes('EC FR')) return 'FR';
    if (comp.includes('TS')) return 'TS';

    let cat = (data.categoria || '').trim().toUpperCase();
    if (cat) return cat;

    const match = comp.match(/^([A-Z]+(?:\s+[A-Z]+)?)\s/);
    if (match) {
        cat = match[1].trim();
        if (cat) return cat;
    }

    const desc = (data.categoriaDescrizione || '').trim().toUpperCase();
    if (desc && DESC_TO_CAT[desc]) return DESC_TO_CAT[desc];

    return '';
}

async function fetchSmartCaring(trainNumber) {
    const card = document.getElementById('smartCaringCard');
    if (!card || !NOTIFY_BASE) return;

    if (SC_SKIP_CATS.includes(currentTrainCategory)) {
        card.style.display = 'none';
        currentSmartCaringData = null;
        return;
    }

    card.style.display = 'block';
    const t = translations[currentLang];
    card.innerHTML = `<div class="sc-loading"><span class="loading loading-spinner loading-sm text-primary"></span><span>${t.sc_loading}</span></div>`;

    try {
        const res = await fetch(`${NOTIFY_BASE}?train=${trainNumber}`);
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const isFullMode = SC_FULL_CATS.includes(currentTrainCategory);
        const hasNotifications = data.today?.length || data.recent?.length;
        if (data.noData) { card.style.display = 'none'; currentSmartCaringData = null; return; }
        if (isFullMode && !hasNotifications && !data.history?.length) { card.style.display = 'none'; currentSmartCaringData = null; return; }
        if (!isFullMode && !hasNotifications) { card.style.display = 'none'; currentSmartCaringData = null; return; }
        currentSmartCaringData = data;
        renderSmartCaring(data);
    } catch (e) {
        console.error('SmartCaring fetch failed:', e);
        card.style.display = 'none';
        currentSmartCaringData = null;
    }
}

function getShortMonth(date, lang) {
    const m = date.getMonth();
    if (lang === 'zh') return `${m + 1}月`;
    const en = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const it = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
    return lang === 'it' ? it[m] : en[m];
}

function renderSmartCaring(data) {
    const card = document.getElementById('smartCaringCard');
    if (!card || !data) return;

    const t = translations[currentLang];
    const isFullMode = SC_FULL_CATS.includes(currentTrainCategory);

    const hasToday = data.today && data.today.length > 0;
    const hasRecent = data.recent && data.recent.length > 0;
    let notifTitle = hasToday ? t.sc_today : t.sc_recent;
    let notifHTML = '';

    if (hasToday) {
        const notes = data.today.map(n => {
            const time = new Date(n.insertTimestamp).toLocaleTimeString('it-IT', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
            });
            return `<div class="sc-note"><span class="sc-note-time">${time}</span><span class="sc-note-text">${escapeHtml(n.infoNote)}</span></div>`;
        }).join('');
        notifHTML = `<div class="sc-notes-list">${notes}</div>`;
    } else if (hasRecent) {
        const notes = data.recent.map(n => {
            const d = new Date(n.insertTimestamp);
            const monthStr = getShortMonth(d, currentLang);
            const dayNum = d.getDate();
            const dateStr = currentLang === 'zh' ? `${monthStr}${dayNum}号` : `${monthStr} ${dayNum}`;
            const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
            return `<div class="sc-note"><span class="sc-note-date">${dateStr}</span><span class="sc-note-clock">${time}</span><span class="sc-note-text">${escapeHtml(n.infoNote)}</span></div>`;
        }).join('');
        notifHTML = `<div class="sc-notes-list">${notes}</div>`;
    } else {
        notifHTML = `<div class="sc-empty"><span class="material-symbols-outlined" style="font-size:1.1rem;vertical-align:middle;margin-right:4px">check_circle</span>${t.sc_no_today}</div>`;
    }

    let chartSection = '';
    let statsHTML = '';

    if (isFullMode) {
        const now = new Date();
        const days = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const dateKey = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
            const histDay = data.history ? data.history.find(h => h.date === dateKey) : null;
            days.push({
                date: d,
                dateKey,
                delay: histDay ? histDay.maxDelay : 0,
                notifications: histDay ? histDay.notifications : 0,
                reasons: histDay ? histDay.reasons : []
            });
        }

        const maxDelay = Math.max(...days.map(d => d.delay), 1);

        const chartHTML = days.map(d => {
            const barHeight = d.delay > 0 ? Math.max(18, Math.round((d.delay / maxDelay) * 48) + 8) : 6;
            let colorClass = 'sc-level-0';
            if (d.delay > 30) colorClass = 'sc-level-3';
            else if (d.delay > 15) colorClass = 'sc-level-2';
            else if (d.delay > 0) colorClass = 'sc-level-1';

            const dayNum = d.date.getDate();
            const monthAbbr = getShortMonth(d.date, currentLang);
            const tipDelay = d.delay > 0 ? `+${d.delay}min` : 'OK';
            const tipReason = (d.delay > 0 && d.reasons.length) ? d.reasons[0] : '';

            return `<div class="sc-bar-col" data-delay="${tipDelay}" data-reason="${escapeHtml(tipReason)}" onclick="toggleScTooltip(event,this)"><div class="sc-bar ${colorClass}" style="height:${barHeight}px"></div><span class="sc-bar-label">${dayNum}<br><span class="sc-bar-month">${monthAbbr}</span></span></div>`;
        }).join('');

        chartSection = `<div class="sc-history-section"><div class="sc-section-title">${t.sc_history}</div><div class="sc-chart">${chartHTML}</div></div>`;

        const stats = data.stats || {};
        if ((stats.disruptedDays || 0) === 0) {
            statsHTML = `<div class="sc-all-clear"><span class="material-symbols-outlined">verified</span><span>${t.sc_all_clear}</span></div>`;
        } else {
            const rateColor = stats.onTimeRate >= 70 ? 'var(--color-info)' : stats.onTimeRate >= 40 ? 'var(--color-warning)' : 'var(--color-error)';
            statsHTML = `
                <div class="sc-stats-row">
                    <div class="sc-stat"><span class="sc-stat-value" style="color:${rateColor}">${stats.onTimeRate}%</span><span class="sc-stat-label">${t.sc_ontime_rate}</span></div>
                    <div class="sc-stat"><span class="sc-stat-value">${stats.disruptedDays}/${stats.totalDays}</span><span class="sc-stat-label">${t.sc_disrupted}</span></div>
                    <div class="sc-stat"><span class="sc-stat-value">${stats.avgDelay}<small>min</small></span><span class="sc-stat-label">${t.sc_avg_delay}</span></div>
                    <div class="sc-stat"><span class="sc-stat-value">${stats.maxDelay}<small>min</small></span><span class="sc-stat-label">${t.sc_max_delay}</span></div>
                </div>`;
        }
    }

    const wasCollapsed = card.querySelector('.sc-body-wrap') === null
        ? true  // first render: default collapsed
        : card.querySelector('.sc-body-wrap.sc-collapsed') !== null;

    card.innerHTML = `
        <div class="sc-header" onclick="this.nextElementSibling.classList.toggle('sc-collapsed');this.querySelector('.sc-toggle').classList.toggle('sc-rotated');hideScTooltip()">
            <span class="material-symbols-outlined">monitoring</span>
            <span>${t.sc_title}</span>
            <span class="material-symbols-outlined sc-toggle${wasCollapsed ? '' : ' sc-rotated'}">expand_more</span>
        </div>
        <div class="sc-body-wrap${wasCollapsed ? ' sc-collapsed' : ''}">
            <div class="sc-body">
                <div class="sc-today-section"><div class="sc-section-title">${notifTitle}</div>${notifHTML}</div>
                ${chartSection}
                ${statsHTML}
            </div>
        </div>`;
    card.style.display = 'block';
}

function toggleScTooltip(e, col) {
    e.stopPropagation();
    const tooltip = document.getElementById('scTooltip');
    if (!tooltip) return;

    const wasActive = col.classList.contains('sc-active');
    const chart = col.closest('.sc-chart');
    if (!chart) return;
    chart.querySelectorAll('.sc-bar-col').forEach(c => c.classList.remove('sc-active'));
    if (wasActive) { hideScTooltip(); return; }

    col.classList.add('sc-active');

    const delay = col.dataset.delay || 'OK';
    const reason = col.dataset.reason || '';
    tooltip.innerHTML = `<span>${delay}</span>` + (reason ? `<span class="sc-tooltip-reason">${reason}</span>` : '');

    const bar = col.querySelector('.sc-bar');
    const rect = bar.getBoundingClientRect();

    tooltip.classList.add('sc-tooltip-show');

    requestAnimationFrame(() => {
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        let left = rect.left + rect.width / 2 - tw / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
        tooltip.style.left = left + 'px';
        tooltip.style.top = (rect.top - th - 8) + 'px';
    });
}

function hideScTooltip() {
    const tooltip = document.getElementById('scTooltip');
    if (tooltip) tooltip.classList.remove('sc-tooltip-show');
    document.querySelectorAll('.sc-bar-col.sc-active').forEach(c => c.classList.remove('sc-active'));
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.sc-bar-col')) hideScTooltip();
});
window.addEventListener('scroll', hideScTooltip, { passive: true });
window.addEventListener('resize', hideScTooltip);


function initApp() {


    updateSearchLabel();
    loadRecentSearches();
}


document.addEventListener('astro:page-load', () => {
    initApp();
    fetchStatistiche();

    const trainInput = document.getElementById('trainSearch');
    if (trainInput) {
        trainInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const input = e.target.value.trim();
                if (input) startSearch(input);
            }
        });
    }

    if (!window._mainInitialized) {
        window._mainInitialized = true;

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.lang-switch') && !e.target.closest('.theme-switch')) {
                const langMenu = document.getElementById('langMenu');
                const themeMenu = document.getElementById('themeMenu');
                if (langMenu) langMenu.classList.remove('show');
                if (themeMenu) themeMenu.classList.remove('show');
            }
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (currentTheme === 'auto') {
                applyTheme();
            }
        });

        document.addEventListener('click', function (e) {
            const stationLink = e.target.closest('.station-link');
            if (stationLink) {
                const stationId = stationLink.getAttribute('data-station-id');
                const stationName = stationLink.getAttribute('data-station-name');
                if (stationId && stationName) {
                    goToStationBoard(stationId, stationName);
                }
            }
        });
    }
});


// astro:page-load 触发时 DOM 已完整就绪，无需轮询重试
document.addEventListener('astro:page-load', () => {
    const trainParam = new URLSearchParams(window.location.search).get('train');
    if (!trainParam) return;
    const trainNumber = trainParam.trim();
    const trainInput = document.getElementById('trainSearch');
    if (!trainInput) return;
    trainInput.value = trainNumber;
    // 短暂延迟确保 common.js 的 astro:page-load 回调（语言初始化）已先执行
    setTimeout(() => {
        startSearch(trainNumber);
        setTimeout(() => {
            if (window.history && window.history.replaceState) {
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }, 300);
    }, 200);
});
