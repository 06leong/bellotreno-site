import {
    normalizeLeFrecceStationName,
    type LeFrecceOnboardPayload,
} from "../../../src/lib/normalizers/lefrecce.ts";

export const LEFRECCE_BASE_URL = "https://www.lefrecce.it/Channels.Website.BFF.WEB/website";

const ALLOWED_HOSTS = new Set([
    "bellotreno.org",
    "real.bellotreno.org",
    "bellotreno-site.pages.dev",
    "bellotreno.pages.dev",
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
]);

const ALLOWED_HOST_SUFFIXES = [".bellotreno-site.pages.dev"];
const SUCCESS_TTL_MS = 30 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

type HeaderMap = Record<string, string>;

export interface LeFrecceLocation {
    id: number;
    name: string;
}

export interface LeFrecceUnavailablePayload {
    available: false;
    provider: "trenitalia-lefrecce";
    reason: string;
}

export type CachedLeFreccePayload = LeFrecceOnboardPayload | LeFrecceUnavailablePayload;

interface CacheEntry {
    expiresAt: number;
    value: CachedLeFreccePayload;
}

const responseCache = new Map<string, CacheEntry>();

function getUrlHostname(value: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}

function isLocalHost(hostname: string): boolean {
    return hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "::1"
        || hostname === "[::1]";
}

function isAllowedHost(hostname: string, requestHost: string): boolean {
    return hostname === requestHost
        || ALLOWED_HOSTS.has(hostname)
        || ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export function requestIsAllowed(request: Request): boolean {
    const requestHost = new URL(request.url).hostname;
    const fetchSite = request.headers.get("sec-fetch-site");
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    // Cloudflare Access can preserve its login domain as the referrer on the
    // first request after authentication. Sec-Fetch-Site is the browser's
    // authoritative signal that the API call still came from this page.
    if (fetchSite === "same-origin") return true;
    if (origin) return isAllowedHost(getUrlHostname(origin), requestHost);
    if (referer) return isAllowedHost(getUrlHostname(referer), requestHost);
    return isLocalHost(requestHost);
}

export function corsHeaders(request: Request): HeaderMap {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    const requestHost = new URL(request.url).hostname;
    if (!isAllowedHost(getUrlHostname(origin), requestHost)) return {};
    return {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-origin": origin,
        "vary": "origin",
    };
}

export function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "cache-control": "public, max-age=60",
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
            ...extraHeaders,
        },
    });
}

export function unavailable(reason: string): LeFrecceUnavailablePayload {
    return {
        available: false,
        provider: "trenitalia-lefrecce",
        reason,
    };
}

export function getCachedPayload(key: string): CachedLeFreccePayload | null {
    const cached = responseCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        responseCache.delete(key);
        return null;
    }
    return cached.value;
}

export function cachePayload(key: string, value: CachedLeFreccePayload): void {
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        if (typeof oldestKey === "string") responseCache.delete(oldestKey);
    }
    responseCache.set(key, {
        expiresAt: Date.now() + (value.available ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
        value,
    });
}

export function cacheControl(value: CachedLeFreccePayload): string {
    return value.available
        ? "public, max-age=300, s-maxage=1800, stale-while-revalidate=300"
        : "public, max-age=60, s-maxage=300";
}

export function upstreamHeaders(extra: HeadersInit = {}): HeadersInit {
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "it-IT,it;q=0.9",
        "user-agent": "BelloTreno/1.0 (+https://bellotreno.org)",
        ...extra,
    };
}

export async function fetchWithTimeout(
    input: string | URL,
    init: RequestInit = {},
    timeoutMs = 8000,
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function locationCandidates(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    const root = asRecord(payload);
    for (const key of ["locations", "results", "items"]) {
        if (Array.isArray(root[key])) return root[key] as unknown[];
    }
    return [];
}

export async function resolveLeFrecceLocationByName(name: string): Promise<LeFrecceLocation | null> {
    const normalizedName = normalizeLeFrecceStationName(name);
    if (!normalizedName) return null;

    const url = new URL(`${LEFRECCE_BASE_URL}/locations/search`);
    url.searchParams.set("name", name);
    url.searchParams.set("limit", "20");
    const response = await fetchWithTimeout(url, { headers: upstreamHeaders() });
    if (!response.ok) return null;

    const matches = locationCandidates(await response.json())
        .map((item) => {
            const record = asRecord(item);
            const id = Number(record.id);
            const locationName = String(record.name || record.displayName || "").trim();
            return Number.isSafeInteger(id) && id > 0 && locationName
                ? { id, name: locationName }
                : null;
        })
        .filter((item): item is LeFrecceLocation => Boolean(item))
        .filter((item) => normalizeLeFrecceStationName(item.name) === normalizedName);

    return matches.length === 1 ? matches[0] : null;
}
