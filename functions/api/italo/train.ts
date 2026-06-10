import { normalizeItaloTrainPayload, type ItaloTrainPayload } from "../../../src/lib/normalizers/italo.ts";
import {
    ITALO_BASE_URL,
    corsHeaders,
    italoFetchHeaders,
    json,
    requestIsAllowed,
    unavailable,
} from "./_shared.ts";

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
    const trainNumber = (url.searchParams.get("number") || url.searchParams.get("train") || "").replace(/\D+/g, "");
    if (!trainNumber) {
        return unavailable("bad_request", 400, headers);
    }

    const upstreamUrl = new URL(`${ITALO_BASE_URL}/api/RicercaTrenoService`);
    upstreamUrl.searchParams.set("TrainNumber", trainNumber);

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

        const raw = await upstream.json() as ItaloTrainPayload;
        return json(normalizeItaloTrainPayload(raw), 200, headers);
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
