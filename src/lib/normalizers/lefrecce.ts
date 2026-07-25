export type LeFrecceAmenityCode =
    | 'bar'
    | 'bicycle'
    | 'minibar'
    | 'restaurant'
    | 'seat-service'
    | 'wheelchair-accessible';

export type LeFrecceClassServiceCode =
    | 'business-catering'
    | 'business-welcome'
    | 'executive-meal'
    | 'premium-catering';

export type LeFrecceServiceLevel = 'business' | 'executive' | 'premium' | 'standard';

export interface LeFrecceRollingStock {
    code: string;
    evidence: 'explicit';
    informationType: 'scheduled';
    label: string;
    rawDescription: string;
    series: string | null;
}

export interface LeFrecceOnboardItem<TCode extends string = string> {
    code: TCode;
    rawDescription: string;
}

export interface LeFrecceOnboardPayload {
    amenities: LeFrecceOnboardItem<LeFrecceAmenityCode>[];
    available: true;
    classServices: LeFrecceOnboardItem<LeFrecceClassServiceCode>[];
    fetchedAt: string;
    notes: string[];
    operationDate: string;
    provider: 'trenitalia-lefrecce';
    rollingStock: LeFrecceRollingStock | null;
    serviceLevels: LeFrecceServiceLevel[];
    trainNumber: string;
}

export interface LeFrecceMatchCriteria {
    arrivalAt?: string | null;
    departureAt: string;
    destinationId?: number | null;
    destinationName?: string | null;
    operationDate: string;
    originId?: number | null;
    originName?: string | null;
    trainNumber: string;
}

export type LeFrecceSelection<T> =
    | { match: T; status: 'matched' }
    | { status: 'ambiguous' | 'not-found' };

type UnknownRecord = Record<string, unknown>;

const KNOWN_SERVICE_LEVELS: ReadonlyArray<[LeFrecceServiceLevel, RegExp]> = [
    ['executive', /\bexecutive\b/i],
    ['business', /\bbusiness\b/i],
    ['premium', /\bpremium\b/i],
    ['standard', /\bstandard\b/i]
];

function asRecord(value: unknown): UnknownRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function asNonEmptyString(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || null;
}

function digits(value: unknown): string {
    return String(value ?? '').replace(/\D+/g, '');
}

