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
    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
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
        return window.currentLang === 'zh' ? `${hours}小时${mins}分钟` : `${hours}h:${mins}min`;
    }
    return duration;
}


function translateStatus(text) {
    if (!text) return "";

    if (window.currentLang === 'zh') {
        return text
            .replace(/non partito/gi, "未出发")
            .replace(/con un anticipo di/g, "提前")
            .replace(/con un ritardo di/g, "晚点")
            .replace(/in orario/g, "准点")
            .replace(/(\d+)\s*min\./g, "$1分钟");
    } else if (window.currentLang === 'en') {
        return text
            .replace(/non partito/gi, "Not Departed")
            .replace(/con un anticipo di/g, "Early by")
            .replace(/con un ritardo di/g, "Delayed by")
            .replace(/in orario/g, "On Time")
            .replace(/(\d+)\s*min\./g, "$1 min");
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
    if (!real) return `<div class="time-item"><span class="time-label">${label} | ${translations[currentLang].expected}:</span> <b>${sched || '--:--'}</b></div>`;
    const isDiff = sched !== real;
    const colorClass = (delayMin > 0) ? "late" : "early";
    return `
        <div class="time-item">
            <span class="time-label">${label} |</span> 
            ${isDiff ? `<span class="time-val-sched">${sched}</span>` : ''}
            <span class="time-val-real ${colorClass}">${real}</span>
        </div>
    `;
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
            <div style="font-size:1.1rem; font-weight:bold; color:var(--md-sys-color-primary)">${label}</div>
            <div style="font-size:0.9rem; color:var(--text-grey); margin-top:4px">
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
                <span class="material-symbols-outlined" style="font-size:24px; color:var(--md-sys-color-primary)">location_on</span>
                <div>
                    <div style="font-size:1.1rem; font-weight:bold; color:var(--md-sys-color-primary)">${station.nomeLungo}</div>
                    <div style="font-size:0.9rem; color:var(--text-grey); margin-top:2px">ID: ${station.id}</div>
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
    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
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
        render(data);
        currentTrainCategory = resolveTrainCategory(data);
        fetchSmartCaring(data.numeroTreno);


        const trainNumber = `${data.compCategoria || ''} ${data.numeroTreno || tNum}`.trim();
        saveRecentSearch(trainNumber, data);
    } catch (err) {
        const msg = currentLang === 'zh' ? "详情加载失败" :
            currentLang === 'it' ? "Impossibile caricare i dettagli" :
                "Failed to load details";
        alert(msg);
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



function render(data) {
    document.getElementById('results').style.display = 'block';
    const card = document.getElementById('trainCard');
    const timeline = document.getElementById('timelineBody');


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

    const categoryHTML = categoryImage ? `<img src="${categoryImage}" alt="${category}" style="height: 1.3rem; vertical-align: middle; margin-left: 8px;">` : category;

    const displayOrigin = (data.origineEstera && data.origineEstera !== data.destinazione) ? data.origineEstera : data.origine;
    const displayDest = (data.destinazioneEstera && data.destinazioneEstera !== data.origine) ? data.destinazioneEstera : data.destinazione;
    const delayMsg = translateStatus(data.compRitardoAndamento[0]);
    const isEarly = delayMsg.includes(translations[currentLang].early_by) ||
        delayMsg.includes(translations[currentLang].on_time) ||
        delayMsg.toLowerCase().includes("anticipo") ||
        delayMsg.toLowerCase().includes("orario") ||
        delayMsg.toLowerCase().includes("early");

    const formattedDuration = formatDuration(data.compDurata);


    let badgeClass = '';
    if (['REG', 'RE', 'RV', 'MET'].includes(catCode)) {
        badgeClass = 'badge-regional';
    } else if (['FR', 'FB', 'FA'].includes(catCode)) {
        badgeClass = 'badge-arrow';
    } else if (['IC', 'ICN'].includes(catCode)) {
        badgeClass = 'badge-intercity';
    } else if (['EC', 'EN'].includes(catCode)) {
        badgeClass = 'badge-international';
    } else if (catCode === 'TS') {
        badgeClass = 'badge-storico';
    } else if (catCode === 'EXP') {
        badgeClass = 'badge-espresso';
    }

    const trainNumBadge = badgeClass
        ? `<span class="train-badge ${badgeClass}">${data.compNumeroTreno}</span>`
        : `<b>${data.compNumeroTreno}</b>`;

    card.innerHTML = `
        <div class="refresh-btn ripple" onclick="refreshTrainData()" title="${currentLang === 'zh' ? '刷新' : currentLang === 'it' ? 'Aggiorna' : 'Refresh'}">
            <span class="material-symbols-outlined">refresh</span>
        </div>
        <div class="op-cat-row" style="display: flex; align-items: center;">${operatorHTML} · ${categoryHTML}</div>
        <div class="train-info-wrapper">
            <div>
                <div class="train-route">${displayOrigin} ➜ ${displayDest}</div>
                <div class="train-meta">
                    ${translations[currentLang].train_num}: ${trainNumBadge} | ${translations[currentLang].duration}: <b>${formattedDuration}</b>
                </div>
            </div>
            <div class="train-status-section">
                <div class="train-delay ${isEarly ? '' : 'late'}">${delayMsg}</div>
                <div class="train-last-position">${translations[currentLang].last_position}: ${data.stazioneUltimoRilevamento} (${data.compOraUltimoRilevamento || '--:--'})</div>
            </div>
        </div>
    `;


    if (data.subTitle && data.subTitle.trim()) {
        card.innerHTML += `
            <div class="alert-box">
                <span class="material-symbols-outlined" style="font-size:20px">campaign</span>
                <span>${data.subTitle}</span>
            </div>
        `;
    }


    timeline.innerHTML = '';

    let lastReachedIdx = -1;

    if (!data.nonPartito) {
        data.fermate.forEach((f, i) => {
            if (f.arrivoReale !== null || f.partenzaReale !== null) lastReachedIdx = i;
        });
    }

    const totalStations = data.fermate.length;
    const timelineFragments = [];

    data.fermate.forEach((f, i) => {
        const isLast = i === totalStations - 1;
        const isFirst = i === 0;

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

        const pPlat = f.binarioProgrammatoPartenzaDescrizione || f.binarioProgrammatoArrivoDescrizione;
        const ePlat = f.binarioEffettivoPartenzaDescrizione || f.binarioEffettivoArrivoDescrizione;
        let platHTML = (ePlat && pPlat && ePlat !== pPlat)
            ? `<span class="plat-old">${pPlat}</span><span class="plat-new">${ePlat}</span>`
            : `<span class="plat-normal">${pPlat || "--"}</span>`;

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

        timelineFragments.push(`
            <div class="${stationItemClasses.join(' ')}">
                <div class="station-dot-wrapper">
                    <div class="station-dot"></div>
                </div>
                <div class="station-card">
                    <div class="station-name">
                        <span class="station-link" data-station-id="${f.id}" data-station-name="${f.stazione.replace(/"/g, '&quot;')}">${f.stazione}</span>
                        ${directionBadge}
                    </div>
                    <div class="info-row">
                        ${!isFirst ? renderTimeHtml(translations[currentLang].arrival, (f.arrivo_teorico || f.programmata), f.arrivoReale, f.ritardoArrivo) : ''}
                        ${!isLast ? renderTimeHtml(translations[currentLang].departure, (f.partenza_teorica || f.programmata), f.partenzaReale, f.ritardoPartenza) : ''}
                        ${(!isFirst && !isLast) ? `<div class="time-item"><span class="time-label">${translations[currentLang].stop_duration}:</span> <b>${stayTime}</b></div>` : ''}
                    </div>
                    <div class="info-row secondary">
                        <div class="time-item"><span class="time-label">${translations[currentLang].platform}:</span> ${platHTML}</div>
                        <div class="time-item" style="opacity:0.5"><span class="time-label">Progressivo:</span> <b>${f.progressivo}</b></div>
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
    let cat = (data.categoria || '').trim().toUpperCase();
    if (cat) return cat;

    const comp = (data.compNumeroTreno || '').trim().toUpperCase();
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
            return `<div class="sc-note"><span class="sc-note-time">${time}</span><span class="sc-note-text">${n.infoNote}</span></div>`;
        }).join('');
        notifHTML = `<div class="sc-notes-list">${notes}</div>`;
    } else if (hasRecent) {
        const notes = data.recent.map(n => {
            const d = new Date(n.insertTimestamp);
            const monthStr = getShortMonth(d, currentLang);
            const dayNum = d.getDate();
            const dateStr = currentLang === 'zh' ? `${monthStr}${dayNum}号` : `${monthStr} ${dayNum}`;
            const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
            return `<div class="sc-note"><span class="sc-note-date">${dateStr}</span><span class="sc-note-clock">${time}</span><span class="sc-note-text">${n.infoNote}</span></div>`;
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

            return `<div class="sc-bar-col" data-delay="${tipDelay}" data-reason="${tipReason}" onclick="toggleScTooltip(event,this)"><div class="sc-bar ${colorClass}" style="height:${barHeight}px"></div><span class="sc-bar-label">${dayNum}<br><span class="sc-bar-month">${monthAbbr}</span></span></div>`;
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

    const wasCollapsed = card.querySelector('.sc-body-wrap.sc-collapsed') !== null;

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


document.addEventListener('DOMContentLoaded', () => {
    initApp();
    fetchStatistiche();


    document.getElementById('trainSearch').addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const input = e.target.value.trim();
            if (input) startSearch(input);
        }
    });


    document.addEventListener('click', (e) => {
        if (!e.target.closest('.lang-switch') && !e.target.closest('.theme-switch')) {
            document.getElementById('langMenu').classList.remove('show');
            document.getElementById('themeMenu').classList.remove('show');
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
});


let urlSearchRetryCount = 0;
const maxRetries = 10;

function checkAndSearchFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    const trainParam = urlParams.get('train');

    if (trainParam) {
        const trainNumber = trainParam.trim();

        const trainInput = document.getElementById('trainSearch');
        if (!trainInput) {
            urlSearchRetryCount++;
            if (urlSearchRetryCount < maxRetries) {
                console.warn(`trainSearch 元素未找到，延迟重试... (${urlSearchRetryCount}/${maxRetries})`);
                setTimeout(checkAndSearchFromURL, 100);
            } else {
                console.error('trainSearch 元素未找到，已达到最大重试次数');
            }
            return;
        }

        trainInput.value = trainNumber;

        setTimeout(function () {
            startSearch(trainNumber);

            setTimeout(function () {
                if (window.history && window.history.replaceState) {
                    window.history.replaceState({}, document.title, window.location.pathname);
                }
            }, 300);
        }, 200);
    }
}

document.addEventListener('DOMContentLoaded', checkAndSearchFromURL);
