const ALLOWED_HOSTS = new Set([
    "real.bellotreno.org",
    "bellotreno.pages.dev",
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]"
]);

function json(data, status = 200, extraHeaders = {}) {
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

function getUrlHostname(value) {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}

function isLocalHost(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isAllowedHost(hostname, requestHost) {
    return hostname === requestHost || ALLOWED_HOSTS.has(hostname);
}

function requestIsAllowed(request) {
    const requestUrl = new URL(request.url);
    const requestHost = requestUrl.hostname;
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    if (origin) return isAllowedHost(getUrlHostname(origin), requestHost);
    if (referer) return isAllowedHost(getUrlHostname(referer), requestHost);
    return isLocalHost(requestHost);
}

function corsHeaders(request) {
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

function routePath(params) {
    const rawPath = params?.path;
    const path = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");
    const cleanPath = path
        .split("/")
        .filter((segment) => segment && segment !== "." && segment !== "..")
        .join("/");
    return cleanPath;
}

function buildUpstreamUrl(baseUrl, path, requestUrl) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    const upstream = new URL(`${base}/${path}`.replace(/\/+$/, ""));
    upstream.search = requestUrl.search;
    return upstream;
}

export async function onRequestOptions({ request }) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
    });
}

export async function onRequestGet({ request, env, params }) {
    const extraHeaders = corsHeaders(request);
    if (!requestIsAllowed(request)) {
        return json({ available: false, reason: "forbidden" }, 403, extraHeaders);
    }

    const baseUrl = env.STATISTICS_API_BASE_URL;
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

    try {
        const upstream = await fetch(upstreamUrl.toString(), {
            method: "GET",
            headers
        });

        const responseHeaders = new Headers(extraHeaders);
        responseHeaders.set("cache-control", "no-store");
        responseHeaders.set("x-content-type-options", "nosniff");
        responseHeaders.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");

        return new Response(upstream.body, {
            status: upstream.status,
            headers: responseHeaders
        });
    } catch {
        return json({ available: false, reason: "upstream_error" }, 502, extraHeaders);
    }
}

export async function onRequest({ request }) {
    return json({ available: false, reason: "method_not_allowed" }, 405, corsHeaders(request));
}
