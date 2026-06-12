import { navigateToStationBoard, registerStationNavigationGlobal } from './station-navigation.js';
import {
    resolveStopTimeStatus,
    type StopTimeStatus
} from '../lib/normalizers/viaggiatreno.js';
import {
    parseTrainTriple,
    readTrainUrlState,
    trainStateToSearch,
    trainTripleToSearch
} from './train-url-state.js';

export {};

type SearchMode = 'train' | 'station';
type JsonRecord = Record<string, unknown>;
type Language = NonNullable<Window["currentLang"]>;
type TimeKind = 'arrival' | 'departure';
type TimeStatus = StopTimeStatus;
type PartialStopBoundary = '' | 'actualStart' | 'actualEnd' | 'replacementStart';
type UrlMode = 'none' | 'push' | 'replace';

interface NodeOptions {
    attrs?: Record<string, unknown>;
    className?: string;
    dataset?: Record<string, unknown>;
    href?: string;
    rel?: string;
    style?: Partial<CSSStyleDeclaration>;
    target?: string;
    text?: unknown;
    title?: string;
    type?: string;
}

type NodeChild = Node | string | number | boolean | null | undefined;

interface SearchOptions {
    urlMode?: UrlMode;
}

interface RecentSearchItem {
    id: string;
    name: string;
    timestamp: number;
    type: SearchMode;
}

interface StationSearchResult {
    id: string | number;
    nomeLungo: string;
}

interface TrainStop extends JsonRecord {
    actualFermataType?: number | string | null;
    arrivoReale?: number | null;
    arrivo_teorico?: number | null;
    binarioEffettivoArrivoDescrizione?: string | null;
    binarioEffettivoPartenzaDescrizione?: string | null;
    binarioProgrammatoArrivoDescrizione?: string | null;
    binarioProgrammatoPartenzaDescrizione?: string | null;
    id?: string | number | null;
    orientamento?: string | null;
    partenzaReale?: number | null;
    partenza_teorica?: number | null;
    programmata?: number | null;
    progressivo?: number | string | null;
    ritardoArrivo?: number | string | null;
    ritardoPartenza?: number | string | null;
    source?: string;
    stazione?: string;
    swissStop?: unknown;
}

interface TrainData extends JsonRecord {
    categoria?: string;
    categoriaDescrizione?: string;
    codiceCliente?: string | number;
    compCategoria?: string;
    compDurata?: string;
    compNumeroTreno?: string;
    compRitardoAndamento?: string[];
    dataPartenzaTreno?: number | string;
    dataPartenzaTrenoAsDate?: string;
    destinazione?: string;
    destinazioneEstera?: string;
    fermate?: TrainStop[];
    fermateSoppresse?: unknown;
    nonPartito?: boolean;
    numeroTreno?: string | number;
    origine?: string;
    origineEstera?: string;
    provider?: string;
    provvedimento?: number | string | null;
    stazioneUltimoRilevamento?: string;
    subTitle?: string;
}

interface PartialCancellationState {
    boundary: PartialStopBoundary;
    cancelled: boolean;
}

interface SwissFormationPayload extends JsonRecord {
    available?: boolean;
}

interface StatisticsPayload {
    treniCircolanti?: number;
    treniGiorno?: number;
}

interface TrenordLineInfo {
    date: string;
    line: string;
    trainNumber: string;
}

interface TrenordTrafficNotice extends JsonRecord {
    date?: string;
    description?: string;
    severityDescription?: string;
    severityLevel?: string;
    urls?: unknown[];
}

interface TrenordTrafficPayload extends JsonRecord {
    available?: boolean;
    direttrice?: string;
    direttriceDescription?: string;
    line?: string;
    notices?: TrenordTrafficNotice[];
    provider?: 'trenord-traffic';
    reason?: string;
}

interface SmartCaringNotice extends JsonRecord {
    infoNote?: string;
    insertTimestamp: string | number;
}

interface SmartCaringHistoryDay extends JsonRecord {
    date: string;
    maxDelay?: number;
    notifications?: number;
    reasons?: string[];
}

interface SmartCaringStats extends JsonRecord {
    avgDelay?: number;
    disruptedDays?: number;
    maxDelay?: number;
    onTimeRate?: number;
    totalDays?: number;
}

interface SmartCaringPayload extends JsonRecord {
    error?: string;
    history?: SmartCaringHistoryDay[];
    noData?: boolean;
    recent?: SmartCaringNotice[];
    stats?: SmartCaringStats;
    today?: SmartCaringNotice[];
}

function isElementTarget(target: EventTarget | null): target is Element {
    return target instanceof Element;
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

/**
 * BelloTreno 主应用逻辑
 * 包含所有核心功能和事件处理
 */


let currentTrainData: TrainData | null = null;
let currentTriple: string | null = null;
let searchMode: SearchMode = 'train';
window.searchMode = searchMode;
let disambiguationData: string[] | null = null;
let disambiguationUrlMode: UrlMode = 'push';
let currentSmartCaringData: JsonRecord | null = null;
let currentTrainCategory = '';
let currentSwissFormationData: SwissFormationPayload | null = null;
let swissRequestSeq = 0;
let currentTrenordLineInfo: TrenordLineInfo | null = null;
let currentItaloTrainNumber: string | null = null;
let currentTickerItems: string[] = [];
let lastLoadedTrainSearch = '';


const API_BASE = window.API_BASE;
const NOTIFY_BASE = window.NOTIFY_BASE;
const TRENORD_TRAFFIC_BASE = window.TRENORD_TRAFFIC_BASE || "/api/trenord/traffic";
const ITALO_TRAIN_BASE = window.ITALO_TRAIN_BASE || "/api/italo/train";
const INFOMOBILITA_TICKER_URL = "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/infomobilitaTicker";
const translations = window.translations || {};
const CLIENT_MAP = window.CLIENT_MAP || {};
const CLIENT_LINK_MAP = window.CLIENT_LINK_MAP || {};
const CAT_MAP = window.CAT_MAP || {};
const CAT_IMAGE_MAP = window.CAT_IMAGE_MAP || {};
const DARK_MODE_CONTRAST_LOGOS = new Set([
    'regn.png',
    'rj.png',
    'nj.png',
    'en.png',
    'espresso.png'
]);
const LIGHT_MODE_CONTRAST_LOGOS = new Set([
    'italo.svg'
]);
const TRENORD_LINE_COLORS: Readonly<Record<string, string>> = Object.freeze({
    RE: "#c02e25",
    RE80: "#205099",
    MXP: "#c02826",
    R: "#2a60a7",
    S1: "#ea3932",
    S2: "#43957b",
    S3: "#991e3d",
    S4: "#8eb943",
    S5: "#ee843c",
    S6: "#ead448",
    S7: "#bc2890",
    S8: "#f1a2c7",
    S9: "#973b86",
    S10: "#c02e25",
    S11: "#939df8",
    S12: "#000000",
    S13: "#603d12",
    S30: "#49a258",
    S40: "#85bb7d",
    S50: "#754917"
});
const TRENORD_LINE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    RE51: "MXP2",
    RE54: "MXP1"
});

function clearNode(node: Element | null): void {
    if (node) node.replaceChildren();
}

