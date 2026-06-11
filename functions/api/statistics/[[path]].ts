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
const DEFAULT_STATISTICS_API_BASE_URL = "https://stats-api.bellotreno.org/v1";

type StatisticsParams = { path?: string | string[] };
type CorsHeaderMap = Record<string, string>;
type StatisticsCacheEntry = {
    body: ArrayBuffer;
    contentType: string;
    expiresAt: number;
    status: number;
};

const statisticsResponseCache = new Map<string, StatisticsCacheEntry>();
const MAX_CACHE_ENTRIES = 120;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            ...extraHeaders
        }
    });
}

function getUrlHostname(value: string): string {
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

function requestIsAllowed(request: Request): boolean {
    const requestUrl = new URL(request.url);
    const requestHost = requestUrl.hostname;
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    if (origin) return isAllowedHost(getUrlHostname(origin), requestHost);
    if (referer) return isAllowedHost(getUrlHostname(referer), requestHost);
    return isLocalHost(requestHost);
}

function corsHeaders(request: Request): CorsHeaderMap {
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

function routePath(params: StatisticsParams): string {
    const rawPath = params?.path;
    const path = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");
    const cleanPath = path
        .split("/")
        .filter((segment) => segment && segment !== "." && segment !== "..")
        .join("/");
    return cleanPath;
}

function buildUpstreamUrl(baseUrl: string, path: string, requestUrl: URL): URL {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    const upstream = new URL(`${base}/${path}`.replace(/\/+$/, ""));
    upstream.search = requestUrl.search;
    return upstream;
}

function cacheTtlSeconds(path: string): number {
    if (path.endsWith("export.csv")) return 0;
    if (path === "days") return 300;
    if (path === "summary" || path === "timeseries") return 120;
    if (path === "trains" || path === "stations/search" || path === "relations" || path === "ranking") return 60;
    if (path.startsWith("stations/")) return 120;
    return 60;
}

function cacheControlHeader(ttlSeconds: number): string {
    if (ttlSeconds <= 0) return "no-store";
    return `public, max-age=${ttlSeconds}, stale-while-revalidate=${Math.max(ttlSeconds * 2, 60)}`;
}

function cacheKey(upstreamUrl: URL): string {
    return upstreamUrl.toString();
}

function getCachedStatisticsResponse(key: string): StatisticsCacheEntry | null {
    const cached = statisticsResponseCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        statisticsResponseCache.delete(key);
        return null;
    }
    return cached;
}

function trimStatisticsCache(): void {
    const now = Date.now();
    for (const [key, entry] of statisticsResponseCache) {
        if (entry.expiresAt <= now) statisticsResponseCache.delete(key);
    }
    while (statisticsResponseCache.size > MAX_CACHE_ENTRIES) {
        const firstKey = statisticsResponseCache.keys().next().value;
        if (!firstKey) break;
        statisticsResponseCache.delete(firstKey);
    }
}

function setCachedStatisticsResponse(key: string, ttlSeconds: number, entry: Omit<StatisticsCacheEntry, "expiresAt">): void {
    if (ttlSeconds <= 0) return;
    trimStatisticsCache();
    statisticsResponseCache.set(key, {
        ...entry,
        expiresAt: Date.now() + ttlSeconds * 1000
    });
}

function statisticsResponse(
    entry: Omit<StatisticsCacheEntry, "expiresAt">,
    extraHeaders: HeadersInit,
    cacheControl: string,
    cacheStatus: "HIT" | "MISS",
): Response {
    const responseHeaders = new Headers(extraHeaders);
    responseHeaders.set("cache-control", cacheControl);
    responseHeaders.set("x-bellotreno-cache", cacheStatus);
    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("content-type", entry.contentType);

    return new Response(entry.body.slice(0), {
        status: entry.status,
        headers: responseHeaders
    });
}

export async function onRequestOptions({ request }: PagesContext<StatisticsParams>): Promise<Response> {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
    });
}

export async function onRequestGet({ request, env, params }: PagesContext<StatisticsParams>): Promise<Response> {
    const extraHeaders = corsHeaders(request);
    if (!requestIsAllowed(request)) {
        return json({ available: false, reason: "forbidden" }, 403, extraHeaders);
    }

    const baseUrl = env.STATISTICS_API_BASE_URL || DEFAULT_STATISTICS_API_BASE_URL;
    if (!baseUrl) {
        return json({ available: false, reason: "not_configured" }, 503, extraHeaders);
    }

    const path = routePath(params);
    const requestUrl = new URL(request.url);
    let upstreamUrl;
    try {
        upstreamUrl = buildUpstreamUrl(baseUrl, path, requestUrl);
    } catch {
        return json({ available: false, reason: "bad_upstream_url" }, 500, extraHeaders);
    }

    const headers = new Headers({
        "accept": request.headers.get("accept") || "application/json",
        "user-agent": "BelloTreno-Statistics-Proxy/1.0"
    });
    if (env.STATISTICS_API_TOKEN) {
        headers.set("X-Bello-Stats-Token", env.STATISTICS_API_TOKEN);
    }

    const ttlSeconds = cacheTtlSeconds(path);
    const responseCacheControl = cacheControlHeader(ttlSeconds);
    const key = cacheKey(upstreamUrl);
    const cached = ttlSeconds > 0 ? getCachedStatisticsResponse(key) : null;
    if (cached) {
        return statisticsResponse(cached, extraHeaders, responseCacheControl, "HIT");
    }

    try {
        const upstream = await fetch(upstreamUrl.toString(), {
            method: "GET",
            headers
        });

        const body = await upstream.arrayBuffer();
        const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
        const entry = {
            body,
            contentType,
            status: upstream.status
        };

        if (upstream.ok) {
            setCachedStatisticsResponse(key, ttlSeconds, entry);
            return statisticsResponse(entry, extraHeaders, responseCacheControl, "MISS");
        }

        return statisticsResponse(entry, extraHeaders, "no-store", "MISS");
    } catch {
        return json({ available: false, reason: "upstream_error" }, 502, extraHeaders);
    }
}

export async function onRequest({ request }: PagesContext<StatisticsParams>): Promise<Response> {
    return json({ available: false, reason: "method_not_allowed" }, 405, corsHeaders(request));
}
