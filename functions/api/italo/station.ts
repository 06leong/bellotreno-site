import { normalizeItaloStationBoard, type ItaloStationPayload } from "../../../src/lib/normalizers/italo.ts";
import {
    ITALO_BASE_URL,
    corsHeaders,
    italoFetchHeaders,
    json,
    requestIsAllowed,
    resolveItaloStation,
    unavailable,
} from "./_shared.ts";

type BoardType = "partenze" | "arrivi";

function boardType(value: string | null): BoardType {
    return value === "arrivi" ? "arrivi" : "partenze";
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
    const code = (url.searchParams.get("code") || "").trim();
    const name = (url.searchParams.get("name") || "").trim();
    const rfi = (url.searchParams.get("rfi") || "").trim();
    const type = boardType(url.searchParams.get("type"));

    const station = await resolveItaloStation({ code, name, rfiLocationCode: rfi });
    if (!station?.code) {
        return unavailable("station_not_found", 200, headers);
    }

    const upstreamUrl = new URL(`${ITALO_BASE_URL}/api/RicercaStazioneService`);
    upstreamUrl.searchParams.set("CodiceStazione", station.code);

    try {
        const upstream = await fetch(upstreamUrl.toString(), {
            headers: italoFetchHeaders()
        });

        if (!upstream.ok) {
            return unavailable("upstream_error", 200, {
                ...headers,
                "cache-control": "no-store"
            });
        }

        const raw = await upstream.json() as ItaloStationPayload;
        return json({
            available: true,
            provider: "italo",
            station,
            lastUpdate: raw?.LastUpdate || null,
            trains: normalizeItaloStationBoard(raw, station.code, type),
        }, 200, headers);
    } catch {
        return unavailable("upstream_error", 200, {
            ...headers,
            "cache-control": "no-store"
        });
    }
}

export async function onRequest(context: PagesContext): Promise<Response> {
    if (context.request.method === "OPTIONS") return onRequestOptions(context);
    if (context.request.method === "GET") return onRequestGet(context);
    return unavailable("method_not_allowed", 405, {
        ...corsHeaders(context.request),
        "allow": "GET, OPTIONS"
    });
}
