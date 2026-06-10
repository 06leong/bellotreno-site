import {
    findItaloStation,
    normalizeItaloStations,
    type ItaloStationLookupQuery,
    type ItaloStationInfo,
} from "../../../src/lib/normalizers/italo.ts";

export const ITALO_BASE_URL = "https://italoinviaggio.italotreno.com";

const ALLOWED_HOSTS = new Set([
    "bellotreno.org",
    "real.bellotreno.org",
    "bellotreno-site.pages.dev",
    "bellotreno.pages.dev",
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]"
]);

const ALLOWED_HOST_SUFFIXES = [
    ".bellotreno-site.pages.dev"
];

type CorsHeaderMap = Record<string, string>;

interface ItaloJsonCacheEntry {
    expiresAt: number;
    value: unknown;
}

interface ItaloJsonFetchOptions {
    attempts?: number;
    cacheKey?: string;
    cacheTtlMs?: number;
    timeoutMs?: number;
}

type ItaloJsonFetchResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: string; status?: number };

let stationCache: {
    expiresAt: number;
    promise: Promise<ItaloStationInfo[]> | null;
    stations: ItaloStationInfo[] | null;
} = {
    expiresAt: 0,
    promise: null,
    stations: null,
};

const jsonCache = new Map<string, ItaloJsonCacheEntry>();

export function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "public, max-age=60",
            ...extraHeaders
        }
    });
}

export function getUrlHostname(value: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}

function isLocalHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isAllowedHost(hostname: string, requestHost: string): boolean {
    return hostname === requestHost
        || ALLOWED_HOSTS.has(hostname)
        || ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export function requestIsAllowed(request: Request): boolean {
    const requestUrl = new URL(request.url);
    const requestHost = requestUrl.hostname;
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    if (origin) return isAllowedHost(getUrlHostname(origin), requestHost);
    if (referer) return isAllowedHost(getUrlHostname(referer), requestHost);
    return isLocalHost(requestHost);
}

export function corsHeaders(request: Request): CorsHeaderMap {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    const requestHost = new URL(request.url).hostname;
    const originHost = getUrlHostname(origin);
    if (!isAllowedHost(originHost, requestHost)) return {};
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        "vary": "origin"
    };
}

export function unavailable(reason: string, status = 200, headers: HeadersInit = {}): Response {
    return json({ available: false, provider: "italo", reason }, status, headers);
}

export function italoFetchHeaders(): HeadersInit {
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "referer": `${ITALO_BASE_URL}/it`,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    };
}

function isTransientItaloStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

export async function fetchItaloJson<T>(url: string | URL, options: ItaloJsonFetchOptions = {}): Promise<ItaloJsonFetchResult<T>> {
    const requestUrl = url.toString();
    const cacheKey = options.cacheKey || "";
    const cached = cacheKey ? jsonCache.get(cacheKey) : null;
    if (cached && cached.expiresAt > Date.now()) {
        return { ok: true, value: cached.value as T };
    }

    const attempts = Math.max(1, options.attempts ?? 2);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? 8000);
    let lastReason = "upstream_error";
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetchWithTimeout(requestUrl, {
                headers: italoFetchHeaders(),
            }, timeoutMs);

            if (response.ok) {
                let value: T;
                try {
                    value = await response.json() as T;
                } catch {
                    lastReason = "upstream_parse_error";
                    break;
                }
                if (cacheKey && options.cacheTtlMs && options.cacheTtlMs > 0) {
                    jsonCache.set(cacheKey, {
                        expiresAt: Date.now() + options.cacheTtlMs,
                        value,
                    });
                }
                return { ok: true, value };
            }

            lastStatus = response.status;
            lastReason = `upstream_http_${response.status}`;
            if (!isTransientItaloStatus(response.status)) break;
        } catch (error) {
            lastReason = error instanceof DOMException && error.name === "AbortError"
                ? "upstream_timeout"
                : "upstream_network_error";
        }

        if (attempt < attempts - 1) {
            await sleep(150 * (attempt + 1));
        }
    }

    return { ok: false, reason: lastReason, status: lastStatus };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
    return String(value ?? "").trim();
}

function slugify(value: unknown): string {
    return asString(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function decodeHtml(value: string): string {
    return value
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function parseStationArray(text: string): ItaloStationInfo[] {
    const patterns = [
        /stationList\s*[:=]\s*(\[[\s\S]*?\])\s*[;,]/i,
        /"stationList"\s*:\s*(\[[\s\S]*?\])/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        try {
            const parsed = JSON.parse(decodeHtml(match[1]));
            if (!Array.isArray(parsed)) continue;
            return parsed.map((item) => {
                const record = asRecord(item);
                const code = asString(record.code || record.value || record.Codice || record.CodiceStazione || record.stationCode);
                const name = asString(record.name || record.label || record.text || record.Descrizione || record.NomeStazione || record.stationName);
                return {
                    code,
                    name,
                    slug: asString(record.slug || record.url || record.Url) || slugify(name),
                };
            }).filter((station) => station.code && station.name);
        } catch {
            continue;
        }
    }

    return [];
}

function parseStationCoding(text: string): ItaloStationInfo[] {
    const patterns = [
        /stationCoding\s*[:=]\s*(\{[\s\S]*?\})\s*[;,]/i,
        /"stationCoding"\s*:\s*(\{[\s\S]*?\})/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        try {
            const parsed = JSON.parse(decodeHtml(match[1]));
            return Object.entries(parsed)
                .map(([key, value]) => {
                    const record = asRecord(value);
                    if (typeof value === "string") {
                        return { code: key, name: value, slug: slugify(value) };
                    }
                    const name = asString(record.name || record.label || record.text || record.Descrizione || record.NomeStazione);
                    return {
                        code: asString(record.code || record.value || record.Codice || key),
                        name,
                        slug: asString(record.slug || record.url || record.Url) || slugify(name),
                    };
                })
                .filter((station) => station.code && station.name);
        } catch {
            continue;
        }
    }

    return [];
}

export async function fetchItaloStations(): Promise<ItaloStationInfo[]> {
    const now = Date.now();
    if (stationCache.stations && stationCache.expiresAt > now) return stationCache.stations;
    if (stationCache.promise) return stationCache.promise;

    stationCache.promise = fetch(`${ITALO_BASE_URL}/it/stazione`, {
        headers: {
            "accept": "text/html,application/xhtml+xml",
            "referer": `${ITALO_BASE_URL}/`,
            "user-agent": "Mozilla/5.0 BelloTreno-Italo/1.0"
        }
    }).then(async (response) => {
        if (!response.ok) throw new Error("upstream_station_list_error");
        const text = await response.text();
        const stations = normalizeItaloStations([
            ...parseStationArray(text),
            ...parseStationCoding(text),
        ]);
        stationCache = {
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            promise: null,
            stations,
        };
        return stations;
    }).catch((error) => {
        stationCache.promise = null;
        const fallback = normalizeItaloStations();
        stationCache = {
            expiresAt: Date.now() + 10 * 60 * 1000,
            promise: null,
            stations: fallback,
        };
        console.error("Italo station list fetch failed:", error);
        return fallback;
    });

    return stationCache.promise;
}

export async function resolveItaloStation(query: ItaloStationLookupQuery): Promise<ItaloStationInfo | null> {
    return findItaloStation(await fetchItaloStations(), query);
}