function createNode<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    options: NodeOptions = {},
    children: NodeChild | NodeChild[] = []
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.title) node.title = options.title;
    if (options.type) node.setAttribute('type', options.type);
    if (options.href) node.setAttribute('href', options.href);
    if (options.target) node.setAttribute('target', options.target);
    if (options.rel) node.setAttribute('rel', options.rel);
    if (options.style) Object.assign(node.style, options.style);
    if (options.attrs) {
        Object.entries(options.attrs).forEach(([key, value]) => {
            if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        });
    }
    if (options.dataset) {
        Object.entries(options.dataset).forEach(([key, value]) => {
            if (value !== undefined && value !== null) node.dataset[key] = String(value);
        });
    }
    const childList = Array.isArray(children) ? children : [children];
    childList.forEach((child) => {
        if (child === undefined || child === null) return;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
}

function createIcon(name: string, className = 'material-symbols-outlined', options: Pick<NodeOptions, 'attrs' | 'style'> = {}): HTMLSpanElement {
    return createNode('span', {
        className,
        text: name,
        style: options.style,
        attrs: options.attrs
    });
}

function getCategoryLogoClass(src: unknown): string {
    const fileName = String(src || '').split('/').pop()?.toLowerCase() || '';
    if (LIGHT_MODE_CONTRAST_LOGOS.has(fileName)) {
        return 'category-logo category-logo-light-contrast';
    }
    return DARK_MODE_CONTRAST_LOGOS.has(fileName)
        ? 'category-logo category-logo-needs-contrast'
        : 'category-logo';
}

async function fetchStatistiche() {
    try {
        const res = await fetch(API_BASE + '/statistiche/0');
        if (!res.ok) return;
        const data = await res.json() as StatisticsPayload;
        const circolanti = document.getElementById('statsCircolanti');
        const giorno = document.getElementById('statsGiorno');
        const bar = document.getElementById('statsBar');
        if (circolanti) circolanti.textContent = Number(data.treniCircolanti || 0).toLocaleString();
        if (giorno) giorno.textContent = Number(data.treniGiorno || 0).toLocaleString();
        if (bar) bar.classList.remove('opacity-0');
    } catch (e) {
        console.error('Stats fetch failed:', e);
    }
}

function proxiedInfomobilitaUrl(targetUrl: string): string {
    const proxyBase = window.PROXY_BASE || "https://ah.bellotreno.workers.dev";
    return `${proxyBase}/?url=${encodeURIComponent(targetUrl)}&ts=${Date.now()}`;
}

function parseInfomobilitaTickerItems(htmlText: string): string[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    const items = Array.from(doc.querySelectorAll("li"))
        .map((item) => item.textContent?.replace(/\s+/g, " ").trim() || "")
        .filter(Boolean);

    const fallback = doc.body.textContent?.replace(/\s+/g, " ").trim() || "";
    const rawItems = items.length ? items : fallback ? [fallback] : [];
    return Array.from(new Set(rawItems));
}

function tickerLabel(): string {
    return translations[window.currentLang]?.info_ticker_label || "Live notices";
}

function createTickerGroup(items: string[]): HTMLSpanElement {
    return createNode("span", { className: "home-ticker-group" }, items.map((item) => (
        createNode("span", { className: "home-ticker-item", text: item })
    )));
}

function updateTickerOverflow(container: HTMLElement, items: string[]): void {
    const viewport = container.querySelector<HTMLElement>(".home-ticker-viewport");
    const track = container.querySelector<HTMLElement>(".home-ticker-track");
    if (!viewport || !track) return;

    track.replaceChildren(createTickerGroup(items));
    container.classList.remove("is-overflowing");
    track.style.removeProperty("--ticker-duration");

    requestAnimationFrame(() => {
        const firstWidth = track.scrollWidth;
        const overflowing = firstWidth > viewport.clientWidth;
        container.classList.toggle("is-overflowing", overflowing);
        if (!overflowing) return;

        track.appendChild(createTickerGroup(items));
        const duration = Math.max(28, Math.min(78, Math.round(firstWidth / 22)));
        track.style.setProperty("--ticker-duration", `${duration}s`);
    });
}

function renderInfomobilitaTicker(items: string[]): void {
    const container = document.getElementById("infomobilitaTicker");
    if (!container) return;

    if (!items.length) {
        container.hidden = true;
        container.replaceChildren();
        return;
    }

    const labelText = createNode("span", { attrs: { "data-i18n": "info_ticker_label" }, text: tickerLabel() });
    const shell = createNode("div", { className: "home-ticker-shell" }, [
        createNode("span", { className: "home-ticker-label" }, [
            createIcon("campaign"),
            labelText,
        ]),
        createNode("div", { className: "home-ticker-viewport" }, [
            createNode("div", { className: "home-ticker-track" }),
        ]),
    ]);

    container.replaceChildren(shell);
    container.hidden = false;
    updateTickerOverflow(container, items);
}

async function fetchInfomobilitaTicker(): Promise<void> {
    const container = document.getElementById("infomobilitaTicker");
    if (!container) return;

    try {
        const res = await fetch(proxiedInfomobilitaUrl(INFOMOBILITA_TICKER_URL));
        if (!res.ok) throw new Error("ticker_fetch_failed");
        currentTickerItems = parseInfomobilitaTickerItems(await res.text());
        renderInfomobilitaTicker(currentTickerItems);
    } catch (e) {
        console.error("Infomobilita ticker fetch failed:", e);
        currentTickerItems = [];
        renderInfomobilitaTicker(currentTickerItems);
    }
}




function updateSearchLabel() {
    const trainSearch = document.getElementById('trainSearch') as HTMLInputElement | null;
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


function switchSearchMode(mode: SearchMode) {
    searchMode = mode;
    window.searchMode = searchMode;

    updateSearchLabel();


    const trainSearch = document.getElementById('trainSearch') as HTMLInputElement | null;
    if (trainSearch) trainSearch.value = '';


    const results = document.getElementById('results');
    const disambiguation = document.getElementById('disambiguation');
    if (results) results.style.display = 'none';
    if (disambiguation) disambiguation.style.display = 'none';
    currentSmartCaringData = null;
    currentTrenordLineInfo = null;
    currentSwissFormationData = null;
    swissRequestSeq++;
    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
    if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
}



window.onLanguageChanged = function () {

    updateSearchLabel();
    renderInfomobilitaTicker(currentTickerItems);


    if (disambiguationData) {
        renderDisambiguation();
    }


    if (currentTrainData) {
        render(currentTrainData);
    }
    if (currentSmartCaringData?.provider === 'trenord-traffic') {
        renderTrenordTrafficInformation(currentSmartCaringData);
    } else if (currentSmartCaringData) {
        renderSmartCaring(currentSmartCaringData);
    }
};


function goHome() {
    window.location.href = '/';
}

window.switchSearchMode = switchSearchMode;
window.goHome = goHome;
registerStationNavigationGlobal();




function formatDuration(duration: string | null | undefined): string {
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

function formatDurationMinutes(totalMinutes: number): string {
    if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return 'N/A';
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const t = translations[window.currentLang] || translations.en;
    return window.currentLang === 'zh'
        ? `${hours}${t.hours}${mins}${t.minutes}`
        : `${hours}${t.hours} ${mins}${t.minutes}`;
}


function translateStatus(text: string): string {
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

function formatT(ms: unknown): string | null {
    if (!ms) return null;
    const raw = typeof ms === 'string' || typeof ms === 'number' || ms instanceof Date ? ms : String(ms);
    return new Date(raw).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
}

function hasTimestamp(ms: unknown): boolean {
    const value = Number(ms);
    return Number.isFinite(value) && value > 0;
}

function applyTrainSearchUrl(search: string, mode: UrlMode = 'push'): void {
    if (mode === 'none' || !search || !window.history) return;
    const nextUrl = `${window.location.pathname}?${search}`;
    if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
    if (mode === 'replace') {
        window.history.replaceState({}, document.title, nextUrl);
        return;
    }
    window.history.pushState({}, document.title, nextUrl);
}

function applyTrainTripleUrl(triple: string, mode: UrlMode = 'push'): void {
    applyTrainSearchUrl(trainTripleToSearch(triple), mode);
}

function resolveExpectedTimestamp(schedMs: unknown, realMs: unknown, delayMin: unknown): number | null {
    if (!hasTimestamp(schedMs) || hasTimestamp(realMs)) return null;
    const delay = Number(delayMin);
    if (!Number.isFinite(delay) || delay === 0) return null;
    return Number(schedMs) + delay * 60000;
}

function sameDisplayedMinute(left: unknown, right: unknown): boolean {
    if (!hasTimestamp(left) || !hasTimestamp(right)) return false;
    return formatT(left) === formatT(right);
}

function formatTimeStatusText(status: TimeStatus, delayMin: unknown): string {
    const delay = Math.abs(Math.round(Number(delayMin) || 0));
    if (status === 'late') {
        return `+${delay} min`;
    }
    if (status === 'early') {
        return `-${delay} min`;
    }
    if (status === 'on-time') {
        return translations[window.currentLang].time_on_time || translations[window.currentLang].on_time || 'On time';
    }
    return '';
}

function getTimeLabelParts(kind: TimeKind): { full: string; short: string } {
    if (kind === 'arrival') {
        return {
            full: translations[window.currentLang].arrival,
            short: translations[window.currentLang].arrival_short || translations[window.currentLang].arrival
        };
    }
    return {
        full: translations[window.currentLang].departure,
        short: translations[window.currentLang].departure_short || translations[window.currentLang].departure
    };
}

function createTimeLabelNode(kind: TimeKind): HTMLSpanElement {
    const label = getTimeLabelParts(kind);
    return createNode('span', { className: 'time-label' }, [
        createNode('span', { className: 'time-label-full', text: label.full }),
        createNode('span', { className: 'time-label-short', text: label.short })
    ]);
}

function renderTimeHtml(kind: TimeKind, schedMs: unknown, realMs: unknown, delayMin: unknown): string {
    const sched = formatT(schedMs);
    const hasReal = hasTimestamp(realMs);
    const expectedMs = resolveExpectedTimestamp(schedMs, realMs, delayMin);
    const hasExpected = hasTimestamp(expectedMs) && !sameDisplayedMinute(schedMs, expectedMs);
    const primaryMs = hasReal ? Number(realMs) : (hasExpected ? expectedMs : (hasTimestamp(schedMs) ? Number(schedMs) : null));
    const primary = formatT(primaryMs) || '--:--';
    const status = resolveStopTimeStatus({
        delayMinutes: delayMin,
        realMs,
        scheduledMs: schedMs,
        displayedMs: primaryMs
    });
    const statusText = formatTimeStatusText(status, delayMin);
    const label = getTimeLabelParts(kind);
    const scheduledLabel = translations[window.currentLang].scheduled_short || translations[window.currentLang].scheduled;
    const scheduledLine = sched
        ? `<span class="time-scheduled-row"><span class="time-scheduled-label">${scheduledLabel}</span><span class="time-scheduled-value tabular-nums">${sched}</span></span>`
        : '';
    const statusLine = statusText
        ? `<span class="time-status-badge time-status-${status}">${statusText}</span>`
        : '';
    return `<div class="time-item time-item-${kind}"><span class="time-label"><span class="time-label-full">${label.full}</span><span class="time-label-short">${label.short}</span></span><span class="time-stack"><span class="time-primary-row"><span class="time-primary-value tabular-nums ${status}">${primary}</span>${statusLine}</span>${scheduledLine}</span></div>`;
}

function renderTimeNode(kind: TimeKind, schedMs: unknown, realMs: unknown, delayMin: unknown): HTMLDivElement {
    const sched = formatT(schedMs);
    const hasReal = hasTimestamp(realMs);
    const expectedMs = resolveExpectedTimestamp(schedMs, realMs, delayMin);
    const hasExpected = hasTimestamp(expectedMs) && !sameDisplayedMinute(schedMs, expectedMs);
    const primaryMs = hasReal ? Number(realMs) : (hasExpected ? expectedMs : (hasTimestamp(schedMs) ? Number(schedMs) : null));
    const primary = formatT(primaryMs) || '--:--';
    const status = resolveStopTimeStatus({
        delayMinutes: delayMin,
        realMs,
        scheduledMs: schedMs,
        displayedMs: primaryMs
    });
    const statusText = formatTimeStatusText(status, delayMin);

    const primaryChildren = [
        createNode('span', {
            className: `time-primary-value tabular-nums ${status}`.trim(),
            text: primary
        })
    ];

    if (statusText) {
        primaryChildren.push(createNode('span', {
            className: `time-status-badge time-status-${status}`.trim(),
            text: statusText
        }));
    }

    const stackChildren = [
        createNode('span', { className: 'time-primary-row' }, primaryChildren)
    ];

    if (sched) {
        stackChildren.push(createNode('span', {
            className: `time-scheduled-row${hasReal || hasExpected ? ' time-scheduled-muted' : ''}`.trim()
        }, [
            createNode('span', {
                className: 'time-scheduled-label',
                text: translations[window.currentLang].scheduled_short || translations[window.currentLang].scheduled
            }),
            createNode('span', {
                className: 'time-scheduled-value tabular-nums',
                text: sched
            })
        ]));
    }

    return createNode('div', { className: `time-item time-item-${kind}` }, [
        createTimeLabelNode(kind),
        createNode('span', { className: 'time-stack' }, stackChildren)
    ]);
}

function normalizeStationMatchName(value: unknown): string {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[’'`´]/g, '')
        .replace(/[.\-_/(),]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

function findStopIndexByName(stops: TrainStop[], name: unknown): number {
    const target = normalizeStationMatchName(name);
    if (!target) return -1;

    let index = stops.findIndex((stop) => normalizeStationMatchName(stop?.stazione) === target);
    if (index >= 0) return index;

    index = stops.findIndex((stop) => {
        const current = normalizeStationMatchName(stop?.stazione);
        return current && (current.includes(target) || target.includes(current));
    });
    return index;
}

function collectSuppressedStopNames(value: unknown, names: string[] = []): string[] {
    if (!value) return names;
    if (typeof value === 'string') {
        names.push(value);
        return names;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectSuppressedStopNames(item, names));
        return names;
    }
    if (typeof value === 'object') {
        const record = asRecord(value);
        ['stazione', 'nome', 'name', 'descrizione', 'denominazione'].forEach((key) => {
            if (typeof record[key] === 'string') names.push(record[key]);
        });
    }
    return names;
}

function partialStopLabel(kind: PartialStopBoundary | 'cancelled'): string {
    if (!kind) return '';
    const lang = window.currentLang || 'en';
    const labels = {
        zh: {
            cancelled: '取消停站',
            actualStart: '实际始发',
            actualEnd: '实际终到',
            replacementStart: '换乘后运行'
        },
        it: {
            cancelled: 'Fermata cancellata',
            actualStart: 'Parte da qui',
            actualEnd: 'Termina qui',
            replacementStart: 'Prosegue con cambio'
        },
        en: {
            cancelled: 'Cancelled stop',
            actualStart: 'Starts here',
            actualEnd: 'Ends here',
            replacementStart: 'Replacement leg'
        }
    };
    return (labels[lang] || labels.en)[kind] || kind;
}

function buildPartialCancellationState(data: TrainData, stops: TrainStop[]): PartialCancellationState[] {
    const states: PartialCancellationState[] = (Array.isArray(stops) ? stops : []).map((stop) => ({
        cancelled: Number(stop?.actualFermataType) === 3,
        boundary: ''
    }));
    if (!states.length) return states;

    collectSuppressedStopNames(data?.fermateSoppresse).forEach((name) => {
        const index = findStopIndexByName(stops, name);
        if (index >= 0) states[index].cancelled = true;
    });

    const title = String(data?.subTitle || '').trim();
    const cancelledRange = title.match(/treno\s+cancellato\s+da\s+(.+?)\s+a\s+(.+?)(?:\.|$)/i);
    if (!cancelledRange) return states;

    const fromName = cancelledRange[1].trim();
    const toName = cancelledRange[2].trim();
    const startsFrom = title.match(/parte\s+da\s+(.+?)(?:\.|$)/i);
    const arrivesAt = title.match(/arriva\s+a\s+(.+?)(?:\.|$)/i);
    const hasTrainChange = /viaggio\s+con\s+cambio\s+di\s+treno/i.test(title);

    if (startsFrom) {
        const anchorIndex = findStopIndexByName(stops, startsFrom[1]) >= 0
            ? findStopIndexByName(stops, startsFrom[1])
            : findStopIndexByName(stops, toName);
        if (anchorIndex >= 0) {
            for (let i = 0; i < anchorIndex; i += 1) states[i].cancelled = true;
            states[anchorIndex].boundary = 'actualStart';
        }
        return states;
    }

    if (arrivesAt) {
        const anchorIndex = findStopIndexByName(stops, arrivesAt[1]) >= 0
            ? findStopIndexByName(stops, arrivesAt[1])
            : findStopIndexByName(stops, fromName);
        if (anchorIndex >= 0) {
            for (let i = anchorIndex + 1; i < states.length; i += 1) states[i].cancelled = true;
            states[anchorIndex].boundary = 'actualEnd';
        }
        return states;
    }

    if (hasTrainChange) {
        const fromIndex = findStopIndexByName(stops, fromName);
        const toIndex = findStopIndexByName(stops, toName);
        if (fromIndex >= 0 && toIndex >= 0 && fromIndex < toIndex) {
            for (let i = fromIndex; i < toIndex; i += 1) states[i].cancelled = true;
            states[toIndex].boundary = 'replacementStart';
        } else if (toIndex >= 0) {
            states[toIndex].boundary = 'replacementStart';
        } else if (states.length && normalizeStationMatchName(stops[0]?.stazione) === normalizeStationMatchName(toName)) {
            states[0].boundary = 'replacementStart';
        }
    }

    return states;
}




function readRecentSearches(): RecentSearchItem[] {
    const raw = JSON.parse(localStorage.getItem('recentSearches') || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is RecentSearchItem => {
        const record = asRecord(item);
        return typeof record.id === 'string'
            && typeof record.name === 'string'
            && (record.type === 'train' || record.type === 'station');
    });
}

function writeRecentSearches(items: RecentSearchItem[]): void {
    localStorage.setItem('recentSearches', JSON.stringify(items.slice(0, 5)));
}

function saveRecentSearch(trainNumber: string, trainInfo: TrainData): void {
    try {
        let recentSearches = readRecentSearches();

        const searchItem: RecentSearchItem = {
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

        writeRecentSearches(recentSearches);
        renderRecentSearches();
    } catch (err) {
        console.error('Failed to save recent search:', err);
    }
}


function saveRecentStationSearch(stationId: string | number, stationName: string): void {
    try {
        let recentSearches = readRecentSearches();

        const searchItem: RecentSearchItem = {
            id: String(stationId),
            name: stationName,
            type: 'station',
            timestamp: Date.now()
        };

        recentSearches = recentSearches.filter(item => !(item.type === 'station' && item.id === String(stationId)));
        recentSearches.unshift(searchItem);

        if (recentSearches.length > 5) {
            recentSearches = recentSearches.slice(0, 5);
        }

        writeRecentSearches(recentSearches);
        renderRecentSearches();
    } catch (err) {
        console.error('Failed to save recent station search:', err);
    }
}


function loadRecentSearches(): void {
    try {

        const oldData = localStorage.getItem('recentTrains');
        if (oldData && !localStorage.getItem('recentSearches')) {
            const oldSearches = JSON.parse(oldData);
            const newSearches = (Array.isArray(oldSearches) ? oldSearches : []).map((item: unknown) => {
                const record = asRecord(item);
                return {
                    id: record.number,
                    name: `${record.number || ''} ${record.origin || ''} → ${record.destination || ''}`.trim(),
                    type: 'train',
                    timestamp: record.timestamp
                };
            });
            localStorage.setItem('recentSearches', JSON.stringify(newSearches));
            localStorage.removeItem('recentTrains');
        }

        const recentSearches = readRecentSearches();
        if (recentSearches.length > 0) {
            renderRecentSearches();
        }
    } catch (err) {
        console.error('Failed to load recent searches:', err);
    }
}


function renderRecentSearches(): void {
    try {
        const recentSearches = readRecentSearches();
        const container = document.getElementById('recentSearchesContainer');
        const chipsContainer = document.getElementById('recentSearchesChips');
        if (!container || !chipsContainer) return;

        if (recentSearches.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        clearNode(chipsContainer);

        recentSearches.forEach(item => {
            const chip = document.createElement('div');
            chip.className = 'assist-chip';


            const icon = item.type === 'station' ? 'location_on' : 'train';

            chip.append(
                createIcon(icon, 'material-symbols-outlined chip-icon'),
                createNode('span', { className: 'chip-label', text: item.name }),
                createNode('span', { className: 'chip-remove' }, [
                    createIcon('close')
                ])
            );
            chip.querySelector('.chip-remove')?.addEventListener('click', (e) => {
                removeRecentSearch(item.id, item.type, e);
            });

            chip.querySelector('.chip-label')?.addEventListener('click', () => {
                if (item.type === 'train') {
                    if (searchMode !== 'train') {
                        switchSearchMode('train');
                    }
                    const trainSearch = document.getElementById('trainSearch') as HTMLInputElement | null;
                    if (trainSearch) trainSearch.value = item.id;
                    startSearch(item.id);
                } else if (item.type === 'station') {
                    navigateToStationBoard(item.id, item.name);
                }
            });

            chipsContainer.appendChild(chip);
        });
    } catch (err) {
        console.error('Failed to render recent searches:', err);
    }
}


function removeRecentSearch(id: string, type: SearchMode, event?: Event): void {
    if (event) {
        event.stopPropagation();
    }

    try {
        let recentSearches = readRecentSearches();
        recentSearches = recentSearches.filter(item => !(item.id === id && item.type === type));
        writeRecentSearches(recentSearches);
        renderRecentSearches();
    } catch (err) {
        console.error('Failed to remove recent search:', err);
    }
}



async function startSearch(input: string, options: SearchOptions = {}): Promise<void> {
    const resultsPanel = document.getElementById('results');
    const disambiguationPanel = document.getElementById('disambiguation');
    if (resultsPanel) resultsPanel.style.display = 'none';
    if (disambiguationPanel) disambiguationPanel.style.display = 'none';

    if (searchMode === 'train') {

        const trainNumber = input.replace(/\D+/g, '').trim();

        if (!trainNumber) {
            const msg = window.currentLang === 'zh' ? "请输入有效的车次号" :
                window.currentLang === 'it' ? "Inserire un numero di treno valido" :
                    "Please enter a valid train number";
            return alert(msg);
        }

        try {
            const autoRes = await fetch(`${API_BASE}/cercaNumeroTrenoTrenoAutocomplete/${trainNumber}`);
            const autoText = await autoRes.text();
            if (!autoText.trim()) {
                return loadItaloDetailsOrAlert(trainNumber, options);
            }

            const lines = autoText.trim().split('\n');
            if (lines.length > 1) {
                showDisambiguation(lines, options);
            } else {
                fetchDetails(lines[0].split('|')[1], options);
            }
        } catch (err) {
            const loaded = await fetchItaloDetails(trainNumber, options);
            if (loaded) return;
            const msg = window.currentLang === 'zh' ? "搜索失败" :
                window.currentLang === 'it' ? "Ricerca fallita" :
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



function showDisambiguation(lines: string[], options: SearchOptions = {}): void {
    disambiguationData = lines;
    disambiguationUrlMode = options.urlMode || 'push';
    renderDisambiguation();
}

function renderDisambiguation(): void {
    if (!disambiguationData) return;

    const list = document.getElementById('choicesList');
    const panel = document.getElementById('disambiguation');
    if (!list || !panel) return;
    clearNode(list);

    disambiguationData.forEach(line => {
        const [label, triple] = line.split('|');
        const [tNum, sID, ts] = triple.split('-');
        const dateObj = new Date(parseInt(ts));
        const dateStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Rome' });

        const div = document.createElement('div');
        div.className = 'choice-item ripple';
        div.append(
            createNode('div', {
                text: label,
                style: { fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--color-primary)' }
            }),
            createNode('div', {
                style: { fontSize: '0.9rem', color: 'var(--color-base-content)', opacity: '0.6', marginTop: '4px' }
            }, [
                createIcon('calendar_month', 'material-symbols-outlined', {
                    style: { fontSize: '14px', verticalAlign: 'middle' }
                }),
                ` ${translations[window.currentLang].depart_date}: ${dateStr} | `,
                createIcon('location_on', 'material-symbols-outlined', {
                    style: { fontSize: '14px', verticalAlign: 'middle' }
                }),
                ` ${translations[window.currentLang].origin_station}: ${sID}`
            ])
        );
        div.addEventListener('click', () => {
            panel.style.display = 'none';
            disambiguationData = null;
            fetchDetails(triple, { urlMode: disambiguationUrlMode });
        });
        list.appendChild(div);
    });
    panel.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}


function showStationDisambiguation(stations: StationSearchResult[]): void {
    const list = document.getElementById('choicesList');
    const panel = document.getElementById('disambiguation');
    if (!list || !panel) return;
    const panelTitle = panel.querySelector('h3');

    const titleText = window.currentLang === 'zh' ? '选择车站：' :
        window.currentLang === 'it' ? 'Seleziona stazione:' :
            'Select station:';
    if (panelTitle) panelTitle.textContent = titleText;

    clearNode(list);

    stations.forEach(station => {
        const div = document.createElement('div');
        div.className = 'choice-item ripple';
        div.append(createNode('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px' }
        }, [
            createIcon('location_on', 'material-symbols-outlined', {
                style: { fontSize: '24px', color: 'var(--color-primary)' }
            }),
            createNode('div', {}, [
                createNode('div', {
                    text: station.nomeLungo,
                    style: { fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--color-primary)' }
                }),
                createNode('div', {
                    text: `ID: ${station.id}`,
                    style: { fontSize: '0.9rem', color: 'var(--color-base-content)', opacity: '0.6', marginTop: '2px' }
                })
            ])
        ]));
        div.addEventListener('click', () => {
            panel.style.display = 'none';
            saveRecentStationSearch(station.id, station.nomeLungo);
            navigateToStationBoard(station.id, station.nomeLungo);
        });
        list.appendChild(div);
    });

    panel.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}


async function loadItaloDetailsOrAlert(trainNumber: string, options: SearchOptions = {}): Promise<void> {
    const loaded = await fetchItaloDetails(trainNumber, options);
    if (loaded) return;

    const msg = window.currentLang === 'zh' ? "未找到该车次" :
        window.currentLang === 'it' ? "Treno non trovato" :
            "Train not found";
    alert(msg);
}

async function fetchItaloDetails(trainNumber: string, options: SearchOptions = {}): Promise<boolean> {
    const cleanTrainNumber = String(trainNumber || '').replace(/\D+/g, '');
    if (!cleanTrainNumber || !ITALO_TRAIN_BASE) return false;

    currentTriple = null;
    currentItaloTrainNumber = cleanTrainNumber;
    currentSmartCaringData = null;
    currentTrenordLineInfo = null;
    currentSwissFormationData = null;
    swissRequestSeq++;

    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
    if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();

    try {
        const res = await fetch(`${ITALO_TRAIN_BASE}?number=${encodeURIComponent(cleanTrainNumber)}`, {
            headers: { accept: 'application/json' }
        });
        if (!res.ok) return false;

        const data = asRecord(await res.json()) as TrainData & { available?: boolean; reason?: string };
        if (data.available === false || data.provider !== 'italo') return false;

        currentTrainData = data;
        currentTrainCategory = resolveTrainCategory(data);
        render(data);
        applyTrainSearchUrl(`train=${encodeURIComponent(cleanTrainNumber)}`, options.urlMode || 'push');
        lastLoadedTrainSearch = `train=${encodeURIComponent(cleanTrainNumber)}`;
        saveRecentSearch(`AV ${cleanTrainNumber}`, data);
        return true;
    } catch (error) {
        console.error('Italo train detail fetch failed:', error);
        return false;
    }
}



async function fetchDetails(triple: string, options: SearchOptions = {}): Promise<void> {
    if (!parseTrainTriple(triple)) return;
    currentItaloTrainNumber = null;
    currentTriple = triple;
    currentSmartCaringData = null;
    currentTrenordLineInfo = null;
    currentSwissFormationData = null;
    const requestSeq = ++swissRequestSeq;
    const scCard = document.getElementById('smartCaringCard');
    if (scCard) scCard.style.display = 'none';
    if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
    const [tNum, originID, ts] = triple.split('-');
    try {
        const res = await fetch(`${API_BASE}/andamentoTreno/${originID}/${tNum}/${ts}`);
        if (res.status === 204) {
            const msg = window.currentLang === 'zh' ? "该班次暂无实时数据（可能已过期或尚未生成）" :
                window.currentLang === 'it' ? "Nessun dato in tempo reale per questo treno (potrebbe essere scaduto o non ancora generato)" :
                    "No real-time data for this train (may be expired or not yet generated)";
            return alert(msg);
        }
        const data = asRecord(await res.json()) as TrainData;
        currentTrainData = data;
        currentTrainCategory = resolveTrainCategory(data);
        render(data);
        applyTrainTripleUrl(triple, options.urlMode || 'push');
        lastLoadedTrainSearch = trainTripleToSearch(triple);
        fetchTrafficInformation(data);
        loadSwissFormation(data, triple, requestSeq);


        const trainNumber = `${data.compCategoria || ''} ${data.numeroTreno || tNum}`.trim();
        saveRecentSearch(trainNumber, data);
    } catch (err) {
        const msg = window.currentLang === 'zh' ? "详情加载失败" :
            window.currentLang === 'it' ? "Impossibile caricare i dettagli" :
                "Failed to load details";
        alert(msg);
    }
}

async function loadSwissFormation(data: TrainData, triple: string, requestSeq: number): Promise<void> {
    if (!window.BelloSwiss || !window.BelloSwiss.fetchSwissEc || !window.BelloSwiss.shouldQuery(data, currentTrainCategory)) {
        if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
        return;
    }

    window.BelloSwiss.renderLoadingCard();

    try {
        const swissData = asRecord(await window.BelloSwiss.fetchSwissEc(data, currentTrainCategory)) as SwissFormationPayload;
        if (requestSeq !== swissRequestSeq || triple !== currentTriple) return;

        if (!swissData?.available) {
            currentSwissFormationData = null;
            window.BelloSwiss.hideFormationCard();
            if (currentTrainData) render(currentTrainData);
            return;
        }

        currentSwissFormationData = swissData;
        if (currentTrainData) render(currentTrainData);
    } catch (err) {
        if (requestSeq !== swissRequestSeq || triple !== currentTriple) return;
        console.error('Swiss formation fetch failed:', err);
        currentSwissFormationData = null;
        if (window.BelloSwiss) window.BelloSwiss.hideFormationCard();
        if (currentTrainData) render(currentTrainData);
    }
}


async function refreshTrainData(): Promise<void> {
    if (!currentTriple && !currentItaloTrainNumber) return;
    const refreshBtn = document.querySelector<HTMLElement>('.refresh-btn');
    if (refreshBtn) {
        refreshBtn.style.opacity = '0.5';
        refreshBtn.style.pointerEvents = 'none';
    }
    if (currentItaloTrainNumber) {
        await fetchItaloDetails(currentItaloTrainNumber, { urlMode: 'none' });
    } else if (currentTriple) {
        await fetchDetails(currentTriple, { urlMode: 'none' });
    }
    if (refreshBtn) {
        setTimeout(() => {
            refreshBtn.style.opacity = '1';
            refreshBtn.style.pointerEvents = 'auto';
        }, 1000);
    }
}

function getDefaultRouteDisplay(data: TrainData): { origin: string | undefined; destination: string | undefined } {
    return {
        origin: (data.origineEstera && data.origineEstera !== data.destinazione) ? data.origineEstera : data.origine,
        destination: (data.destinazioneEstera && data.destinazioneEstera !== data.origine) ? data.destinazioneEstera : data.destinazione
    };
}

function resolveRouteDisplay(data: TrainData, timelineStops: TrainStop[]): { origin: string | undefined; destination: string | undefined } {
    const fallback = getDefaultRouteDisplay(data);
    const stops = Array.isArray(timelineStops) ? timelineStops : [];
    const hasSwissData = currentSwissFormationData?.available && stops.some((stop) => stop.source === 'swiss' || stop.swissStop);
    if (!hasSwissData || stops.length < 2) return fallback;

    const displayableStops = stops.filter((stop) => {
        if (!stop?.stazione) return false;
        const swissStop = asRecord(stop.swissStop || stop);
        return !(window.BelloSwiss?.isTechnicalSwissStop && window.BelloSwiss.isTechnicalSwissStop(swissStop));
    });

    const first = displayableStops[0] || stops[0];
    const last = displayableStops[displayableStops.length - 1] || stops[stops.length - 1];

    return {
        origin: first?.stazione || fallback.origin,
        destination: last?.stazione || fallback.destination
    };
}

function resolveDurationDisplay(data: TrainData, timelineStops: TrainStop[]): string {
    const fallback = formatDuration(data.compDurata);
    const stops = Array.isArray(timelineStops) ? timelineStops : [];
    const hasSwissData = currentSwissFormationData?.available && stops.some((stop) => stop.source === 'swiss' || stop.swissStop);
    if (!hasSwissData || stops.length < 2) return fallback;

    const displayableStops = stops.filter((stop) => {
        if (!stop?.stazione) return false;
        const swissStop = asRecord(stop.swissStop || stop);
        return !(window.BelloSwiss?.isTechnicalSwissStop && window.BelloSwiss.isTechnicalSwissStop(swissStop));
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


function normalizeTrainStops(stops: unknown): TrainStop[] {
    return Array.isArray(stops)
        ? stops.map((stop) => asRecord(stop) as TrainStop)
        : [];
}


function render(data: TrainData): void {
    const resultsPanel = document.getElementById('results');
    const card = document.getElementById('trainCard');
    const timeline = document.getElementById('timelineBody');
    if (!resultsPanel || !card || !timeline) return;

    resultsPanel.style.display = 'block';
    const timelineStops = normalizeTrainStops(window.BelloSwiss && currentSwissFormationData?.available
        ? window.BelloSwiss.mergeTimelineStops(data.fermate || [], currentSwissFormationData)
        : (data.fermate || []));

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

    const clientCode = String(data.codiceCliente ?? '');
    let operator = CLIENT_MAP[clientCode] || "Other";
    let operatorLink = CLIENT_LINK_MAP[operator] || "#";


    if (catCode === "TS") {
        operator = "Fondazione FS";
        operatorLink = "https://www.fondazionefs.it";
    }

    const category = CAT_MAP[catCode] || data.categoriaDescrizione || catCode || "Treno";

    const imageKey = `${data.codiceCliente}-${catCode}`;
    let categoryImage = CAT_IMAGE_MAP[imageKey];


    if (data.codiceCliente === 77) {
        categoryImage = "pic/TTI.png";
    }

    if (operator === "Trenord" && currentSwissFormationData?.available && ['REG', 'RE', 'RV', 'S'].includes(catCode)) {
        categoryImage = "pic/Tilo.png";
    }

    const routeDisplay = resolveRouteDisplay(data, timelineStops);
    const displayOrigin = routeDisplay.origin;
    const displayDest = routeDisplay.destination;
    const delayMsg = translateStatus((data.compRitardoAndamento ?? [])[0] ?? '');
    const isEarly = delayMsg.includes(translations[window.currentLang].early_by) ||
        delayMsg.includes(translations[window.currentLang].on_time) ||
        delayMsg.toLowerCase().includes("anticipo") ||
        delayMsg.toLowerCase().includes("orario") ||
        delayMsg.toLowerCase().includes("early");

    const formattedDuration = resolveDurationDisplay(data, timelineStops);


    const badgeClass = window.getBadgeClass ? window.getBadgeClass(catCode) : '';

    clearNode(card);

    const refreshBtn = createNode('button', {
        className: 'refresh-btn',
        title: window.currentLang === 'zh' ? '刷新' : window.currentLang === 'it' ? 'Aggiorna' : 'Refresh',
        type: 'button'
    }, [createIcon('refresh')]);
    refreshBtn.addEventListener('click', refreshTrainData);

    const operatorNode = operatorLink !== "#"
        ? createNode('a', {
            text: operator,
            href: operatorLink,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: 'inherit', textDecoration: 'none' }
        })
        : document.createTextNode(operator);
    const categoryNode = categoryImage
        ? createNode('img', {
            className: getCategoryLogoClass(categoryImage),
            attrs: { src: categoryImage, alt: category },
            style: { height: '1.3rem', verticalAlign: 'middle', marginLeft: '8px' }
        })
        : document.createTextNode(category);

    const opCatRow = createNode('div', {
        className: 'op-cat-row',
        style: { display: 'flex', alignItems: 'center', gap: '8px' }
    }, [
        operatorNode,
        createNode('span', { className: 'opacity-50', text: '·' }),
        categoryNode
    ]);

    const trainNumBadge = badgeClass
        ? createNode('span', { className: `train-badge ${badgeClass}`, text: data.compNumeroTreno })
        : createNode('b', { text: data.compNumeroTreno });

    const trainNumberChildren = [
        createNode('span', { className: 'train-meta-label', text: `${translations[window.currentLang].train_num}: ` }),
        trainNumBadge
    ];
    const trenordLineBadge = createTrenordLineBadge(getCurrentTrenordLineForTrain(data));
    if (trenordLineBadge) trainNumberChildren.push(trenordLineBadge);

    const trainMeta = createNode('div', { className: 'train-meta flex items-center gap-3 flex-wrap' }, [
        createNode('span', { className: 'train-number-meta flex items-center gap-2 text-sm uppercase tracking-wider font-semibold' }, trainNumberChildren),
        createNode('span', { className: 'opacity-30', text: '|' }),
        createNode('span', { className: 'flex items-center gap-1' }, [
            createIcon('schedule', 'material-symbols-outlined text-[16px] opacity-60'),
            createNode('b', { text: formattedDuration })
        ])
    ]);

    const routeNode = createNode('div', { className: 'train-route mb-2' }, [
        displayOrigin,
        createIcon('arrow_forward', 'opacity-40 font-normal material-symbols-outlined align-middle mx-1'),
        displayDest
    ]);

    const statusNode = createNode('div', { className: 'train-status-section' }, [
        createNode('div', { className: `train-delay tabular-nums ${isEarly ? '' : 'late'}`.trim(), text: delayMsg }),
        createNode('div', { className: 'train-last-position flex items-start sm:items-center gap-1 justify-start sm:justify-end' }, [
            createIcon('location_on', 'material-symbols-outlined mt-[2px] sm:mt-0', {
                style: { fontSize: '12px' }
            }),
            `${data.stazioneUltimoRilevamento || '--'} (${data.compOraUltimoRilevamento || '--:--'})`
        ])
    ]);

    const infoWrapper = createNode('div', { className: 'train-info-wrapper flex flex-col sm:flex-row items-start gap-3 mt-2' }, [
        createNode('div', { className: 'flex-1 min-w-0' }, [routeNode, trainMeta]),
        statusNode
    ]);

    card.append(refreshBtn, opCatRow, infoWrapper);


    if (data.subTitle && data.subTitle.trim()) {
        card.append(createNode('div', { className: 'alert-box' }, [
            createIcon('campaign', 'material-symbols-outlined', { style: { fontSize: '20px' } }),
            createNode('span', { text: data.subTitle })
        ]));
    }


    clearNode(timeline);

    let lastReachedIdx = -1;

    if (!data.nonPartito) {
        timelineStops.forEach((f, i) => {
            if (f.arrivoReale !== null || f.partenzaReale !== null) lastReachedIdx = i;
        });
    }

    const totalStations = timelineStops.length;
    const partialCancellationStates = buildPartialCancellationState(data, timelineStops);

    timelineStops.forEach((f, i) => {
        const isLast = i === totalStations - 1;
        const isFirst = i === 0;
        const isSwissStop = f.source === 'swiss';
        const partialState = partialCancellationStates[i] || { cancelled: false, boundary: '' };
        const nextPartialState = partialCancellationStates[i + 1] || { cancelled: false, boundary: '' };

        let dotClass = 'dot-future';
        let lineClass = 'line-future';

        if (partialState.cancelled) {
            dotClass = 'dot-cancelled';
        } else if (lastReachedIdx >= 0) {
            if (i < lastReachedIdx) {
                dotClass = 'dot-passed';
                lineClass = 'line-passed';
            } else if (i === lastReachedIdx) {
                dotClass = 'dot-current';
                lineClass = 'line-future';
            }
        }

        if (!isLast && (partialState.cancelled || nextPartialState.cancelled)) {
            lineClass = 'line-cancelled';
        }

        const stationItemClasses = ['station-item', dotClass, lineClass];
        if (isSwissStop) stationItemClasses.push('station-source-swiss');
        if (partialState.cancelled) stationItemClasses.push('station-cancelled');
        if (partialState.boundary) stationItemClasses.push('station-partial-boundary');

        const pPlat = f.binarioProgrammatoPartenzaDescrizione || f.binarioProgrammatoArrivoDescrizione;
        const ePlat = f.binarioEffettivoPartenzaDescrizione || f.binarioEffettivoArrivoDescrizione;
        const platformNode = createNode('span', { className: 'plat-normal', text: ePlat || pPlat || "--" });

        const stayMinutes = (f.partenza_teorica && f.arrivo_teorico) ? Math.round((f.partenza_teorica - f.arrivo_teorico) / 60000) : null;
        const stayTime = stayMinutes ? `${stayMinutes} ${translations[window.currentLang].minutes}` : "N/A";

        let directionBadge = null;
        if (f.orientamento) {
            let directionText = '';
            if (f.orientamento === 'A') {
                directionText = `Executive ${translations[window.currentLang].in_tail}`;
            } else if (f.orientamento === 'B') {
                directionText = `Executive ${translations[window.currentLang].in_head}`;
            } else {
                directionText = f.orientamento;
            }
            directionBadge = createNode('span', { className: 'direction-badge', text: directionText });
        }

        const sourceBadge = isSwissStop
            ? createNode('span', { className: 'source-badge source-badge-swiss', text: translations[window.currentLang].swiss_source || 'CH' })
            : null;
        const stationNameNode = isSwissStop
            ? createNode('span', { className: 'station-name-static', text: f.stazione })
            : createNode('span', {
                className: 'station-link',
                text: f.stazione,
                dataset: { stationId: f.id || '', stationName: f.stazione || '' }
            });
        const partialBadge = partialState.cancelled
            ? createNode('span', { className: 'partial-stop-badge partial-stop-cancelled', text: partialStopLabel('cancelled') })
            : partialState.boundary
                ? createNode('span', { className: 'partial-stop-badge', text: partialStopLabel(partialState.boundary) })
                : null;

        const stationNameRow = createNode('div', {
            className: 'station-name group-hover:text-primary transition-colors flex items-center flex-wrap'
        }, [stationNameNode, sourceBadge, partialBadge]);

        if (!isFirst && !isLast && stayTime !== "N/A") {
            stationNameRow.append(createNode('span', {
                className: 'hidden sm:flex opacity-50 text-[0.85rem] font-medium items-center gap-0.5 ml-2 tracking-normal',
                style: { fontFamily: 'var(--font-sans)' }
            }, [
                createIcon('hourglass_empty', 'material-symbols-outlined icon-hourglass-desktop'),
                ` ${stayTime}`
            ]));
        }

        const stationNameColChildren = [stationNameRow];
        if (directionBadge) {
            stationNameColChildren.push(createNode('div', { className: 'flex items-center gap-2 mt-1 flex-wrap' }, [directionBadge]));
        }

        const timeColChildren = [];
        if (!isFirst) {
            timeColChildren.push(renderTimeNode('arrival', (f.arrivo_teorico || f.programmata), f.arrivoReale, f.ritardoArrivo));
        }
        if (!isLast) {
            timeColChildren.push(renderTimeNode('departure', (f.partenza_teorica || f.programmata), f.partenzaReale, f.ritardoPartenza));
        }

        const platformChildren = [];
        if (!isFirst && !isLast && stayTime !== "N/A") {
            platformChildren.push(createNode('div', {
                className: 'flex sm:hidden items-center justify-center gap-0.5 opacity-60 text-[0.8rem] font-medium tracking-normal mb-3',
                style: { fontFamily: 'var(--font-sans)' }
            }, [
                createIcon('hourglass_empty', 'material-symbols-outlined icon-hourglass-mobile'),
                ` ${stayTime}`
            ]));
        }
        platformChildren.push(
            createNode('div', { className: 'text-[0.8rem] uppercase tracking-wider font-semibold opacity-60 mb-1.5', text: translations[window.currentLang].platform }),
            createNode('div', { className: 'text-2xl' }, [platformNode]),
            isSwissStop
                ? createNode('div', {
                    className: 'text-[0.65rem] font-mono opacity-40 mt-2',
                    text: 'CH',
                    title: 'opentransportdata.swiss'
                })
                : createNode('div', {
                    className: 'text-[0.65rem] font-mono opacity-30 mt-2',
                    text: `P:${f.progressivo || '--'}`,
                    title: 'Progressivo'
                })
        );

        const stationItem = createNode('div', {
            className: `${stationItemClasses.join(' ')} stagger-item animate-fade-in`
        }, [
            createNode('div', { className: 'station-dot-wrapper' }, [
                createNode('div', { className: 'station-dot' })
            ]),
            createNode('div', { className: 'station-card glass-border shadow-glass hover:bg-base-content/5 transition-colors group' }, [
                createNode('div', { className: 'station-name-col' }, stationNameColChildren),
                createNode('div', { className: 'station-time-col tabular-nums' }, timeColChildren),
                createNode('div', { className: 'station-plat-col flex flex-col items-center justify-center' }, platformChildren)
            ])
        ]);
        stationItem.style.setProperty('--stagger-idx', String(i));
        timeline.appendChild(stationItem);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
}


const SC_SKIP_CATS = ['IC', 'ICN', 'EC', 'EN'];
const SC_FULL_CATS = ['FR', 'FA', 'FB'];
const DESC_TO_CAT: Record<string, string> = {
    'FRECCIAROSSA': 'FR', 'FRECCIARGENTO': 'FA', 'FRECCIABIANCA': 'FB',
    'INTERCITY': 'IC', 'INTERCITY NOTTE': 'ICN',
    'REGIONALE': 'REG', 'REGIONALE VELOCE': 'RV', 'METROPOLITANO': 'MET',
    'EUROCITY': 'EC', 'EURONIGHT': 'EN'
};

function resolveTrainCategory(data: TrainData): string {
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

function isTrenordTrain(data: TrainData | null): boolean {
    if (!data) return false;
    if (Number(data?.codiceCliente) === 63) return true;
    const clientMap = window.CLIENT_MAP || {};
    const clientCode = String(data.codiceCliente ?? '');
    const operator = clientMap[clientCode];
    return String(operator || '').toUpperCase() === 'TRENORD';
}

function getCurrentTrainNumber(data: TrainData | null): string {
    return String(data?.numeroTreno || '').replace(/\D+/g, '');
}

function normalizeTrenordLineCode(line: unknown): string {
    return String(line || '').trim().toUpperCase().replace(/\s+/g, '').replace(/-/g, '_');
}

function resolveTrenordLineBadgeSpec(line: unknown): { label: string; color: string; textColor: string } | null {
    const rawCode = normalizeTrenordLineCode(line);
    if (!rawCode) return null;

    const compactCode = rawCode.replace(/_/g, '');
    const aliasCode = TRENORD_LINE_ALIASES[compactCode] || compactCode;
    let color = TRENORD_LINE_COLORS[aliasCode] || TRENORD_LINE_COLORS[compactCode];

    if (/^RE0*80$/.test(compactCode)) {
        color = TRENORD_LINE_COLORS.RE80;
    } else if (aliasCode.startsWith('MXP')) {
        color = TRENORD_LINE_COLORS.MXP;
    } else if (!color && compactCode.startsWith('RE')) {
        color = TRENORD_LINE_COLORS.RE;
    } else if (!color && /^R\d*$/.test(compactCode)) {
        color = TRENORD_LINE_COLORS.R;
    }

    if (!color) color = '#69737f';
    return {
        label: aliasCode,
        color,
        textColor: getReadableBadgeTextColor(color)
    };
}

function getReadableBadgeTextColor(hexColor: unknown): string {
    const hex = String(hexColor || '').replace('#', '');
    if (!/^[\da-f]{6}$/i.test(hex)) return '#ffffff';
    const red = parseInt(hex.slice(0, 2), 16);
    const green = parseInt(hex.slice(2, 4), 16);
    const blue = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.299 * red) + (0.587 * green) + (0.114 * blue);
    return luminance > 150 ? '#111827' : '#ffffff';
}

function createTrenordLineBadge(line: unknown): HTMLSpanElement | null {
    const spec = resolveTrenordLineBadgeSpec(line);
    if (!spec) return null;
    return createNode('span', {
        className: 'trenord-line-badge',
        text: spec.label,
        title: `Trenord line ${spec.label}`,
        style: {
            backgroundColor: spec.color,
            color: spec.textColor
        },
        attrs: { 'aria-label': `Trenord line ${spec.label}` }
    });
}

function getCurrentTrenordLineForTrain(data: TrainData): string | null {
    if (!isTrenordTrain(data)) return null;
    const trainNumber = getCurrentTrainNumber(data);
    if (!trainNumber || currentTrenordLineInfo?.trainNumber !== trainNumber) return null;
    if (currentTrenordLineInfo?.date !== getTrainOperationDate(data)) return null;
    return currentTrenordLineInfo.line || null;
}

function rememberTrenordLine(trainNumber: string, date: string, line: unknown): void {
    const lineCode = normalizeTrenordLineCode(line);
    if (!trainNumber || !lineCode) return;
    currentTrenordLineInfo = { trainNumber, date, line: lineCode };
    upsertTrenordLineBadge(lineCode);
}

function upsertTrenordLineBadge(line: unknown): void {
    const meta = document.querySelector('.train-number-meta');
    if (!meta) return;

    meta.querySelector('.trenord-line-badge')?.remove();
    if (!currentTrainData || !isTrenordTrain(currentTrainData)) return;

    const badge = createTrenordLineBadge(line);
    if (badge) meta.append(badge);
}

function todayInRome(): string {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function getTrainOperationDate(data: TrainData): string {
    if (data?.dataPartenzaTrenoAsDate && /^\d{4}-\d{2}-\d{2}$/.test(data.dataPartenzaTrenoAsDate)) {
        return data.dataPartenzaTrenoAsDate;
    }

    const timestamp = Number(data?.dataPartenzaTreno || data?.dataPartenza);
    if (Number.isFinite(timestamp) && timestamp > 0) {
        return new Date(timestamp).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
    }

    return todayInRome();
}

function fetchTrafficInformation(data: TrainData): void {
    if (data.provider === 'italo') {
        const card = document.getElementById('smartCaringCard');
        if (card) card.style.display = 'none';
        currentSmartCaringData = null;
        return;
    }
    if (isTrenordTrain(data)) {
        fetchTrenordTrafficInformation(data);
        return;
    }
    fetchSmartCaring(data.numeroTreno);
}

async function fetchTrenordTrafficInformation(trainData: TrainData): Promise<void> {
    const card = document.getElementById('smartCaringCard');
    const trainNumber = getCurrentTrainNumber(trainData);
    const date = getTrainOperationDate(trainData);
    if (!card || !TRENORD_TRAFFIC_BASE || !trainNumber || !date) return;

    card.style.display = 'block';
    const t = translations[window.currentLang];
    clearNode(card);
    card.append(createNode('div', { className: 'sc-loading' }, [
        createNode('span', { className: 'loading loading-spinner loading-sm text-primary' }),
        createNode('span', { text: t.trenord_traffic_loading })
    ]));

    try {
        const requestUrl = `${TRENORD_TRAFFIC_BASE}?train=${encodeURIComponent(trainNumber)}&date=${encodeURIComponent(date)}`;
        const res = await fetch(requestUrl, { headers: { accept: 'application/json' } });
        const data = asRecord(await res.json()) as TrenordTrafficPayload;

        if (getCurrentTrainNumber(currentTrainData) !== trainNumber) return;
        if (data?.line) rememberTrenordLine(trainNumber, date, data.line);

        if (!res.ok) throw new Error(data?.reason || 'trenord_traffic_unavailable');
        if (data?.available === false) {
            card.style.display = 'none';
            currentSmartCaringData = null;
            return;
        }

        if (!data.direttriceDescription && !(data.notices || []).length) {
            card.style.display = 'none';
            currentSmartCaringData = null;
            return;
        }

        currentSmartCaringData = { ...data, provider: 'trenord-traffic' };
        renderTrenordTrafficInformation(currentSmartCaringData);
    } catch (e) {
        console.error('Trenord traffic information fetch failed:', e);
        card.style.display = 'none';
        currentSmartCaringData = null;
    }
}

async function fetchSmartCaring(trainNumber: string | number | null | undefined): Promise<void> {
    const card = document.getElementById('smartCaringCard');
    if (!card || !NOTIFY_BASE) return;

    if (SC_SKIP_CATS.includes(currentTrainCategory)) {
        card.style.display = 'none';
        currentSmartCaringData = null;
        return;
    }

    card.style.display = 'block';
    const t = translations[window.currentLang];
    clearNode(card);
    card.append(createNode('div', { className: 'sc-loading' }, [
        createNode('span', { className: 'loading loading-spinner loading-sm text-primary' }),
        createNode('span', { text: t.sc_loading })
    ]));

    try {
        const res = await fetch(`${NOTIFY_BASE}?train=${trainNumber}`);
        if (!res.ok) throw new Error('API error');
        const data = asRecord(await res.json()) as SmartCaringPayload;
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

function getShortMonth(date: Date, lang: Language): string {
    const m = date.getMonth();
    if (lang === 'zh') return `${m + 1}月`;
    const en = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const it = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
    return lang === 'it' ? it[m] : en[m];
}

function formatTrenordTrafficTitle(data: TrenordTrafficPayload): string {
    const t = translations[window.currentLang];
    const line = data?.direttriceDescription || data?.direttrice || 'Trenord';
    return String(t.trenord_traffic_title || '{line} line notices').replace('{line}', line);
}

function createTrenordTrafficTitleNodes(data: TrenordTrafficPayload): NodeChild[] {
    const t = translations[window.currentLang];
    const line = data?.direttriceDescription || data?.direttrice || 'Trenord';
    const template = String(t.trenord_traffic_title || 'Traffic information · {line}');
    if (!template.includes('{line}')) {
        return [createNode('span', { className: 'trenord-traffic-title-main', text: formatTrenordTrafficTitle(data) })];
    }

    const [before, ...afterParts] = template.split('{line}');
    const after = afterParts.join('{line}');
    const children: NodeChild[] = [];
    if (before) children.push(createNode('span', { className: 'trenord-traffic-title-main', text: before }));
    children.push(createNode('span', { className: 'trenord-traffic-line', text: line }));
    if (after) children.push(createNode('span', { className: 'trenord-traffic-title-main', text: after }));
    return children;
}

function formatTrenordNoticeDate(value: unknown): string {
    if (!value) return '';
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    const locale = window.currentLang === 'zh' ? 'zh-CN' : window.currentLang === 'it' ? 'it-IT' : 'en-GB';
    return new Intl.DateTimeFormat(locale, {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

function createTrenordNoticeLink(url: unknown, index: number, total: number): HTMLAnchorElement | null {
    const safeUrl = /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
    if (!safeUrl) return null;
    const t = translations[window.currentLang];
    const label = total > 1 ? `${t.trenord_notice_link} ${index + 1}` : t.trenord_notice_link;
    return createNode('a', {
        className: 'trenord-notice-link',
        text: label,
        href: safeUrl,
        target: '_blank',
        rel: 'noopener noreferrer'
    });
}

function renderTrenordTrafficInformation(data: TrenordTrafficPayload): void {
    const card = document.getElementById('smartCaringCard');
    if (!card || !data) return;

    const t = translations[window.currentLang];
    const notices = Array.isArray(data.notices) ? data.notices : [];
    const wasCollapsed = card.querySelector('.sc-body-wrap') === null
        ? true
        : card.querySelector('.sc-body-wrap.sc-collapsed') !== null;

    clearNode(card);

    const toggle = createIcon('expand_more', `material-symbols-outlined sc-toggle trenord-traffic-toggle${wasCollapsed ? '' : ' sc-rotated'}`);
    const header = createNode('button', { className: 'sc-header trenord-traffic-header', type: 'button' }, [
        createNode('span', { className: 'trenord-traffic-title' }, [
            createIcon('campaign'),
            createNode('span', { className: 'trenord-traffic-title-text' }, createTrenordTrafficTitleNodes(data))
        ]),
        createNode('span', { className: 'trenord-traffic-actions' }, [toggle])
    ]);

    const bodyChildren = [];
    if (notices.length) {
        const list = createNode('div', { className: 'trenord-notices-list' }, notices.map((notice: TrenordTrafficNotice) => {
            const severityLevel = notice.severityLevel || 'info';
            const severityText = notice.severityDescription || t.trenord_severity_info;
            const dateText = formatTrenordNoticeDate(notice.date);
            const urls = Array.isArray(notice.urls) ? notice.urls : [];
            const links = urls
                .map((url: unknown, index: number) => createTrenordNoticeLink(url, index, urls.length))
                .filter(Boolean);

            return createNode('div', { className: 'trenord-notice' }, [
                createNode('div', { className: 'trenord-notice-meta' }, [
                    createNode('span', {
                        className: `trenord-severity trenord-severity-${severityLevel}`,
                        text: severityText
                    }),
                    dateText ? createNode('span', { className: 'trenord-notice-date', text: dateText }) : null
                ]),
                createNode('div', { className: 'trenord-notice-description', text: notice.description }),
                links.length ? createNode('div', { className: 'trenord-notice-actions' }, links) : null
            ]);
        }));
        bodyChildren.push(list);
    } else {
        bodyChildren.push(createNode('div', { className: 'sc-empty trenord-empty' }, [
            createIcon('info', 'material-symbols-outlined', {
                style: { fontSize: '1.1rem', verticalAlign: 'middle', marginRight: '4px' }
            }),
            t.trenord_no_notices
        ]));
    }

    const bodyWrap = createNode('div', { className: `sc-body-wrap${wasCollapsed ? ' sc-collapsed' : ''}` }, [
        createNode('div', { className: 'sc-body trenord-traffic-body' }, bodyChildren)
    ]);

    header.addEventListener('click', () => {
        bodyWrap.classList.toggle('sc-collapsed');
        toggle.classList.toggle('sc-rotated');
        hideScTooltip();
    });

    card.append(header, bodyWrap);
    card.style.display = 'block';
}

function renderSmartCaring(data: SmartCaringPayload): void {
    const card = document.getElementById('smartCaringCard');
    if (!card || !data) return;

    const t = translations[window.currentLang];
    const isFullMode = SC_FULL_CATS.includes(currentTrainCategory);

    const todayNotices = data.today || [];
    const recentNotices = data.recent || [];
    const hasToday = todayNotices.length > 0;
    const hasRecent = recentNotices.length > 0;
    const notifTitle = hasToday ? t.sc_today : t.sc_recent;
    let notificationBody = null;

    if (hasToday) {
        notificationBody = createNode('div', { className: 'sc-notes-list' }, todayNotices.map((n: SmartCaringNotice) => {
            const time = new Date(n.insertTimestamp).toLocaleTimeString('it-IT', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
            });
            return createNode('div', { className: 'sc-note' }, [
                createNode('span', { className: 'sc-note-time', text: time }),
                createNode('span', { className: 'sc-note-text', text: n.infoNote })
            ]);
        }));
    } else if (hasRecent) {
        notificationBody = createNode('div', { className: 'sc-notes-list' }, recentNotices.map((n: SmartCaringNotice) => {
            const d = new Date(n.insertTimestamp);
            const monthStr = getShortMonth(d, window.currentLang);
            const dayNum = d.getDate();
            const dateStr = window.currentLang === 'zh' ? `${monthStr}${dayNum}号` : `${monthStr} ${dayNum}`;
            const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
            return createNode('div', { className: 'sc-note' }, [
                createNode('span', { className: 'sc-note-date', text: dateStr }),
                createNode('span', { className: 'sc-note-clock', text: time }),
                createNode('span', { className: 'sc-note-text', text: n.infoNote })
            ]);
        }));
    } else {
        notificationBody = createNode('div', { className: 'sc-empty' }, [
            createIcon('check_circle', 'material-symbols-outlined', {
                style: { fontSize: '1.1rem', verticalAlign: 'middle', marginRight: '4px' }
            }),
            t.sc_no_today
        ]);
    }

    let chartSection = null;
    let statsNode = null;

    if (isFullMode) {
        const now = new Date();
        const days: Array<{ date: Date; dateKey: string; delay: number; notifications: number; reasons: string[] }> = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const dateKey = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
            const histDay = data.history ? data.history.find((h: SmartCaringHistoryDay) => h.date === dateKey) : null;
            days.push({
                date: d,
                dateKey,
                delay: histDay?.maxDelay ?? 0,
                notifications: histDay?.notifications ?? 0,
                reasons: histDay?.reasons ?? []
            });
        }

        const maxDelay = Math.max(...days.map((d) => d.delay), 1);

        const chart = createNode('div', { className: 'sc-chart' });
        days.forEach((d) => {
            const barHeight = d.delay > 0 ? Math.max(18, Math.round((d.delay / maxDelay) * 48) + 8) : 6;
            let colorClass = 'sc-level-0';
            if (d.delay > 30) colorClass = 'sc-level-3';
            else if (d.delay > 15) colorClass = 'sc-level-2';
            else if (d.delay > 0) colorClass = 'sc-level-1';

            const dayNum = d.date.getDate();
            const monthAbbr = getShortMonth(d.date, window.currentLang);
            const tipDelay = d.delay > 0 ? `+${d.delay}min` : 'OK';
            const tipReason = (d.delay > 0 && d.reasons.length) ? d.reasons[0] : '';

            const monthLabel = createNode('span', { className: 'sc-bar-month', text: monthAbbr });
            const label = createNode('span', { className: 'sc-bar-label' }, [
                `${dayNum}`,
                createNode('br'),
                monthLabel
            ]);
            const col = createNode('button', {
                className: 'sc-bar-col',
                type: 'button',
                dataset: { delay: tipDelay, reason: tipReason }
            }, [
                createNode('span', {
                    className: `sc-bar ${colorClass}`,
                    style: { height: `${barHeight}px` }
                }),
                label
            ]);
            col.addEventListener('click', (event) => toggleScTooltip(event, col));
            chart.appendChild(col);
        });

        chartSection = createNode('div', { className: 'sc-history-section' }, [
            createNode('div', { className: 'sc-section-title', text: t.sc_history }),
            chart
        ]);

        const stats = data.stats || {};
        if ((stats.disruptedDays || 0) === 0) {
            statsNode = createNode('div', { className: 'sc-all-clear' }, [
                createIcon('verified'),
                createNode('span', { text: t.sc_all_clear })
            ]);
        } else {
            const onTimeRate = stats.onTimeRate ?? 0;
            const rateColor = onTimeRate >= 70 ? 'var(--color-info)' : onTimeRate >= 40 ? 'var(--color-warning)' : 'var(--color-error)';
            const statValue = (value: unknown, suffix = ''): HTMLSpanElement => {
                const valueNode = createNode('span', { className: 'sc-stat-value', text: value });
                if (suffix) valueNode.append(createNode('small', { text: suffix }));
                return valueNode;
            };
            const makeStat = (valueNode: HTMLElement, label: unknown): HTMLDivElement => createNode('div', { className: 'sc-stat' }, [
                valueNode,
                createNode('span', { className: 'sc-stat-label', text: label })
            ]);
            const onTimeValue = statValue(`${onTimeRate}%`);
            onTimeValue.style.color = rateColor;
            statsNode = createNode('div', { className: 'sc-stats-row' }, [
                makeStat(onTimeValue, t.sc_ontime_rate),
                makeStat(statValue(`${stats.disruptedDays}/${stats.totalDays}`), t.sc_disrupted),
                makeStat(statValue(stats.avgDelay, 'min'), t.sc_avg_delay),
                makeStat(statValue(stats.maxDelay, 'min'), t.sc_max_delay)
            ]);
        }
    }

    const wasCollapsed = card.querySelector('.sc-body-wrap') === null
        ? true  // first render: default collapsed
        : card.querySelector('.sc-body-wrap.sc-collapsed') !== null;

    clearNode(card);
    const toggle = createIcon('expand_more', `material-symbols-outlined sc-toggle${wasCollapsed ? '' : ' sc-rotated'}`);
    const header = createNode('button', { className: 'sc-header', type: 'button' }, [
        createIcon('campaign'),
        createNode('span', { text: t.sc_title }),
        toggle
    ]);
    const bodyWrap = createNode('div', { className: `sc-body-wrap${wasCollapsed ? ' sc-collapsed' : ''}` }, [
        createNode('div', { className: 'sc-body' }, [
            createNode('div', { className: 'sc-today-section' }, [
                createNode('div', { className: 'sc-section-title', text: notifTitle }),
                notificationBody
            ]),
            chartSection,
            statsNode
        ])
    ]);
    header.addEventListener('click', () => {
        bodyWrap.classList.toggle('sc-collapsed');
        toggle.classList.toggle('sc-rotated');
        hideScTooltip();
    });
    card.append(header, bodyWrap);
    card.style.display = 'block';
}

function toggleScTooltip(e: Event, col: HTMLElement): void {
    e.stopPropagation();
    const tooltip = document.getElementById('scTooltip');
    if (!tooltip) return;

    const wasActive = col.classList.contains('sc-active');
    const chart = col.closest('.sc-chart');
    if (!chart) return;
    chart.querySelectorAll('.sc-bar-col').forEach((c: Element) => c.classList.remove('sc-active'));
    if (wasActive) { hideScTooltip(); return; }

    col.classList.add('sc-active');

    const delay = col.dataset.delay || 'OK';
    const reason = col.dataset.reason || '';
    clearNode(tooltip);
    tooltip.append(createNode('span', { text: delay }));
    if (reason) tooltip.append(createNode('span', { className: 'sc-tooltip-reason', text: reason }));

    const bar = col.querySelector('.sc-bar');
    if (!bar) return;
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
    if (!isElementTarget(e.target) || !e.target.closest('.sc-bar-col')) hideScTooltip();
});
window.addEventListener('scroll', hideScTooltip, { passive: true });
window.addEventListener('resize', hideScTooltip);


function initApp() {


    updateSearchLabel();
    loadRecentSearches();
}

function bindHomeControls() {
    const homeLogoLink = document.getElementById('homeLogoLink');
    if (homeLogoLink && !homeLogoLink.dataset.btBound) {
        homeLogoLink.dataset.btBound = 'true';
        homeLogoLink.addEventListener('click', (event) => {
            event.preventDefault();
            goHome();
        });
    }

    const searchModeToggle = document.getElementById('searchModeToggle');
    if (searchModeToggle && !searchModeToggle.dataset.btBound) {
        searchModeToggle.dataset.btBound = 'true';
        searchModeToggle.addEventListener('click', () => {
            switchSearchMode(searchMode === 'train' ? 'station' : 'train');
        });
    }
}


document.addEventListener('astro:page-load', () => {
    initApp();
    bindHomeControls();
    fetchStatistiche();
    fetchInfomobilitaTicker();

    const trainInput = document.getElementById('trainSearch');
    if (trainInput) {
        trainInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const input = (e.currentTarget as HTMLInputElement).value.trim();
                if (input) startSearch(input);
            }
        });
    }

    if (!window._mainInitialized) {
        window._mainInitialized = true;

        document.addEventListener('click', (e) => {
            if (!isElementTarget(e.target) || (!e.target.closest('.lang-switch') && !e.target.closest('.theme-switch'))) {
                const langMenu = document.getElementById('langMenu');
                const themeMenu = document.getElementById('themeMenu');
                if (langMenu) langMenu.classList.remove('show');
                if (themeMenu) themeMenu.classList.remove('show');
            }
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (window.currentTheme === 'auto') {
                window.applyTheme?.();
            }
        });

        document.addEventListener('click', function (e) {
            const stationLink = isElementTarget(e.target) ? e.target.closest('.station-link') : null;
            if (stationLink) {
                const stationId = stationLink.getAttribute('data-station-id');
                const stationName = stationLink.getAttribute('data-station-name');
                if (stationId && stationName) {
                    navigateToStationBoard(stationId, stationName);
                }
            }
        });
    }
});

function loadTrainFromCurrentUrl(): void {
    const state = readTrainUrlState(window.location.search);
    if (!state) return;
    const search = trainStateToSearch(state);
    if (search && search === lastLoadedTrainSearch) return;

    const trainInput = document.getElementById('trainSearch') as HTMLInputElement | null;
    if (!trainInput) return;
    trainInput.value = state.trainNumber;

    setTimeout(() => {
        if (state.originId && state.timestamp) {
            fetchDetails(`${state.trainNumber}-${state.originId}-${state.timestamp}`, { urlMode: 'replace' });
            return;
        }
        startSearch(state.trainNumber, { urlMode: 'replace' });
    }, 200);
}

// astro:page-load 触发时 DOM 已完整就绪，无需轮询重试
document.addEventListener('astro:page-load', () => {
    loadTrainFromCurrentUrl();
});
