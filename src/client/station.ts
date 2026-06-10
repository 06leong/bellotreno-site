
// BelloTreno © 2026

import { registerStationNavigationGlobal, type StationBoardType } from './station-navigation.js';

export {};

const translations = window.translations || {};
type Language = NonNullable<Window["currentLang"]>;

interface StationBoardTrain {
    arrivoReale?: number | null;
    binarioEffettivoArrivoDescrizione?: string | null;
    binarioEffettivoPartenzaDescrizione?: string | null;
    binarioProgrammatoArrivoDescrizione?: string | null;
    binarioProgrammatoPartenzaDescrizione?: string | null;
    compNumeroTreno?: string | null;
    compOrarioArrivo?: string | null;
    compOrarioEffettivoArrivo?: string | null;
    compOrarioEffettivoPartenza?: string | null;
    compOrarioPartenza?: string | null;
    destinazione?: string | null;
    destinazioneEstera?: string | null;
    inStazione?: boolean | null;
    nonPartito?: boolean | null;
    numeroTreno?: string | number | null;
    origine?: string | null;
    origineEstera?: string | null;
    provider?: string;
    provvedimento?: number | string | null;
    ritardo?: number | null;
    source?: string;
    [key: string]: unknown;
}

interface FormattedDepartureData {
    destination: string;
    inStazione: boolean;
    platformHtml: string;
    rawData: StationBoardTrain;
    scheduledTime: string;
    status: string;
    statusColor: string;
    trainNumber: string;
}

interface FormattedArrivalData {
    actualTime: string;
    inStazione: boolean;
    origin: string;
    platformHtml: string;
    rawData: StationBoardTrain;
    scheduledTime: string;
    status: string;
    statusColor: string;
    trainNumber: string;
}

interface BoardColumn {
    center: boolean;
    label: string;
    width: string;
}

interface SwissLookupData {
    available?: boolean;
    stops?: Array<{ name?: string | null }>;
}

registerStationNavigationGlobal();

function getItalianTimeString(): string {
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


async function fetchViaggiaStationBoard(stationId: string, type: StationBoardType = 'partenze'): Promise<StationBoardTrain[]> {
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
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error('Failed to fetch station board:', error);
        throw error;
    }
}

function resolveItaloStationCode(stationId: string, stationName: string): string {
    if (_stItaloCode) return _stItaloCode;
    const map = window.ITALO_STATION_CODE_MAP || {};
    const mapped = map[String(stationId || '').trim()];
    if (mapped) return mapped;

    const normalized = stationName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.\-_/(),]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
    const byName: Record<string, string> = {
        'MILANO CENTRALE': 'MC_',
        'MILANO RHO FIERA': 'RRO',
        'RHO FIERA MILANO': 'RRO',
        'ROMA TERMINI': 'RMT',
        'ROMA TIBURTINA': 'RTB',
        'FIRENZE SANTA MARIA NOVELLA': 'SMN',
        'BOLOGNA CENTRALE': 'BO2',
        'REGGIO EMILIA AV MEDIOPADANA': 'AAV',
        'TORINO PORTA SUSA': 'OUE',
        'TORINO PORTA DI SUSA': 'OUE',
        'TORINO PORTA NUOVA': 'TOP'
    };
    return byName[normalized] || '';
}

async function fetchItaloStationBoard(stationId: string, stationName: string, type: StationBoardType = 'partenze'): Promise<StationBoardTrain[]> {
    const endpoint = window.ITALO_STATION_BASE || '/api/italo/station';
    if (!endpoint) return [];

    const params = new URLSearchParams({ type });
    const code = resolveItaloStationCode(stationId, stationName);
    if (code) params.set('code', code);
    if (stationId) params.set('rfi', stationId);
    if (stationName) params.set('name', stationName);

    try {
        const response = await fetch(`${endpoint}?${params.toString()}`, {
            headers: { accept: 'application/json' }
        });
        if (!response.ok) return [];
        const data = await response.json();
        if (!data?.available || !Array.isArray(data.trains)) return [];
        return data.trains;
    } catch (error) {
        console.error('Failed to fetch Italo station board:', error);
        return [];
    }
}

