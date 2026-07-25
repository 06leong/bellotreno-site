import {
    extractWSessionId,
    getLeFrecceSolutionId,
    normalizeLeFrecceOnboardDetail,
    rfiStationIdToLeFrecceId,
    selectLeFrecceSolution,
    selectLeFrecceTrainDetail,
    type LeFrecceMatchCriteria,
} from "../../../src/lib/normalizers/lefrecce.ts";
import {
    LEFRECCE_BASE_URL,
    cacheControl,
    cachePayload,
    corsHeaders,
    fetchLeFrecceUpstream,
    getCachedPayload,
    json,
    leFrecceProxyConfig,
    requestIsAllowed,
    resolveLeFrecceLocationByName,
    unavailable,
    upstreamHeaders,
    type CachedLeFreccePayload,
    type LeFrecceProxyConfig,
} from "./_shared.ts";

interface OnboardQuery {
    arrivalAt: string | null;
    date: string;
    departureAt: string;
    destinationId: string | null;
    destinationName: string;
    number: string;
    originId: string | null;
    originName: string;
}

interface CloudflareCacheStorage {
    default?: Cache;
}

const inFlightPayloads = new Map<string, Promise<CachedLeFreccePayload>>();

function cleanText(value: string | null): string {
    return (value || "").trim();
}

function parseQuery(request: Request): OnboardQuery | null {
    const params = new URL(request.url).searchParams;
    const number = cleanText(params.get("number")).replace(/\D+/g, "");
    const date = cleanText(params.get("date"));
    const departureAt = cleanText(params.get("departureAt"));
    const arrivalAt = cleanText(params.get("arrivalAt")) || null;
    const originId = cleanText(params.get("originId")) || null;
    const destinationId = cleanText(params.get("destinationId")) || null;
    const originName = cleanText(params.get("originName"));
    const destinationName = cleanText(params.get("destinationName"));

    if (
        !number
        || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(departureAt))
        || (arrivalAt !== null && !Number.isFinite(Date.parse(arrivalAt)))
        || (!originId && !originName)
        || (!destinationId && !destinationName)
    ) {
        return null;
    }

    return {
        arrivalAt,
        date,
        departureAt,
        destinationId,
        destinationName,
        number,
        originId,
        originName,
    };
}

function makeCacheKey(query: OnboardQuery): string {
    return [
        query.number,
        query.date,
        query.departureAt,
        query.arrivalAt || "",
        query.originId || query.originName,
        query.destinationId || query.destinationName,
    ].join("|");
}

async function resolveLocationId(
    id: string | null,
    name: string,
    proxy: LeFrecceProxyConfig | null,
): Promise<number | null> {
    const directId = rfiStationIdToLeFrecceId(id);
    if (directId) return directId;
    return (await resolveLeFrecceLocationByName(name, proxy))?.id || null;
}

function responseFor(
    payload: CachedLeFreccePayload,
    headers: HeadersInit,
    status = 200,
): Response {
    return json(payload, status, {
        ...headers,
        "cache-control": cacheControl(payload),
    });
}

function defaultEdgeCache(): Cache | null {
    return (globalThis as typeof globalThis & { caches?: CloudflareCacheStorage })
        .caches?.default || null;
}

function edgeCacheRequest(request: Request, cacheKey: string): Request {
    const url = new URL(request.url);
    url.search = "";
    url.searchParams.set("onboardCacheKey", cacheKey);
    return new Request(url.toString(), { method: "GET" });
}

function isCachedPayload(value: unknown): value is CachedLeFreccePayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as Partial<CachedLeFreccePayload>;
    return payload.provider === "trenitalia-lefrecce"
        && typeof payload.available === "boolean";
}

async function getEdgeCachedPayload(
    request: Request,
    cacheKey: string,
): Promise<CachedLeFreccePayload | null> {
    const cache = defaultEdgeCache();
    if (!cache) return null;
    try {
        const response = await cache.match(edgeCacheRequest(request, cacheKey));
        if (!response?.ok) return null;
        const payload: unknown = await response.json();
        return isCachedPayload(payload) ? payload : null;
    } catch {
        return null;
    }
}

async function putEdgeCachedPayload(
    request: Request,
    cacheKey: string,
    payload: CachedLeFreccePayload,
): Promise<void> {
    const cache = defaultEdgeCache();
    if (!cache) return;
    try {
        await cache.put(
            edgeCacheRequest(request, cacheKey),
            responseFor(payload, {}),
        );
    } catch {
        // Edge caching is an optimization; upstream enrichment remains fail-open.
    }
}

function isDisabled(env: PagesEnv): boolean {
    return String(env.TRENITALIA_LEFRECCE_ENABLED || "").trim().toLowerCase() === "false";
}

function upstreamHttpReason(
    stage: "search" | "stops",
    status: number,
    proxy: LeFrecceProxyConfig | null,
): string {
    return `${proxy ? "proxy" : "upstream"}_${stage}_http_${status}`;
}

