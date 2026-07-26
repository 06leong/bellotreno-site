import { rollingStockSeriesLabel } from '../lib/normalizers/lefrecce.ts';

type TranslationMap = Record<string, string>;

interface TrainStopLike {
    arrivo_teorico?: number | string | null;
    id?: number | string | null;
    partenza_teorica?: number | string | null;
    programmata?: number | string | null;
    stazione?: string | null;
}

export interface LeFrecceTrainLike {
    codiceCliente?: number | string | null;
    dataPartenzaTreno?: number | string | null;
    destinazione?: string | null;
    fermate?: TrainStopLike[] | null;
    numeroTreno?: number | string | null;
    origine?: string | null;
    provider?: string | null;
}

export interface LeFrecceOnboardItem {
    code: string;
    rawDescription: string;
}

export interface LeFrecceOnboardPayload {
    amenities: LeFrecceOnboardItem[];
    available: true;
    classServices: LeFrecceOnboardItem[];
    fetchedAt: string;
    notes: string[];
    operationDate: string;
    provider: 'trenitalia-lefrecce';
    rollingStock: {
        code: string;
        evidence: 'explicit';
        informationType: 'scheduled';
        label: string;
        rawDescription: string;
        series: string | null;
    } | null;
    serviceLevels: string[];
    trainNumber: string;
}

interface LeFrecceUnavailablePayload {
    available: false;
    provider: 'trenitalia-lefrecce';
    reason: string;
}

interface RollingStockImage {
    alt: string;
    height: number;
    src: string;
    width: number;
}

const TRENITALIA_ONBOARD_BASE = '/api/trenitalia/onboard';
const SUPPORTED_CATEGORIES = new Set(['FR', 'FA', 'FB', 'IC', 'ICN', 'EC', 'EN']);

export const ROLLING_STOCK_IMAGES: Readonly<Record<string, RollingStockImage>> = Object.freeze({
    'etr-1000': {
        alt: 'Frecciarossa ETR 1000',
        height: 1599,
        src: '/pic/ETR1000.webp',
        width: 2400
    },
    'etr-500': {
        alt: 'Frecciarossa ETR 500',
        height: 1600,
        src: '/pic/ETR500.webp',
        width: 2400
    },
    'etr-700': {
        alt: 'Frecciarossa ETR 700',
        height: 1600,
        src: '/pic/ETR700.webp',
        width: 2400
    },
    'etr-600': {
        alt: 'Frecciarossa ETR 600',
        height: 1599,
        src: '/pic/ETR600.webp',
        width: 2400
    },
    'giruno-rabe-501': {
        alt: 'Giruno RABe 501',
        height: 1600,
        src: '/pic/Giruno.webp',
        width: 2400
    }
});

const AMENITY_ICONS: Readonly<Record<string, string>> = Object.freeze({
    'wheelchair-accessible': 'accessible',
    bar: 'local_bar',
    restaurant: 'restaurant',
    minibar: 'room_service',
    bicycle: 'directions_bike',
    'seat-service': 'airline_seat_recline_normal'
});

const CLASS_SERVICE_ICONS: Readonly<Record<string, string>> = Object.freeze({
    'executive-meal': 'restaurant',
    'business-welcome': 'room_service',
    'business-catering': 'restaurant',
    'premium-catering': 'cookie'
});

function t(): TranslationMap {
    return window.translations?.[window.currentLang] || window.translations?.en || {};
}

function cardElement(): HTMLElement | null {
    return document.getElementById('trenitaliaOnboardCard');
}

function createNode<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className = '',
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name: string, className = 'material-symbols-outlined'): HTMLSpanElement {
    return createNode('span', className, name);
}

