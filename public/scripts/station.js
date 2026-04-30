
// BelloTreno © 2026


function getItalianTimeString() {
    const now = new Date();

    const italianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));

    const offsetParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Rome', timeZoneName: 'shortOffset'
    }).formatToParts(now);
    const tzPart = offsetParts.find(p => p.type === 'timeZoneName');
    let timezone = 'GMT+0100';
    if (tzPart) {
        const m = tzPart.value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
        if (m) {
            const sign = m[1];
            const hrs = m[2].padStart(2, '0');
            const mins = m[3] || '00';
            timezone = `GMT${sign}${hrs}${mins}`;
        }
    }

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const weekday = weekdays[italianTime.getDay()];
    const monthName = months[italianTime.getMonth()];
    const day = String(italianTime.getDate()).padStart(2, '0');
    const yearStr = italianTime.getFullYear();
    const hour = String(italianTime.getHours()).padStart(2, '0');
    const minute = String(italianTime.getMinutes()).padStart(2, '0');
    const second = String(italianTime.getSeconds()).padStart(2, '0');

    return `${weekday} ${monthName} ${day} ${yearStr} ${hour}:${minute}:${second} ${timezone}`;
}


function goToStationBoard(stationId, stationName) {
    
    const params = new URLSearchParams({
        id: stationId,
        name: stationName,
        type: 'partenze' 
    });
    window.location.href = `/station?${params.toString()}`;
}


async function fetchStationBoard(stationId, type = 'partenze') {
    const timeString = getItalianTimeString();
    const encodedTime = encodeURIComponent(timeString);
    
    const apiBase = window.API_BASE;
    const url = `${apiBase}/${type}/${stationId}/${encodedTime}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Failed to fetch station board:', error);
        throw error;
    }
}

const OPERATOR_MAP = window.CLIENT_MAP || {};


function formatTrainNumber(trainNumberStr) {
    if (!trainNumberStr) return '';

    trainNumberStr = trainNumberStr.trim();

    const match = trainNumberStr.match(/^([A-Z\s]+?)\s*(\d+)$/);
    if (match) {
        let catCode = match[1].trim();
        const num = match[2];

        if (catCode.toUpperCase().includes("EC FR")) {
            catCode = "FR";
        }

        if (catCode.toUpperCase().includes("TS")) {
            catCode = "TS";
        }

        const badgeClass = window.getBadgeClass ? window.getBadgeClass(catCode) : '';

        if (badgeClass) {
            // Uniform fixed-width badge: category row + number row
            return `<span class="train-badge station-badge ${badgeClass}"><span class="badge-cat">${catCode}</span><span class="badge-num">${num}</span></span>`;
        }
        return `<span style="font-size:0.8rem;font-weight:700;opacity:0.7">${catCode}</span><br>${num}`;
    }

    return trainNumberStr;
}


const STATION_TRANSLATIONS = {
    zh: { cancelled: '已取消', not_departed: '未出发', delayed: '晚点', early: '提前', on_time: '准点', minutes: '分钟' },
    en: { cancelled: 'CANCELLED', not_departed: 'Not Departed', delayed: 'Delayed', early: 'Early', on_time: 'On Time', minutes: 'min' },
    it: { cancelled: 'CANCELLATO', not_departed: 'Non partito', delayed: 'Ritardo', early: 'In anticipo', on_time: 'In orario', minutes: 'min' }
};

function formatDepartureData(train, currentLang = 'zh', currentStation = '') {
    const t = STATION_TRANSLATIONS[currentLang] || STATION_TRANSLATIONS.zh;

    
    const scheduledTime = train.compOrarioPartenza || '--:--';

    const trainNumber = formatTrainNumber(train.compNumeroTreno || '');

    
    const destination = (train.destinazioneEstera &&
        train.destinazioneEstera !== train.origine &&
        train.destinazioneEstera.toUpperCase() !== currentStation.toUpperCase())
        ? train.destinazioneEstera : (train.destinazione || '');

    
    let status = '';
    let statusColor = 'green';

    if (train.provvedimento == 1) {
        status = t.cancelled;
        statusColor = 'red';
    } else if (train.nonPartito === true) {
        status = t.not_departed;
        statusColor = 'grey';
    } else if (train.ritardo > 0) {
        status = `${t.delayed} ${train.ritardo} ${t.minutes}`;
        statusColor = 'red';
    } else {
        status = t.on_time;
        statusColor = 'green';
    }

    
    const actualPlatform = train.binarioEffettivoPartenzaDescrizione || '';
    const scheduledPlatform = train.binarioProgrammatoPartenzaDescrizione || '';
    const inStazione = train.inStazione === true;
    let platformHtml = '';

    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span style="color:red; font-weight:bold;"${pulseClass}>${actualPlatform}</span> <del style="color:grey;">${scheduledPlatform}</del>`;
    } else if (actualPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${actualPlatform}</span>`;
    } else if (scheduledPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${scheduledPlatform}</span>`;
    } else {
        platformHtml = '--';
    }

    return {
        scheduledTime,
        trainNumber,
        destination,
        status,
        statusColor,
        platformHtml,
        inStazione,
        rawData: train
    };
}