async function fetchOnboardPayload(
    query: OnboardQuery,
    proxy: LeFrecceProxyConfig | null,
): Promise<CachedLeFreccePayload> {
    const [originLocationId, destinationLocationId] = await Promise.all([
        resolveLocationId(query.originId, query.originName, proxy),
        resolveLocationId(query.destinationId, query.destinationName, proxy),
    ]);
    if (!originLocationId || !destinationLocationId) return unavailable("location_not_found");

    const searchResponse = await fetchLeFrecceUpstream(`${LEFRECCE_BASE_URL}/ticket/solutions`, {
        method: "POST",
        headers: upstreamHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
            departureLocationId: originLocationId,
            arrivalLocationId: destinationLocationId,
            departureTime: query.departureAt,
            adults: 1,
            children: 0,
            criteria: {
                frecceOnly: false,
                regionalOnly: false,
                noChanges: false,
                order: "DEPARTURE_DATE",
                limit: 50,
                offset: 0,
            },
            advancedSearchRequest: { bestFare: false },
        }),
    }, proxy);
    if (!searchResponse.ok) {
        return unavailable(upstreamHttpReason("search", searchResponse.status, proxy));
    }

    const sessionId = extractWSessionId(searchResponse.headers.get("set-cookie"));
    const searchPayload = await searchResponse.json() as Record<string, unknown>;
    if (!sessionId) return unavailable("session_missing");

    const criteria: LeFrecceMatchCriteria = {
        arrivalAt: query.arrivalAt,
        departureAt: query.departureAt,
        destinationId: destinationLocationId,
        destinationName: query.destinationName,
        operationDate: query.date,
        originId: originLocationId,
        originName: query.originName,
        trainNumber: query.number,
    };
    const selectedSolution = selectLeFrecceSolution(searchPayload, criteria);
    if (selectedSolution.status !== "matched") {
        return unavailable(selectedSolution.status === "ambiguous" ? "ambiguous_solution" : "solution_not_found");
    }

    const cartId = cleanText(String(searchPayload.cartId || ""));
    const solutionId = getLeFrecceSolutionId(selectedSolution.match);
    if (!cartId || !solutionId) return unavailable("solution_context_missing");

    const stopsUrl = new URL(`${LEFRECCE_BASE_URL}/stops`);
    stopsUrl.searchParams.set("cartId", cartId);
    stopsUrl.searchParams.set("solutionId", solutionId);
    const stopsResponse = await fetchLeFrecceUpstream(stopsUrl, {
        headers: upstreamHeaders({ "cookie": `WSESSIONID=${sessionId}` }),
    }, proxy);
    if (!stopsResponse.ok) {
        return unavailable(upstreamHttpReason("stops", stopsResponse.status, proxy));
    }

    const selectedDetail = selectLeFrecceTrainDetail(await stopsResponse.json(), query.number);
    if (selectedDetail.status !== "matched") {
        return unavailable(selectedDetail.status === "ambiguous" ? "ambiguous_train_segment" : "train_segment_not_found");
    }

    const normalized = normalizeLeFrecceOnboardDetail(selectedDetail.match, {
        fetchedAt: new Date().toISOString(),
        operationDate: query.date,
        trainNumber: query.number,
    });
    const hasEnrichment = Boolean(
        normalized.rollingStock
        || normalized.serviceLevels.length
        || normalized.amenities.length
        || normalized.classServices.length
        || normalized.notes.length
    );
    return hasEnrichment ? normalized : unavailable("no_enrichment");
}

export async function onRequestOptions(context: PagesContext): Promise<Response> {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(context.request),
    });
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
    const headers = corsHeaders(context.request);
    if (!requestIsAllowed(context.request)) {
        return responseFor(unavailable("forbidden"), headers, 403);
    }
    if (isDisabled(context.env)) {
        return responseFor(unavailable("disabled"), headers);
    }

    const query = parseQuery(context.request);
    if (!query) return responseFor(unavailable("bad_request"), headers, 400);

    const cacheKey = makeCacheKey(query);
    const cached = getCachedPayload(cacheKey);
    if (cached) return responseFor(cached, headers);

    const edgeCached = await getEdgeCachedPayload(context.request, cacheKey);
    if (edgeCached) {
        cachePayload(cacheKey, edgeCached);
        return responseFor(edgeCached, headers);
    }

    try {
        let pending = inFlightPayloads.get(cacheKey);
        if (!pending) {
            pending = fetchOnboardPayload(query, leFrecceProxyConfig(context.env));
            inFlightPayloads.set(cacheKey, pending);
        }
        const payload = await pending;
        inFlightPayloads.delete(cacheKey);
        cachePayload(cacheKey, payload);
        const edgeWrite = putEdgeCachedPayload(context.request, cacheKey, payload);
        if (context.waitUntil) context.waitUntil(edgeWrite);
        else await edgeWrite;
        return responseFor(payload, headers);
    } catch {
        inFlightPayloads.delete(cacheKey);
        const payload = unavailable("upstream_unavailable");
        cachePayload(cacheKey, payload);
        const edgeWrite = putEdgeCachedPayload(context.request, cacheKey, payload);
        if (context.waitUntil) context.waitUntil(edgeWrite);
        else await edgeWrite;
        return responseFor(payload, headers);
    }
}

export async function onRequest(context: PagesContext): Promise<Response> {
    if (context.request.method === "OPTIONS") return onRequestOptions(context);
    if (context.request.method === "GET") return onRequestGet(context);
    return responseFor(unavailable("method_not_allowed"), {
        ...corsHeaders(context.request),
        "allow": "GET, OPTIONS",
    }, 405);
}