function timestampToIso(value: unknown): string | null {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const normalized = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function valueLabel(prefix: string, code: string, fallback: string): string {
    return t()[`${prefix}_${code.replaceAll('-', '_')}`] || fallback;
}

export function shouldQueryLeFrecceOnboard(data: LeFrecceTrainLike, category: string): boolean {
    if (String(data.provider || '').toLowerCase() === 'italo') return false;
    if (Number(data.codiceCliente) === 63) return false;
    return SUPPORTED_CATEGORIES.has(String(category || '').trim().toUpperCase());
}

function buildRequestUrl(data: LeFrecceTrainLike, operationDate: string): string | null {
    const stops = Array.isArray(data.fermate) ? data.fermate : [];
    const first = stops[0];
    const last = stops.at(-1);
    const number = String(data.numeroTreno || '').replace(/\D+/g, '');
    const departureAt = timestampToIso(
        first?.partenza_teorica
        ?? first?.programmata
        ?? data.dataPartenzaTreno
    );
    const arrivalAt = timestampToIso(last?.arrivo_teorico ?? last?.programmata);
    const originName = String(first?.stazione || data.origine || '').trim();
    const destinationName = String(last?.stazione || data.destinazione || '').trim();
    const originId = String(first?.id || '').trim();
    const destinationId = String(last?.id || '').trim();

    if (
        !number
        || !/^\d{4}-\d{2}-\d{2}$/.test(operationDate)
        || !departureAt
        || (!originId && !originName)
        || (!destinationId && !destinationName)
    ) {
        return null;
    }

    const params = new URLSearchParams({
        number,
        date: operationDate,
        departureAt,
        originId,
        originName,
        destinationId,
        destinationName
    });
    if (arrivalAt) params.set('arrivalAt', arrivalAt);
    return `${TRENITALIA_ONBOARD_BASE}?${params.toString()}`;
}

export async function fetchLeFrecceOnboard(
    data: LeFrecceTrainLike,
    category: string,
    operationDate: string
): Promise<LeFrecceOnboardPayload | LeFrecceUnavailablePayload> {
    if (!shouldQueryLeFrecceOnboard(data, category)) {
        return { available: false, provider: 'trenitalia-lefrecce', reason: 'unsupported_category' };
    }
    const url = buildRequestUrl(data, operationDate);
    if (!url) {
        return { available: false, provider: 'trenitalia-lefrecce', reason: 'missing_train_context' };
    }

    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
        return { available: false, provider: 'trenitalia-lefrecce', reason: `http_${response.status}` };
    }
    return await response.json() as LeFrecceOnboardPayload | LeFrecceUnavailablePayload;
}

export function hideLeFrecceOnboardCard(): void {
    const card = cardElement();
    if (!card) return;
    card.style.display = 'none';
    card.replaceChildren();
}

export function renderLeFrecceOnboardLoading(): void {
    const card = cardElement();
    if (!card) return;
    card.replaceChildren();
    card.style.display = 'block';
    const loading = createNode('div', 'onboard-loading');
    const spinner = createNode('span', 'loading loading-spinner loading-sm');
    spinner.setAttribute('aria-hidden', 'true');
    loading.append(spinner, createNode('span', '', t().onboard_loading || 'Loading onboard services…'));
    card.append(loading);
}

function createMedia(payload: LeFrecceOnboardPayload): HTMLElement {
    const media = createNode('div', 'onboard-media');
    const imageStage = createNode('div', 'onboard-image-stage');
    const fallback = createNode('div', 'onboard-media-fallback');
    fallback.append(icon('train', 'material-symbols-outlined onboard-media-icon'));
    imageStage.append(fallback);

    const imageSpec = payload.rollingStock
        ? ROLLING_STOCK_IMAGES[payload.rollingStock.code]
        : null;
    if (imageSpec) {
        const image = createNode('img', 'onboard-media-image');
        image.src = imageSpec.src;
        image.alt = imageSpec.alt;
        image.width = imageSpec.width;
        image.height = imageSpec.height;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => image.remove(), { once: true });
        imageStage.append(image);
    }

    const caption = createNode('div', 'onboard-stock-caption');
    const planned = createNode(
        'span',
        'onboard-planned-badge',
        t().onboard_planned_stock || 'Scheduled rolling stock'
    );
    const model = createNode(
        'strong',
        'onboard-stock-name',
        payload.rollingStock?.label || t().onboard_stock_unavailable || 'Not specified'
    );
    caption.append(planned, model);
    const series = rollingStockSeriesLabel(
        payload.rollingStock?.label || '',
        payload.rollingStock?.series || null
    );
    if (series) {
        caption.append(createNode('span', 'onboard-stock-series', series));
    }
    media.append(imageStage, caption);
    return media;
}

