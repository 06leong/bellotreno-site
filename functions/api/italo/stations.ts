import { normalizeItaloStations } from "../../../src/lib/normalizers/italo.ts";
import {
    corsHeaders,
    fetchItaloStations,
    json,
    requestIsAllowed,
    resolveItaloStation,
    unavailable,
} from "./_shared.ts";

function normalizeSearch(value: unknown): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’'`´]/g, " ")
        .replace(/[.\-_/(),]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

export async function onRequestOptions(context: PagesContext): Promise<Response> {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(context.request)
    });
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
    const request = context.request;
    const headers = corsHeaders(request);

    if (!requestIsAllowed(request)) {
        return unavailable("forbidden", 403, headers);
    }

    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const rfi = url.searchParams.get("rfi") || "";
    const code = url.searchParams.get("code") || "";

    if (rfi || code) {
        const station = await resolveItaloStation({ code, rfiLocationCode: rfi });
        return json({
            available: Boolean(station),
            provider: "italo",
            stations: station ? [station] : [],
        }, 200, headers);
    }

    const stations = normalizeItaloStations(await fetchItaloStations());
    const query = normalizeSearch(q);
    const filtered = query
        ? stations.filter((station) => {
            const candidates = [station.code, station.name, station.slug, ...(station.aliases || [])].map(normalizeSearch);
            return candidates.some((candidate) => candidate.includes(query) || query.includes(candidate));
        }).slice(0, 20)
        : stations;

    return json({
        available: true,
        provider: "italo",
        stations: filtered,
    }, 200, {
        ...headers,
        "cache-control": "public, max-age=86400"
    });
}

export async function onRequest(context: PagesContext): Promise<Response> {
    if (context.request.method === "OPTIONS") return onRequestOptions(context);
    if (context.request.method === "GET") return onRequestGet(context);
    return unavailable("method_not_allowed", 405, {
        ...corsHeaders(context.request),
        "allow": "GET, OPTIONS"
    });
}
