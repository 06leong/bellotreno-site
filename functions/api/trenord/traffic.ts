import CryptoJS from "crypto-js";
import {
    normalizeTrenordTrafficInformation,
    type TrenordDirettrice,
    type TrenordTrafficInformationResult,
} from "../../../src/lib/normalizers/trenord.ts";

const TRAIN_BFF_BASE = "https://www.trenord.it/mia/bff/train";
const DIRETTRICI_URL = "https://www.trenord.it/mgmt/store-management-api/mia/direttrici/";
const DIRETTRICI_TTL_MS = 2 * 60 * 60 * 1000;
const ALLOWED_HOSTS = new Set([
    "bellotreno.org",
    "real.bellotreno.org",
    "bellotreno.pages.dev",
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]"
]);

type CorsHeaderMap = Record<string, string>;
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type TrenordUnavailableResult = { available: false; reason: string } & JsonObject;
type HttpError = Error & { status?: number };

let direttriciCache: {
    expiresAt: number;
    data: TrenordDirettrice[] | null;
    promise: Promise<TrenordDirettrice[]> | null;
} = {
    expiresAt: 0,
    data: null,
    promise: null
};

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "public, max-age=120",
            ...extraHeaders
        }
    });
}

function unavailable(reason: string, extra: JsonObject = {}, status = 200, headers: HeadersInit = {}): Response {
    return json({ available: false, reason, ...extra }, status, headers);
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
    return hostname === requestHost || ALLOWED_HOSTS.has(hostname);
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

function arrayBufferToWordArray(buffer: ArrayBuffer): CryptoJS.lib.WordArray {
    const bytes = new Uint8Array(buffer);
    const words: number[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
        words[index >>> 2] |= bytes[index] << (24 - (index % 4) * 8);
    }
    return CryptoJS.lib.WordArray.create(words, bytes.length);
}

export function decryptTrenordBffPayload(buffer: ArrayBuffer, secret: string): unknown {
    if (!secret) throw new Error("missing_secret");

    let text = "";
    try {
        const ciphertext = arrayBufferToWordArray(buffer);
        const key = CryptoJS.SHA256(secret);
        const decrypted = CryptoJS.AES.decrypt(
            { ciphertext } as CryptoJS.lib.CipherParams,
            key,
            { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
        );
        text = CryptoJS.enc.Utf8.stringify(decrypted);
    } catch {
        throw new Error("decrypt_failed");
    }

    if (!text) throw new Error("decrypt_failed");

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("json_parse_failed");
    }
}

export async function fetchTrenordTrainBff(trainNumber: string, date: string, secret: string): Promise<unknown> {
    const train = String(trainNumber || "").replace(/\D+/g, "");
    if (!train || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
        throw new Error("bad_request");
    }

    const url = new URL(`${TRAIN_BFF_BASE}/${encodeURIComponent(train)}`);
    url.searchParams.set("date", date);

    const response = await fetch(url.toString(), {
        headers: {
            "accept": "application/json, text/plain, */*",
            "referer": "https://www.trenord.it/en/routes-and-timetables/journey/real-time/",
            "user-agent": "Mozilla/5.0"
        }
    });

    if (!response.ok) {
        const error: HttpError = new Error("upstream_train_bff_error");
        error.status = response.status;
        throw error;
    }

    return decryptTrenordBffPayload(await response.arrayBuffer(), secret);
}

function normalizeDirettriciPayload(payload: unknown): TrenordDirettrice[] {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];

    const record = payload as { items?: unknown; data?: unknown; [key: string]: unknown };
    if (Array.isArray(record.items)) return record.items as TrenordDirettrice[];
    if (Array.isArray(record.data)) return record.data as TrenordDirettrice[];
    return Object.values(record).filter((item): item is TrenordDirettrice => Boolean(
        item && typeof item === "object" && "nome" in item
    ));
}

export async function fetchTrenordDirettrici(): Promise<TrenordDirettrice[]> {
    const now = Date.now();
    if (direttriciCache.data && direttriciCache.expiresAt > now) {
        return direttriciCache.data;
    }
    if (direttriciCache.promise) {
        return direttriciCache.promise;
    }

    direttriciCache.promise = fetch(DIRETTRICI_URL, {
        headers: {
            "accept": "application/json, text/plain, */*",
            "referer": "https://www.trenord.it/en/routes-and-timetables/journey/real-time/",
            "user-agent": "Mozilla/5.0"
        }
    }).then(async (response) => {
        if (!response.ok) {
            const error: HttpError = new Error("upstream_direttrici_error");
            error.status = response.status;
            throw error;
        }

        const data = normalizeDirettriciPayload(await response.json());
        direttriciCache = {
            expiresAt: Date.now() + DIRETTRICI_TTL_MS,
            data,
            promise: null
        };
        return data;
    }).catch((error) => {
        direttriciCache.promise = null;
        throw error;
    });

    return direttriciCache.promise;
}

export async function getTrenordTrafficInformation(trainNumber: string, date: string, secret: string): Promise<TrenordTrafficInformationResult> {
    const [trainPayload, direttrici] = await Promise.all([
        fetchTrenordTrainBff(trainNumber, date, secret),
        fetchTrenordDirettrici()
    ]);

    return normalizeTrenordTrafficInformation(
        String(trainNumber || "").replace(/\D+/g, ""),
        String(date || ""),
        trainPayload,
        direttrici
    );
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
        return unavailable("forbidden", {}, 403, headers);
    }

    const url = new URL(request.url);
    const trainNumber = (url.searchParams.get("train") || "").replace(/\D+/g, "");
    const date = (url.searchParams.get("date") || "").trim();

    if (!trainNumber || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return unavailable("bad_request", {}, 400, headers);
    }

    const secret = context.env.TRENORD_BFF_SECRET;
    if (!secret) {
        return unavailable("not_configured", {}, 200, {
            ...headers,
            "cache-control": "no-store"
        });
    }

    try {
        const result = await getTrenordTrafficInformation(trainNumber, date, secret);
        return json(result, 200, headers);
    } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "upstream_error";
        return unavailable(reason, {}, 200, {
            ...headers,
            "cache-control": "no-store"
        });
    }
}

export async function onRequest(context: PagesContext): Promise<Response> {
    if (context.request.method === "OPTIONS") {
        return onRequestOptions(context);
    }
    if (context.request.method === "GET") {
        return onRequestGet(context);
    }
    return unavailable("method_not_allowed", {}, 405, {
        ...corsHeaders(context.request),
        "allow": "GET, OPTIONS"
    });
}