function formatArrivalData(train, currentLang = 'zh', currentStation = '') {
    const t = STATION_TRANSLATIONS[currentLang] || STATION_TRANSLATIONS.zh;

    
    const scheduledTime = train.compOrarioArrivo || '--:--';

    
    const origin = (train.origineEstera &&
        train.origineEstera !== train.destinazione &&
        train.origineEstera.toUpperCase() !== currentStation.toUpperCase())
        ? train.origineEstera : (train.origine || '');

    
    const trainNumber = formatTrainNumber(train.compNumeroTreno || '');

    
    let actualTime = scheduledTime;
    if (train.compOrarioEffettivoArrivo) {
        
        const match = train.compOrarioEffettivoArrivo.match(/(\d{2}:\d{2})$/);
        if (match) {
            actualTime = match[1];
        }
    }

    
    let status = '';
    let statusColor = 'green';

    if (train.provvedimento == 1) {
        status = t.cancelled;
        statusColor = 'red';
    } else if (train.ritardo > 0) {
        status = `${t.delayed} ${train.ritardo} ${t.minutes}`;
        statusColor = 'red';
    } else if (train.ritardo < 0) {
        status = `${t.early} ${Math.abs(train.ritardo)} ${t.minutes}`;
        statusColor = 'green';
    } else {
        status = t.on_time;
        statusColor = 'green';
    }

    
    const actualPlatform = train.binarioEffettivoArrivoDescrizione || '';
    const scheduledPlatform = train.binarioProgrammatoArrivoDescrizione || '';
    const inStazione = train.inStazione === true;
    let platformHtml = '';

    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span style="color:red; font-weight:bold;"${pulseClass}>${actualPlatform}</span> <del style="color:grey;">${scheduledPlatform}</del>`;
    } else if (actualPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${actualPlatform}</span>`;
    } else if (scheduledPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${scheduledPlatform}</span>`;
    } else {
        platformHtml = '--';
    }

    return {
        scheduledTime,
        origin,
        trainNumber,
        actualTime,
        status,
        statusColor,
        platformHtml,
        inStazione,
        rawData: train
    };
}


if (typeof module !== 'undefined' && module.exports) {
    
    module.exports = {
        getItalianTimeString,
        goToStationBoard,
        fetchStationBoard,
        formatDepartureData,
        formatArrivalData
    };
} else {
    
    window.getItalianTimeString = getItalianTimeString;
    window.goToStationBoard = goToStationBoard;
    window.fetchStationBoard = fetchStationBoard;
    window.formatDepartureData = formatDepartureData;
    window.formatArrivalData = formatArrivalData;
}
// =============================================================
// Station Board Page Logic
// Moved from station.astro inline script for maintainability.
// Only activates when #boardContent is present (station page).
// =============================================================

let _stId = '';
let _stName = '';
let _stBoardType = 'partenze';
let _stBoardSeq = 0;
const ST_SWISS_MAX_LOOKUPS = 10;

/** Called from onclick attributes in station.astro HTML */
window.switchBoardType = function (type) {
    _stBoardType = type;
    document.getElementById('btnPartenze').classList.toggle('active', type === 'partenze');
    document.getElementById('btnArrivi').classList.toggle('active', type === 'arrivi');
    _stLoadBoard();
};

async function _stLoadBoard() {
    const loadingEl = document.getElementById('loadingIndicator');
    const errorEl   = document.getElementById('errorMessage');
    const contentEl = document.getElementById('boardContent');
    if (!loadingEl || !errorEl || !contentEl) return;

    loadingEl.style.display = 'block';
    errorEl.style.display   = 'none';
    contentEl.style.display = 'none';
    const boardSeq = ++_stBoardSeq;

    try {
        const data = await fetchStationBoard(_stId, _stBoardType);

        if (!data || data.length === 0) {
            const t = (typeof translations !== 'undefined' && translations[window.currentLang]) || {};
            errorEl.querySelector('span').textContent = 'info';
            errorEl.querySelector('p').textContent    = t.no_trains || 'No trains at this time';
            errorEl.style.display   = 'block';
            loadingEl.style.display = 'none';
            return;
        }

        _stRenderBoard(data);
        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';
        _stEnhanceBoardWithSwiss(data, boardSeq);
    } catch (error) {
        console.error('Failed to load station board:', error);
        errorEl.style.display   = 'block';
        loadingEl.style.display = 'none';
    }
}

function _stEsc(value) {
    return window.escapeHtml ? window.escapeHtml(value) : String(value ?? '');
}

function _stTrainNumber(train) {
    if (window.BelloSwiss?.getTrainNumber) return window.BelloSwiss.getTrainNumber(train);
    return String(train?.numeroTreno || train?.compNumeroTreno || '').replace(/\D+/g, '');
}

function _stOperationDate(train) {
    return window.BelloSwiss?.getOperationDate?.(train)
        || window.BelloSwiss?.getTodayInZurich?.()
        || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
}

function _stVisibleRouteName(train) {
    if (_stBoardType === 'partenze') {
        return (train.destinazioneEstera &&
            train.destinazioneEstera !== train.origine &&
            train.destinazioneEstera.toUpperCase() !== _stName.toUpperCase())
            ? train.destinazioneEstera : (train.destinazione || '');
    }

    return (train.origineEstera &&
        train.origineEstera !== train.destinazione &&
        train.origineEstera.toUpperCase() !== _stName.toUpperCase())
        ? train.origineEstera : (train.origine || '');
}

function _stShouldTrySwiss(train) {
    if (!window.BelloSwiss) return false;
    const visibleRoute = _stVisibleRouteName(train);
    const category = window.BelloSwiss.getCategory ? window.BelloSwiss.getCategory(train) : '';

    if (window.BelloSwiss.isSwissBoundaryName?.(visibleRoute)) return true;
    if (['EC', 'EN'].includes(category)) return true;
    if (['REG', 'RE', 'RV', 'S', 'IR'].includes(category) && window.BelloSwiss.hasSwissHint?.(train)) return true;
    return false;
}

function _stSwissTerminalName(swissData) {
    const stops = Array.isArray(swissData?.stops) ? swissData.stops : [];
    if (!stops.length) return '';
    const terminal = _stBoardType === 'partenze' ? stops[stops.length - 1] : stops[0];
    return terminal?.name || '';
}

function _stShouldReplaceRouteName(currentName, swissName) {
    if (!swissName || !window.BelloSwiss) return false;
    const currentKey = currentName ? window.BelloSwiss.normalizeStationName(currentName) : '';
    const swissKey = window.BelloSwiss.normalizeStationName(swissName);
    const stationKey = window.BelloSwiss.normalizeStationName(_stName);
    if (!swissKey || swissKey === currentKey || swissKey === stationKey) return false;

    if (!currentKey) return true;
    return Boolean(window.BelloSwiss.isSwissBoundaryName?.(currentName));
}

async function _stEnhanceBoardWithSwiss(trains, boardSeq) {
    if (!window.BelloSwiss || !Array.isArray(trains) || !trains.length) return;

    const candidates = trains
        .map((train, index) => ({ train, index }))
        .filter(({ train }) => _stShouldTrySwiss(train))
        .slice(0, ST_SWISS_MAX_LOOKUPS);

    for (const { train, index } of candidates) {
        if (boardSeq !== _stBoardSeq) return;

        const trainNumber = _stTrainNumber(train);
        const operationDate = _stOperationDate(train);
        if (!trainNumber || !operationDate) continue;

        const swissData = await window.BelloSwiss.fetchSwissByTrainNumber(trainNumber, operationDate);
        if (boardSeq !== _stBoardSeq) return;
        if (!swissData?.available) continue;

        const currentName = _stVisibleRouteName(train);
        const swissName = _stSwissTerminalName(swissData);
        if (!_stShouldReplaceRouteName(currentName, swissName)) continue;

        const cell = document.querySelector(`[data-route-cell="${index}"]`);
        if (!cell) continue;

        const sourceText = translations[window.currentLang]?.swiss_source || 'CH';
        cell.classList.add('station-route-swiss');
        cell.innerHTML = `
            <span>${_stEsc(swissName)}</span>
            <span class="source-badge source-badge-swiss station-source-badge">
                ${_stEsc(sourceText)}
            </span>
        `;
    }
}

function _stRenderBoard(trains) {
    const contentEl = document.getElementById('boardContent');
    const t = translations[window.currentLang];

    let tableHtml = '<div class="overflow-x-auto bg-base-100/65 backdrop-blur-3xl rounded-2xl shadow-glass border border-base-content/10"><table class="table table-zebra table-sm sm:table-md w-full">';

    if (_stBoardType === 'partenze') {
        tableHtml += `
                <thead class="bg-primary text-primary-content border-none">
                    <tr>
                        <th style="width:16%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.scheduled_time}</th>
                        <th style="width:14%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.train}</th>
                        <th style="width:32%" class="py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.destination}</th>
                        <th style="width:22%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.status}</th>
                        <th style="width:16%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm">${t.platform}</th>
                    </tr>
                </thead>
                <tbody>`;

        trains.forEach((train, index) => {
            const formatted = formatDepartureData(train, window.currentLang, _stName);
            const trainNumber = train.numeroTreno || '';
            tableHtml += `
                    <tr class="train-row hover cursor-pointer transition-colors border-b border-base-200 last:border-0" data-train-number="${trainNumber}">
                        <td class="text-center font-mono font-bold text-sm sm:text-xl align-middle whitespace-nowrap px-1 sm:px-4">${formatted.scheduledTime}</td>
                        <td class="text-center font-medium text-[0.65rem] sm:text-sm align-middle whitespace-normal px-1 sm:px-4">${formatted.trainNumber}</td>
                        <td data-route-cell="${index}" class="text-[0.65rem] sm:text-sm align-middle whitespace-normal leading-tight px-1 sm:px-4" style="font-family: 'Outfit', 'Noto Sans SC', sans-serif; font-weight: 700; letter-spacing: 0.01em;">${formatted.destination}</td>
                        <td class="text-center font-medium text-[0.65rem] sm:text-sm align-middle px-1 sm:px-4 leading-tight" style="color:${formatted.statusColor}">${formatted.status}</td>
                        <td class="text-center font-mono font-bold text-sm sm:text-lg align-middle px-1 sm:px-4">${formatted.platformHtml}</td>
                    </tr>`;
        });
    } else {
        tableHtml += `
                <thead class="bg-primary text-primary-content border-none">
                    <tr>
                        <th style="width:13%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.scheduled_time}</th>
                        <th style="width:12%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.train}</th>
                        <th style="width:22%" class="py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.origin}</th>
                        <th style="width:15%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.actual_time}</th>
                        <th style="width:22%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm border-r border-primary-content/20">${t.status}</th>
                        <th style="width:16%" class="text-center py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm">${t.platform}</th>
                    </tr>
                </thead>
                <tbody>`;

        trains.forEach((train, index) => {
            const formatted = formatArrivalData(train, window.currentLang, _stName);
            const trainNumber = train.numeroTreno || '';
            tableHtml += `
                    <tr class="train-row hover cursor-pointer transition-colors border-b border-base-200 last:border-0" data-train-number="${trainNumber}">
                        <td class="text-center font-mono font-bold text-sm sm:text-xl align-middle whitespace-nowrap px-1 sm:px-4">${formatted.scheduledTime}</td>
                        <td class="text-center font-medium text-[0.65rem] sm:text-sm align-middle whitespace-normal px-1 sm:px-4">${formatted.trainNumber}</td>
                        <td data-route-cell="${index}" class="text-[0.65rem] sm:text-sm align-middle whitespace-normal leading-tight px-1 sm:px-4" style="font-family: 'Outfit', 'Noto Sans SC', sans-serif; font-weight: 700; letter-spacing: 0.01em;">${formatted.origin}</td>
                        <td class="text-center font-mono font-bold text-sm sm:text-xl align-middle whitespace-nowrap px-1 sm:px-4">${formatted.actualTime}</td>
                        <td class="text-center font-medium text-[0.65rem] sm:text-sm align-middle px-1 sm:px-4 leading-tight" style="color:${formatted.statusColor}">${formatted.status}</td>
                        <td class="text-center font-mono font-bold text-sm sm:text-lg align-middle px-1 sm:px-4">${formatted.platformHtml}</td>
                    </tr>`;
        });
    }

    tableHtml += '</tbody></table></div>';
    contentEl.innerHTML = tableHtml;

    contentEl.querySelectorAll('.train-row').forEach(row => {
        row.addEventListener('click', function () {
            const num = this.getAttribute('data-train-number');
            if (num) window.location.href = '/?train=' + encodeURIComponent(num.trim());
        });
    });
}

async function _stFetchWeather(stationId) {
    const apiBase = window.API_BASE;
    try {
        const regRes = await fetch(apiBase + '/regione/' + stationId);
        if (!regRes.ok) return;
        const codReg = parseInt(await regRes.text());
        if (isNaN(codReg)) return;

        const meteoRes = await fetch(apiBase + '/datimeteo/' + codReg);
        if (!meteoRes.ok) return;
        const meteoData = await meteoRes.json();

        const sw = meteoData[stationId];
        if (!sw) return;

        document.getElementById('weatherTemp').textContent = sw.oggiTemperatura + '\u00b0C';
        document.getElementById('weatherAM').textContent   = sw.oggiTemperaturaMattino + '\u00b0';
        document.getElementById('weatherPM').textContent   = sw.oggiTemperaturaPomeriggio + '\u00b0';
        document.getElementById('weatherEve').textContent  = sw.oggiTemperaturaSera + '\u00b0';
        document.getElementById('weatherBar').classList.remove('opacity-0');
    } catch (e) {
        console.error('Weather fetch failed:', e);
    }
}

document.addEventListener('astro:page-load', () => {
    // Guard: only run on the station page
    if (!document.getElementById('boardContent')) return;

    const params = new URLSearchParams(window.location.search);
    _stId        = params.get('id') || '';
    _stName      = decodeURIComponent(params.get('name') || '');
    _stBoardType = params.get('type') || 'partenze';

    // Register language change hook for this page.
    // common.js fires onLanguageChanged during its own astro:page-load (which runs first),
    // so this hook is for user-initiated language switches that happen later.
    window.onLanguageChanged = function () {
        if (_stId) _stLoadBoard();
    };

    const nameEl = document.getElementById('stationName');
    if (nameEl) nameEl.textContent = _stName;

    document.getElementById('btnPartenze').classList.toggle('active', _stBoardType === 'partenze');
    document.getElementById('btnArrivi').classList.toggle('active', _stBoardType === 'arrivi');

    if (!_stId) {
        document.getElementById('errorMessage').style.display   = 'block';
        document.getElementById('loadingIndicator').style.display = 'none';
        return;
    }

    _stLoadBoard();
    _stFetchWeather(_stId);
});