function boardSortTime(train: StationBoardTrain, type: StationBoardType): number {
    const raw = type === 'arrivi'
        ? train.compOrarioArrivo || train.compOrarioEffettivoArrivo || ''
        : train.compOrarioPartenza || train.compOrarioEffettivoPartenza || '';
    const match = String(raw).match(/(\d{1,2}):(\d{2})/);
    if (!match) return Number.MAX_SAFE_INTEGER;
    return Number(match[1]) * 60 + Number(match[2]);
}

async function fetchStationBoard(stationId: string, type: StationBoardType = 'partenze'): Promise<StationBoardTrain[]> {
    const [viaggiaResult, italoResult] = await Promise.allSettled([
        fetchViaggiaStationBoard(stationId, type),
        fetchItaloStationBoard(stationId, _stName, type)
    ]);

    const viaggiaData = viaggiaResult.status === 'fulfilled' ? viaggiaResult.value : [];
    const italoData = italoResult.status === 'fulfilled' ? italoResult.value : [];
    if (viaggiaResult.status === 'rejected' && !italoData.length) throw viaggiaResult.reason;

    return [...viaggiaData, ...italoData].sort((left, right) => boardSortTime(left, type) - boardSortTime(right, type));
}

const OPERATOR_MAP = window.CLIENT_MAP || {};


