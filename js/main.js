/**
 * BelloTreno 主应用逻辑
 * 包含所有核心功能和事件处理
 */

// 全局状态变量
let currentTrainData = null;
let currentTriple = null;
let searchMode = 'train'; // 'train' 或 'station'
let disambiguationData = null; // 存储歧义数据以便语言切换时重新渲染

// API_BASE 已在 config.js 中定义，这里直接引用
const API_BASE = window.API_BASE;

// ========== 搜索模式管理 ==========

// 更新搜索框 label
function updateSearchLabel() {
    const trainSearch = document.getElementById('trainSearch');
    if (!trainSearch) return;

    if (searchMode === 'train') {
        trainSearch.label = translations[window.currentLang].search_label_train;
        trainSearch.querySelector('md-icon').textContent = 'train';
    } else {
        trainSearch.label = translations[window.currentLang].search_label_station;
        trainSearch.querySelector('md-icon').textContent = 'location_on';
    }
}

// 切换搜索模式（车次/车站）
function switchSearchMode(mode) {
    searchMode = mode;

    // 更新按钮激活状态
    const trainBtn = document.getElementById('modeTrainBtn');
    const stationBtn = document.getElementById('modeStationBtn');

    if (trainBtn && stationBtn) {
        if (mode === 'train') {
            trainBtn.classList.add('active');
            stationBtn.classList.remove('active');
        } else {
            trainBtn.classList.remove('active');
            stationBtn.classList.add('active');
        }
    }

    // 更新搜索框 label 和图标
    updateSearchLabel();

    // 清空输入框
    const trainSearch = document.getElementById('trainSearch');
    if (trainSearch) trainSearch.value = '';

    // 隐藏结果
    const results = document.getElementById('results');
    const disambiguation = document.getElementById('disambiguation');
    if (results) results.style.display = 'none';
    if (disambiguation) disambiguation.style.display = 'none';
}

// ========== 语言 & 主题钩子 ==========

window.onLanguageChanged = function () {
    // 更新搜索框label（根据当前搜索模式）
    updateSearchLabel();

    // 如果有歧义面板显示，重新渲染
    if (disambiguationData) {
        renderDisambiguation();
    }

    // 如果有车次信息显示，重新渲染
    if (currentTrainData) {
        render(currentTrainData);
    }
};

// 重定向函数 (首页特有)
function goHome() {
    window.location.href = 'index.html';
}

// ========== 工具函数 ==========

// 格式化时长
function formatDuration(duration) {
    if (!duration) return 'N/A';
    const parts = duration.split(':');
    if (parts.length === 2) {
        const hours = parseInt(parts[0]);
        const mins = parseInt(parts[1]);
        if (window.currentLang === 'zh') {
            return `${hours}小时${mins}分钟`;
        } else if (window.currentLang === 'it') {
            return `${hours}h:${mins}min`;
        } else {
            return `${hours}h:${mins}min`;
        }
    }
    return duration;
}

// 翻译状态
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

    // 意大利语保持原文
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

// ========== 最近搜索记录功能 ==========

// 保存车次搜索记录
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

// 保存车站搜索记录
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