function createSection(title: string, items: Node[]): HTMLElement | null {
    if (items.length === 0) return null;
    const section = createNode('section', 'onboard-section');
    section.append(createNode('h4', 'onboard-section-title', title));
    const list = createNode('div', 'onboard-chip-list');
    list.append(...items);
    section.append(list);
    return section;
}

function createServiceLevelChip(code: string): HTMLElement {
    return createNode(
        'span',
        'onboard-chip onboard-level-chip',
        valueLabel('onboard_level', code, code)
    );
}

function createAmenityChip(item: LeFrecceOnboardItem): HTMLElement {
    const chip = createNode('span', 'onboard-chip onboard-amenity-chip');
    chip.title = item.rawDescription;
    chip.append(
        icon(AMENITY_ICONS[item.code] || 'check_circle'),
        createNode(
            'span',
            '',
            valueLabel('onboard_amenity', item.code, item.rawDescription)
        )
    );
    return chip;
}

function createClassServiceChip(item: LeFrecceOnboardItem): HTMLElement {
    const chip = createNode('span', 'onboard-chip onboard-class-chip');
    chip.title = item.rawDescription;
    chip.append(
        icon(CLASS_SERVICE_ICONS[item.code] || 'room_service'),
        createNode(
            'span',
            '',
            valueLabel('onboard_class', item.code, item.rawDescription)
        )
    );
    return chip;
}

function createNotes(notes: string[]): HTMLElement | null {
    if (notes.length === 0) return null;
    const details = createNode('details', 'onboard-notes');
    const summary = createNode(
        'summary',
        'onboard-notes-summary',
        t().onboard_other_notes || 'Other official information'
    );
    const list = createNode('ul', 'onboard-notes-list');
    for (const note of notes) list.append(createNode('li', '', note));
    details.append(summary, list);
    return details;
}

export function renderLeFrecceOnboardCard(payload: LeFrecceOnboardPayload): void {
    const card = cardElement();
    if (!card) return;
    const wasCollapsed = card.dataset.onboardCollapsed === 'true';
    card.replaceChildren();
    card.style.display = 'block';
    card.classList.toggle('onboard-collapsed', wasCollapsed);

    const title = createNode('div', 'onboard-title');
    title.append(
        icon('train'),
        createNode('span', '', t().onboard_title || 'Rolling stock and onboard services')
    );
    const toggle = createNode('button', 'onboard-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', wasCollapsed ? 'false' : 'true');
    toggle.setAttribute(
        'aria-label',
        t().onboard_toggle || 'Toggle rolling stock and onboard services'
    );
    toggle.append(icon(
        'expand_more',
        `material-symbols-outlined${wasCollapsed ? '' : ' onboard-rotated'}`
    ));
    const header = createNode('header', 'onboard-header');
    header.append(title, toggle);

    const details = createNode('div', 'onboard-details');
    const levels = createSection(
        t().onboard_service_levels || 'Service levels',
        payload.serviceLevels.map(createServiceLevelChip)
    );
    const amenities = createSection(
        t().onboard_amenities || 'Amenities',
        payload.amenities.map(createAmenityChip)
    );
    const classServices = createSection(
        t().onboard_class_services || 'Class services',
        payload.classServices.map(createClassServiceChip)
    );
    for (const section of [levels, amenities, classServices]) {
        if (section) details.append(section);
    }
    const notes = createNotes(payload.notes);
    if (notes) details.append(notes);

    const body = createNode('div', 'onboard-body');
    body.append(createMedia(payload), details);
    const bodyWrap = createNode(
        'div',
        `onboard-body-wrap${wasCollapsed ? ' onboard-body-collapsed' : ''}`
    );
    bodyWrap.append(body);
    card.append(header, bodyWrap);

    toggle.addEventListener('click', () => {
        const collapsed = bodyWrap.classList.toggle('onboard-body-collapsed');
        card.dataset.onboardCollapsed = collapsed ? 'true' : 'false';
        card.classList.toggle('onboard-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.querySelector('.material-symbols-outlined')
            ?.classList.toggle('onboard-rotated', !collapsed);
    });
}