function formatTrainNumber(trainNumberStr: string): string {
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

function formatDepartureData(train: StationBoardTrain, currentLang: Language = 'zh', currentStation = ''): FormattedDepartureData {
    const t = STATION_TRANSLATIONS[currentLang] || STATION_TRANSLATIONS.zh;

    
    const scheduledTime = train.compOrarioPartenza || '--:--';

    const trainNumber = formatTrainNumber(train.compNumeroTreno || '');

    
    const destination = (train.destinazioneEstera &&
        train.destinazioneEstera !== train.origine &&
        train.destinazioneEstera.toUpperCase() !== currentStation.toUpperCase())
        ? train.destinazioneEstera : (train.destinazione || '');

    
    let status = '';
    let statusColor = 'green';
    const delayMinutes = Number(train.ritardo ?? 0);

    if (train.provvedimento == 1) {
        status = t.cancelled;
        statusColor = 'red';
    } else if (train.nonPartito === true) {
        status = t.not_departed;
        statusColor = 'grey';
    } else if (delayMinutes > 0) {
        status = `${t.delayed} ${delayMinutes} ${t.minutes}`;
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


function formatArrivalData(train: StationBoardTrain, currentLang: Language = 'zh', currentStation = ''): FormattedArrivalData {
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
    const delayMinutes = Number(train.ritardo ?? 0);

    if (train.provvedimento == 1) {
        status = t.cancelled;
        statusColor = 'red';
    } else if (delayMinutes > 0) {
        status = `${t.delayed} ${delayMinutes} ${t.minutes}`;
        statusColor = 'red';
    } else if (delayMinutes < 0) {
        status = `${t.early} ${Math.abs(delayMinutes)} ${t.minutes}`;
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


// =============================================================
// Station Board Page Logic
// Moved from station.astro inline script for maintainability.
// Only activates when #boardContent is present (station page).
// =============================================================

let _stId = '';
let _stName = '';
let _stItaloCode = '';
let _stBoardType: StationBoardType = 'partenze';
let _stBoardSeq = 0;
const ST_SWISS_MAX_LOOKUPS = 10;

function switchBoardType(type: StationBoardType): void {
    _stBoardType = type;
    document.getElementById('btnPartenze')?.classList.toggle('active', type === 'partenze');
    document.getElementById('btnArrivi')?.classList.toggle('active', type === 'arrivi');
    void _stLoadBoard();
}

function isStationBoardType(value: string | undefined): value is StationBoardType {
    return value === 'partenze' || value === 'arrivi';
}

function bindStationBoardTypeControls(): void {
    document.querySelectorAll<HTMLElement>('[data-board-type]').forEach((button) => {
        if (button.dataset.btBound) return;
        button.dataset.btBound = 'true';
        button.addEventListener('click', () => {
            if (isStationBoardType(button.dataset.boardType)) {
                switchBoardType(button.dataset.boardType);
            }
        });
    });
}

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
            const iconEl = errorEl.querySelector('span');
            const messageEl = errorEl.querySelector('p');
            if (iconEl) iconEl.textContent = 'info';
            if (messageEl) messageEl.textContent = t.no_trains || 'No trains at this time';
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

function _stEsc(value: unknown): string {
    return window.escapeHtml ? window.escapeHtml(value) : String(value ?? '');
}

function _stTrainNumber(train: StationBoardTrain): string {
    if (window.BelloSwiss?.getTrainNumber) return window.BelloSwiss.getTrainNumber(train);
    return String(train?.numeroTreno || train?.compNumeroTreno || '').replace(/\D+/g, '');
}

function _stOperationDate(train: StationBoardTrain): string {
    return window.BelloSwiss?.getOperationDate?.(train)
        || window.BelloSwiss?.getTodayInZurich?.()
        || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
}

function _stVisibleRouteName(train: StationBoardTrain): string {
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

function _stShouldTrySwiss(train: StationBoardTrain): boolean {
    if (train.provider === 'italo' || train.source === 'italo') return false;
    if (!window.BelloSwiss) return false;
    const visibleRoute = _stVisibleRouteName(train);
    const category = window.BelloSwiss.getCategory ? window.BelloSwiss.getCategory(train) : '';

    if (window.BelloSwiss.isSwissBoundaryName?.(visibleRoute)) return true;
    if (['EC', 'EN'].includes(category)) return true;
    if (['REG', 'RE', 'RV', 'S', 'IR'].includes(category) && window.BelloSwiss.hasSwissHint?.(train)) return true;
    return false;
}

function _stSwissTerminalName(swissData: SwissLookupData): string {
    const stops = Array.isArray(swissData?.stops) ? swissData.stops : [];
    if (!stops.length) return '';
    const terminal = _stBoardType === 'partenze' ? stops[stops.length - 1] : stops[0];
    return terminal?.name || '';
}

function _stShouldReplaceRouteName(currentName: string, swissName: string): boolean {
    if (!swissName || !window.BelloSwiss) return false;
    const currentKey = currentName ? window.BelloSwiss.normalizeStationName(currentName) : '';
    const swissKey = window.BelloSwiss.normalizeStationName(swissName);
    const stationKey = window.BelloSwiss.normalizeStationName(_stName);
    if (!swissKey || swissKey === currentKey || swissKey === stationKey) return false;

    if (!currentKey) return true;
    return Boolean(window.BelloSwiss.isSwissBoundaryName?.(currentName));
}

async function _stEnhanceBoardWithSwiss(trains: StationBoardTrain[], boardSeq: number): Promise<void> {
    if (!window.BelloSwiss?.fetchSwissByTrainNumber || !Array.isArray(trains) || !trains.length) return;

    const candidates = trains
        .map((train, index) => ({ train, index }))
        .filter(({ train }) => _stShouldTrySwiss(train))
        .slice(0, ST_SWISS_MAX_LOOKUPS);

    for (const { train, index } of candidates) {
        if (boardSeq !== _stBoardSeq) return;

        const trainNumber = _stTrainNumber(train);
        const operationDate = _stOperationDate(train);
        if (!trainNumber || !operationDate) continue;

        const swissData = await window.BelloSwiss.fetchSwissByTrainNumber(trainNumber, operationDate) as SwissLookupData;
        if (boardSeq !== _stBoardSeq) return;
        if (!swissData?.available) continue;

        const currentName = _stVisibleRouteName(train);
        const swissName = _stSwissTerminalName(swissData);
        if (!_stShouldReplaceRouteName(currentName, swissName)) continue;

        const cell = document.querySelector(`[data-route-cell="${index}"]`);
        if (!cell) continue;

        const sourceText = translations[window.currentLang]?.swiss_source || 'CH';
        cell.classList.add('station-route-swiss');
        _stReplaceChildren(cell, [
            _stTextElement('span', swissName),
            _stTextElement('span', sourceText, 'source-badge source-badge-swiss station-source-badge')
        ]);
    }
}

function _stTextElement<K extends keyof HTMLElementTagNameMap>(tagName: K, text: unknown, className = ''): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(text ?? '');
    return element;
}

function _stReplaceChildren(element: Element, children: Node[]): void {
    if (typeof element.replaceChildren === 'function') {
        element.replaceChildren(...children);
        return;
    }
    element.textContent = '';
    children.forEach((child: Node) => element.appendChild(child));
}

function _stCreateCell(tagName: 'td' | 'th', text: unknown, className: string, width = ''): HTMLTableCellElement {
    const cell = document.createElement(tagName);
    cell.className = className;
    if (width) cell.style.width = width;
    if (text !== undefined && text !== null) cell.textContent = String(text);
    return cell;
}

function _stAppendTrainBadge(cell: HTMLElement, trainNumberStr: unknown): void {
    const raw = String(trainNumberStr || '').trim();
    if (!raw) {
        cell.textContent = '--';
        return;
    }

    const match = raw.match(/^([A-Z\s]+?)\s*(\d+)$/);
    if (!match) {
        cell.textContent = raw;
        return;
    }

    let catCode = match[1].trim();
    const num = match[2];
    if (catCode.toUpperCase().includes('EC FR')) catCode = 'FR';
    if (catCode.toUpperCase().includes('TS')) catCode = 'TS';

    const badgeClass = window.getBadgeClass ? window.getBadgeClass(catCode) : '';
    if (!badgeClass) {
        const category = _stTextElement('span', catCode);
        category.style.fontSize = '0.8rem';
        category.style.fontWeight = '700';
        category.style.opacity = '0.7';
        cell.append(category, document.createElement('br'), document.createTextNode(num));
        return;
    }

    const badge = document.createElement('span');
    badge.classList.add('train-badge', 'station-badge');
    String(badgeClass).split(/\s+/).filter(Boolean).forEach((className) => badge.classList.add(className));
    badge.append(
        _stTextElement('span', catCode, 'badge-cat'),
        _stTextElement('span', num, 'badge-num')
    );
    cell.appendChild(badge);
}

function _stAppendPlatform(cell: HTMLElement, train: StationBoardTrain, type: StationBoardType): void {
    const actualPlatform = type === 'arrivi'
        ? train.binarioEffettivoArrivoDescrizione || ''
        : train.binarioEffettivoPartenzaDescrizione || '';
    const scheduledPlatform = type === 'arrivi'
        ? train.binarioProgrammatoArrivoDescrizione || ''
        : train.binarioProgrammatoPartenzaDescrizione || '';
    const inStation = train.inStazione === true;

    function platformSpan(text: string, changed = false): HTMLSpanElement {
        const span = _stTextElement('span', text);
        if (inStation) span.classList.add('platform-pulse');
        if (changed) {
            span.style.color = 'red';
            span.style.fontWeight = 'bold';
        }
        return span;
    }

    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        const scheduled = _stTextElement('del', scheduledPlatform);
        scheduled.style.color = 'grey';
        cell.append(platformSpan(actualPlatform, true), document.createTextNode(' '), scheduled);
        return;
    }
    if (actualPlatform || scheduledPlatform) {
        cell.appendChild(platformSpan(actualPlatform || scheduledPlatform));
        return;
    }
    cell.textContent = '--';
}

function _stRouteCell(text: string, index: number): HTMLTableCellElement {
    const cell = _stCreateCell('td', text, "text-[0.65rem] sm:text-sm align-middle whitespace-normal leading-tight px-1 sm:px-4");
    cell.dataset.routeCell = String(index);
    cell.style.fontFamily = "var(--app-font-heading)";
    cell.style.fontWeight = '700';
    cell.style.letterSpacing = '0.01em';
    return cell;
}

function _stBuildBoardHeader(columns: BoardColumn[]): HTMLTableSectionElement {
    const thead = document.createElement('thead');
    thead.className = 'bg-primary text-primary-content border-none';
    const row = document.createElement('tr');
    columns.forEach((column: BoardColumn, index: number) => {
        const classes = `${column.center ? 'text-center ' : ''}py-2 sm:py-3 font-semibold text-[0.65rem] sm:text-sm${index < columns.length - 1 ? ' border-r border-primary-content/20' : ''}`;
        row.appendChild(_stCreateCell('th', column.label, classes, column.width));
    });
    thead.appendChild(row);
    return thead;
}

function _stBuildTrainRow(train: StationBoardTrain, index: number): HTMLTableRowElement {
    const isDepartures = _stBoardType === 'partenze';
    const trainNumber = train.numeroTreno || '';
    const row = document.createElement('tr');
    row.className = 'train-row hover cursor-pointer transition-colors border-b border-base-200 last:border-0';
    row.dataset.trainNumber = String(trainNumber);

    let scheduledTime = '--:--';
    let status = '';
    let statusColor = 'green';

    if (isDepartures) {
        const formatted = formatDepartureData(train, window.currentLang, _stName);
        scheduledTime = formatted.scheduledTime;
        status = formatted.status;
        statusColor = formatted.statusColor;
    } else {
        const formatted = formatArrivalData(train, window.currentLang, _stName);
        scheduledTime = formatted.scheduledTime;
        status = formatted.status;
        statusColor = formatted.statusColor;
    }

    row.appendChild(_stCreateCell('td', scheduledTime, 'text-center font-mono font-bold text-sm sm:text-xl align-middle whitespace-nowrap px-1 sm:px-4'));

    const trainCell = _stCreateCell('td', null, 'text-center font-medium text-[0.65rem] sm:text-sm align-middle whitespace-normal px-1 sm:px-4');
    _stAppendTrainBadge(trainCell, train.compNumeroTreno || '');
    row.appendChild(trainCell);

    if (isDepartures) {
        const formatted = formatDepartureData(train, window.currentLang, _stName);
        row.appendChild(_stRouteCell(formatted.destination, index));
    } else {
        const formatted = formatArrivalData(train, window.currentLang, _stName);
        row.appendChild(_stRouteCell(formatted.origin, index));
        row.appendChild(_stCreateCell('td', formatted.actualTime, 'text-center font-mono font-bold text-sm sm:text-xl align-middle whitespace-nowrap px-1 sm:px-4'));
    }

    const statusCell = _stCreateCell('td', status, 'text-center font-medium text-[0.65rem] sm:text-sm align-middle px-1 sm:px-4 leading-tight');
    statusCell.style.color = statusColor;
    row.appendChild(statusCell);

    const platformCell = _stCreateCell('td', null, 'text-center font-mono font-bold text-sm sm:text-lg align-middle px-1 sm:px-4');
    _stAppendPlatform(platformCell, train, _stBoardType);
    row.appendChild(platformCell);

    return row;
}

function _stRenderBoard(trains: StationBoardTrain[]): void {
    const contentEl = document.getElementById('boardContent');
    const t = translations[window.currentLang];
    if (!contentEl) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'overflow-x-auto bg-base-100/65 backdrop-blur-3xl rounded-2xl shadow-glass border border-base-content/10';

    const table = document.createElement('table');
    table.className = 'table table-zebra table-sm sm:table-md w-full';

    const columns = _stBoardType === 'partenze'
        ? [
            { width: '16%', label: t.scheduled_time, center: true },
            { width: '14%', label: t.train, center: true },
            { width: '32%', label: t.destination, center: false },
            { width: '22%', label: t.status, center: true },
            { width: '16%', label: t.platform, center: true }
        ]
        : [
            { width: '13%', label: t.scheduled_time, center: true },
            { width: '12%', label: t.train, center: true },
            { width: '22%', label: t.origin, center: false },
            { width: '15%', label: t.actual_time, center: true },
            { width: '22%', label: t.status, center: true },
            { width: '16%', label: t.platform, center: true }
        ];

    const tbody = document.createElement('tbody');
    trains.forEach((train: StationBoardTrain, index: number) => tbody.appendChild(_stBuildTrainRow(train, index)));
    table.append(_stBuildBoardHeader(columns), tbody);
    wrapper.appendChild(table);
    _stReplaceChildren(contentEl, [wrapper]);

    contentEl.querySelectorAll<HTMLElement>('.train-row').forEach(row => {
        row.addEventListener('click', (event) => {
            const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
            const num = target?.getAttribute('data-train-number');
            if (num) window.location.href = '/?train=' + encodeURIComponent(num.trim());
        });
    });
}

async function _stFetchWeather(stationId: string): Promise<void> {
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

        const tempEl = document.getElementById('weatherTemp');
        const morningEl = document.getElementById('weatherAM');
        const afternoonEl = document.getElementById('weatherPM');
        const eveningEl = document.getElementById('weatherEve');
        const weatherBar = document.getElementById('weatherBar');
        if (tempEl) tempEl.textContent = sw.oggiTemperatura + '\u00b0C';
        if (morningEl) morningEl.textContent = sw.oggiTemperaturaMattino + '\u00b0';
        if (afternoonEl) afternoonEl.textContent = sw.oggiTemperaturaPomeriggio + '\u00b0';
        if (eveningEl) eveningEl.textContent = sw.oggiTemperaturaSera + '\u00b0';
        if (weatherBar) weatherBar.classList.remove('opacity-0');
    } catch (e) {
        console.error('Weather fetch failed:', e);
    }
}

document.addEventListener('astro:page-load', () => {
    // Guard: only run on the station page
    if (!document.getElementById('boardContent')) return;

    bindStationBoardTypeControls();

    const params = new URLSearchParams(window.location.search);
    _stId        = params.get('id') || '';
    _stName      = decodeURIComponent(params.get('name') || '');
    _stItaloCode = params.get('italo') || '';
    const requestedBoardType = params.get('type') || undefined;
    _stBoardType = isStationBoardType(requestedBoardType) ? requestedBoardType : 'partenze';

    // Register language change hook for this page.
    // common.ts fires onLanguageChanged during its own astro:page-load (which runs first),
    // so this hook is for user-initiated language switches that happen later.
    window.onLanguageChanged = function () {
        if (_stId) void _stLoadBoard();
    };

    const nameEl = document.getElementById('stationName');
    if (nameEl) nameEl.textContent = _stName;

    document.getElementById('btnPartenze')?.classList.toggle('active', _stBoardType === 'partenze');
    document.getElementById('btnArrivi')?.classList.toggle('active', _stBoardType === 'arrivi');

    if (!_stId) {
        const errorEl = document.getElementById('errorMessage');
        const loadingEl = document.getElementById('loadingIndicator');
        if (errorEl) errorEl.style.display = 'block';
        if (loadingEl) loadingEl.style.display = 'none';
        return;
    }

    void _stLoadBoard();
    void _stFetchWeather(_stId);
});