// 加载并渲染最近搜索记录
function loadRecentSearches() {
    try {
        // 迁移旧数据格式到新格式
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

// 渲染最近搜索chips
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

            // 根据类型选择图标
            const icon = item.type === 'station' ? 'location_on' : 'train';

            chip.innerHTML = `
                <span class="material-symbols-outlined chip-icon">${icon}</span>
                <span class="chip-label">${item.name}</span>
                <span class="chip-remove" onclick="removeRecentSearch('${item.id}', '${item.type}', event)">
                    <span class="material-symbols-outlined">close</span>
                </span>
            `;

            // 点击chip主体时触发搜索
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

// 删除单个最近搜索记录
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

// ========== 搜索功能 ==========

async function startSearch(input) {
    document.getElementById('results').style.display = 'none';
    document.getElementById('disambiguation').style.display = 'none';

    if (searchMode === 'train') {
        // ========== 车次搜索模式 ==========
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
        // ========== 车站搜索模式 ==========
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

// ========== 歧义消除功能 ==========

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

// 车站搜索 - 歧义消除面板
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

// ========== 车次详情功能 ==========

async function fetchDetails(triple) {
    currentTriple = triple;
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

        // 保存到最近搜索记录
        const trainNumber = `${data.compCategoria || ''} ${data.numeroTreno || tNum}`.trim();
        saveRecentSearch(trainNumber, data);
    } catch (err) {
        const msg = currentLang === 'zh' ? "详情加载失败" :
            currentLang === 'it' ? "Impossibile caricare i dettagli" :
                "Failed to load details";
        alert(msg);
    }
}

// 刷新车次信息
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

// ========== 渲染车次信息 ==========

function render(data) {
    document.getElementById('results').style.display = 'block';
    const card = document.getElementById('trainCard');
    const timeline = document.getElementById('timelineBody');

    // 识别车次类型
    let catCode = (data.categoria || "").trim();

    // 优先判定：EC FR 跨境红箭强制识别为 FR
    if (data.compNumeroTreno && data.compNumeroTreno.toUpperCase().includes("EC FR")) {
        catCode = "FR";
    }

    if (!catCode && data.compNumeroTreno) {
        const match = data.compNumeroTreno.match(/([A-Z]+)/);
        if (match) catCode = match[1];
    }

    // 特殊处理：如果车次号包含 TS，识别为 TS (Treno Storico)
    if (data.compNumeroTreno && data.compNumeroTreno.toUpperCase().includes("TS")) {
        catCode = "TS";
    }

    if (catCode === "TS") {
        catCode = "TS"; // Ensure it's set
    }

    let operator = CLIENT_MAP[data.codiceCliente] || "Other";
    let operatorLink = CLIENT_LINK_MAP[operator] || "#";

    // 特殊处理：如果是历史列车，更换运营商信息
    if (catCode === "TS") {
        operator = "FondazioneFS";
        operatorLink = "https://www.fondazionefs.it";
    }

    const category = CAT_MAP[catCode] || data.categoriaDescrizione || catCode || "Treno";

    const operatorHTML = operatorLink !== "#" ? `<a href="${operatorLink}" target="_blank" style="color: inherit; text-decoration: none;">${operator}</a>` : operator;

    const imageKey = `${data.codiceCliente}-${catCode}`;
    let categoryImage = CAT_IMAGE_MAP[imageKey];

    // 特殊处理：FS Treni Turistici Italiani (77) 始终使用 TTI.png
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

    // 计算车次号徽章类
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

    // 渲染实时公告
    if (data.subTitle && data.subTitle.trim()) {
        card.innerHTML += `
            <div class="alert-box">
                <span class="material-symbols-outlined" style="font-size:20px">campaign</span>
                <span>${data.subTitle}</span>
            </div>
        `;
    }

    // Timeline 渲染
    timeline.innerHTML = '';

    let lastReachedIdx = -1;
    if (!data.nonPartito) {
        data.fermate.forEach((f, i) => {
            if (f.arrivoReale !== null || f.partenzaReale !== null) lastReachedIdx = i;
        });
    }

    const totalStations = data.fermate.length;

    data.fermate.forEach((f, i) => {
        const isLast = i === totalStations - 1;
        const isFirst = i === 0;

        // 圆点状态
        let dotClass = 'dot-future';
        if (lastReachedIdx >= 0) {
            if (i < lastReachedIdx) {
                dotClass = 'dot-passed';
            } else if (i === lastReachedIdx) {
                dotClass = 'dot-current';
            }
        }

        // 轨道段状态
        const isSegmentActive = (i < lastReachedIdx);
        const segmentClass = isSegmentActive ? 'segment-line segment-active' : 'segment-line';

        const stationItemClasses = ['station-item', dotClass];

        const pPlat = f.binarioProgrammatoPartenzaDescrizione || f.binarioProgrammatoArrivoDescrizione;
        const ePlat = f.binarioEffettivoPartenzaDescrizione || f.binarioEffettivoArrivoDescrizione;
        let platHTML = (ePlat && pPlat && ePlat !== pPlat)
            ? `<span class="plat-old">${pPlat}</span><span class="plat-new">${ePlat}</span>`
            : `<span class="plat-normal">${pPlat || "--"}</span>`;

        const stayMinutes = (f.partenza_teorica && f.arrivo_teorico) ? Math.round((f.partenza_teorica - f.arrivo_teorico) / 60000) : null;
        const stayTime = stayMinutes ? `${stayMinutes} ${translations[currentLang].minutes}` : "N/A";

        // 方向信息
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

        const stationHTML = `
            <div class="${stationItemClasses.join(' ')}">
                <div class="station-dot-wrapper">
                    <div class="station-dot"></div>
                    <div class="${segmentClass}"></div>
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
                        <div class="time-item"><span class="time-label">Progressivo:</span> <b>${f.progressivo}</b></div>
                    </div>
                </div>
            </div>
        `;
        timeline.innerHTML += stationHTML;
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========== 页面初始化 ==========

// 初始化应用
function initApp() {
    initLanguage();
    initTheme();
    updateSearchLabel();
    loadRecentSearches();
}

// DOMContentLoaded 事件
document.addEventListener('DOMContentLoaded', () => {
    initApp();

    // 搜索框回车事件
    document.getElementById('trainSearch').addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            const input = e.target.value.trim();
            if (input) startSearch(input);
        }
    });

    // 点击外部关闭下拉菜单
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.lang-switch') && !e.target.closest('.theme-switch')) {
            document.getElementById('langMenu').classList.remove('show');
            document.getElementById('themeMenu').classList.remove('show');
        }
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (currentTheme === 'auto') {
            applyTheme();
        }
    });

    // 显示/隐藏回到顶部按钮
    window.addEventListener('scroll', () => {
        const backToTop = document.querySelector('.back-to-top');
        if (window.scrollY > 300) {
            backToTop.classList.add('show');
        } else {
            backToTop.classList.remove('show');
        }
    });

    // 为站名链接添加事件监听器（事件代理）
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

// URL 参数自动搜索
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

window.addEventListener('load', checkAndSearchFromURL);