function numericId(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nestedValue(record: UnknownRecord, ...paths: string[][]): unknown {
    for (const path of paths) {
        let current: unknown = record;
        for (const segment of path) {
            current = asRecord(current)[segment];
        }
        if (current !== undefined && current !== null && current !== '') return current;
    }
    return null;
}

export function normalizeLeFrecceStationName(value: unknown): string {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\bstazione\b/g, '')
        .replace(/\bs\.\s*m\.\s*novella\b/g, 'santa maria novella')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function rfiStationIdToLeFrecceId(value: unknown): number | null {
    const match = String(value ?? '').trim().toUpperCase().match(/^S(\d{1,7})$/);
    if (!match) return null;
    return Number(`83${match[1].padStart(7, '0')}`);
}

export function extractWSessionId(setCookie: string | null | undefined): string | null {
    if (!setCookie) return null;
    const match = setCookie.match(/(?:^|[;,]\s*)WSESSIONID=([^;,\s]+)/i);
    return match?.[1]?.trim() || null;
}

function unwrapSolution(value: unknown): UnknownRecord {
    const wrapper = asRecord(value);
    return Object.keys(asRecord(wrapper.solution)).length > 0
        ? asRecord(wrapper.solution)
        : wrapper;
}

function solutionTrainNumbers(solution: UnknownRecord): string[] {
    const trains = asArray(solution.trains);
    return trains
        .map((train) => {
            const record = asRecord(train);
            return digits(record.description ?? record.number ?? record.trainNumber);
        })
        .filter(Boolean);
}

function solutionTimestamp(solution: UnknownRecord, kind: 'arrival' | 'departure'): string | null {
    const keys = kind === 'departure'
        ? [
            ['departureTime'],
            ['departureDateTime'],
            ['departure', 'dateTime'],
            ['departure', 'time'],
            ['origin', 'dateTime']
        ]
        : [
            ['arrivalTime'],
            ['arrivalDateTime'],
            ['arrival', 'dateTime'],
            ['arrival', 'time'],
            ['destination', 'dateTime']
        ];
    return asNonEmptyString(nestedValue(solution, ...keys));
}

function solutionLocationId(solution: UnknownRecord, kind: 'destination' | 'origin'): number | null {
    const keys = kind === 'origin'
        ? [
            ['departureLocationId'],
            ['originLocationId'],
            ['departure', 'id'],
            ['origin', 'id'],
            ['departureLocation', 'id'],
            ['originLocation', 'id']
        ]
        : [
            ['arrivalLocationId'],
            ['destinationLocationId'],
            ['arrival', 'id'],
            ['destination', 'id'],
            ['arrivalLocation', 'id'],
            ['destinationLocation', 'id']
        ];
    return numericId(nestedValue(solution, ...keys));
}

function solutionLocationName(solution: UnknownRecord, kind: 'destination' | 'origin'): string | null {
    const keys = kind === 'origin'
        ? [
            ['departureLocation'],
            ['originLocation'],
            ['origin'],
            ['departure', 'name'],
            ['origin', 'name'],
            ['departureLocation', 'name'],
            ['originLocation', 'name']
        ]
        : [
            ['arrivalLocation'],
            ['destinationLocation'],
            ['destination'],
            ['arrival', 'name'],
            ['destination', 'name'],
            ['arrivalLocation', 'name'],
            ['destinationLocation', 'name']
        ];
    const value = nestedValue(solution, ...keys);
    return typeof value === 'string' ? value : asNonEmptyString(asRecord(value).name);
}

function timestampsWithinTolerance(actual: string | null, expected: string | null | undefined): boolean {
    if (!expected) return true;
    if (!actual) return false;
    const actualMs = Date.parse(actual);
    const expectedMs = Date.parse(expected);
    if (!Number.isFinite(actualMs) || !Number.isFinite(expectedMs)) return false;
    return Math.abs(actualMs - expectedMs) <= 5 * 60 * 1000;
}

function locationMatches(
    solution: UnknownRecord,
    kind: 'destination' | 'origin',
    expectedId: number | null | undefined,
    expectedName: string | null | undefined
): boolean {
    const actualId = solutionLocationId(solution, kind);
    if (expectedId && actualId) return expectedId === actualId;

    const normalizedExpected = normalizeLeFrecceStationName(expectedName);
    if (!normalizedExpected) return !expectedId;
    const normalizedActual = normalizeLeFrecceStationName(solutionLocationName(solution, kind));
    return Boolean(normalizedActual) && (
        normalizedActual === normalizedExpected
        || normalizedActual.includes(normalizedExpected)
        || normalizedExpected.includes(normalizedActual)
    );
}

export function selectLeFrecceSolution(
    payload: unknown,
    criteria: LeFrecceMatchCriteria
): LeFrecceSelection<UnknownRecord> {
    const root = asRecord(payload);
    const trainNumber = digits(criteria.trainNumber);
    if (!trainNumber) return { status: 'not-found' };

    const matches = asArray(root.solutions)
        .map(unwrapSolution)
        .filter((solution) => solutionTrainNumbers(solution).includes(trainNumber))
        .filter((solution) => {
            const departureTime = solutionTimestamp(solution, 'departure');
            return Boolean(departureTime?.startsWith(criteria.operationDate))
                && timestampsWithinTolerance(departureTime, criteria.departureAt)
                && timestampsWithinTolerance(solutionTimestamp(solution, 'arrival'), criteria.arrivalAt);
        })
        .filter((solution) => locationMatches(
            solution,
            'origin',
            criteria.originId,
            criteria.originName
        ))
        .filter((solution) => locationMatches(
            solution,
            'destination',
            criteria.destinationId,
            criteria.destinationName
        ));

    if (matches.length === 1) return { status: 'matched', match: matches[0] };
    return { status: matches.length > 1 ? 'ambiguous' : 'not-found' };
}

export function getLeFrecceSolutionId(solution: unknown): string | null {
    return asNonEmptyString(asRecord(solution).id);
}

export function selectLeFrecceTrainDetail(
    payload: unknown,
    trainNumber: string
): LeFrecceSelection<UnknownRecord> {
    const expectedNumber = digits(trainNumber);
    const matches = asArray(payload).filter((detail) => {
        const record = asRecord(detail);
        const summary = asRecord(record.summary);
        const trainInfo = asRecord(summary.trainInfo);
        return digits(trainInfo.description ?? trainInfo.number ?? summary.trainNumber) === expectedNumber;
    }).map(asRecord);

    if (matches.length === 1) return { status: 'matched', match: matches[0] };
    return { status: matches.length > 1 ? 'ambiguous' : 'not-found' };
}

function parseRollingStock(description: string): LeFrecceRollingStock | null {
    const etrMatch = description.match(
        /\btreno\s+effettuato\s+con(?:\s+materiale)?\s+ETR\s*[- ]?\s*(\d{3,4})\b/i
    );
    if (etrMatch) {
        const series = etrMatch[1];
        return {
            code: `etr-${series}`,
            evidence: 'explicit',
            informationType: 'scheduled',
            label: `ETR ${series}`,
            rawDescription: description,
            series
        };
    }

    if (/\bmateriale\s+giruno\b/i.test(description)) {
        return {
            code: 'giruno-rabe-501',
            evidence: 'explicit',
            informationType: 'scheduled',
            label: 'Giruno',
            rawDescription: description,
            series: 'RABe 501'
        };
    }

    return null;
}

function parseServiceLevels(description: string): LeFrecceServiceLevel[] {
    if (!/\blivell[oi]\s+di\s+servizio\b/i.test(description)) return [];
    return KNOWN_SERVICE_LEVELS
        .filter(([, pattern]) => pattern.test(description))
        .map(([level]) => level);
}

function parseAmenity(description: string): LeFrecceAmenityCode | null {
    if (/sedia\s+a\s+ruote|bagno\s+accessibile/i.test(description)) return 'wheelchair-accessible';
    if (/servizio\s+di\s+minibar|\bminibar\b/i.test(description)) return 'minibar';
    if (/servizio\s+ristorante/i.test(description)) return 'restaurant';
    if (/servizio\s+bar/i.test(description)) return 'bar';
    if (/trasporto\s+biciclette/i.test(description)) return 'bicycle';
    if (/ristorazione\s+al\s+posto|FRECCIAPlay/i.test(description)) return 'seat-service';
    return null;
}

function parseClassService(description: string): LeFrecceClassServiceCode | null {
    if (/ristorazione\s+inclus[ao]\s+nel\s+livello\s+Executive/i.test(description)) return 'executive-meal';
    if (/servizio\s+di\s+benvenuto\s+nel\s+livello\s+Business/i.test(description)) return 'business-welcome';
    if (/ristorazione\s+Business/i.test(description)) return 'business-catering';
    if (/ristorazione\s+Premium/i.test(description)) return 'premium-catering';
    return null;
}

function pushUniqueItem<TCode extends string>(
    target: LeFrecceOnboardItem<TCode>[],
    code: TCode,
    rawDescription: string
): void {
    if (!target.some((item) => item.code === code)) {
        target.push({ code, rawDescription });
    }
}

export function normalizeLeFrecceOnboardDetail(
    detail: unknown,
    context: { fetchedAt?: string; operationDate: string; trainNumber: string }
): LeFrecceOnboardPayload {
    const services = asArray(asRecord(detail).services);
    const amenities: LeFrecceOnboardItem<LeFrecceAmenityCode>[] = [];
    const classServices: LeFrecceOnboardItem<LeFrecceClassServiceCode>[] = [];
    const serviceLevels: LeFrecceServiceLevel[] = [];
    const notes: string[] = [];
    let rollingStock: LeFrecceRollingStock | null = null;

    for (const service of services) {
        const description = asNonEmptyString(asRecord(service).description);
        if (!description) continue;

        const parsedStock = parseRollingStock(description);
        if (parsedStock) {
            rollingStock ??= parsedStock;
            continue;
        }

        const levels = parseServiceLevels(description);
        if (levels.length > 0) {
            for (const level of levels) {
                if (!serviceLevels.includes(level)) serviceLevels.push(level);
            }
            continue;
        }

        const amenity = parseAmenity(description);
        if (amenity) {
            pushUniqueItem(amenities, amenity, description);
            continue;
        }

        const classService = parseClassService(description);
        if (classService) {
            pushUniqueItem(classServices, classService, description);
            continue;
        }

        if (!notes.includes(description)) notes.push(description);
    }

    return {
        amenities,
        available: true,
        classServices,
        fetchedAt: context.fetchedAt || new Date().toISOString(),
        notes,
        operationDate: context.operationDate,
        provider: 'trenitalia-lefrecce',
        rollingStock,
        serviceLevels,
        trainNumber: digits(context.trainNumber)
    };
}
