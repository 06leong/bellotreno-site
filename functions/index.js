const SUPPORTED_LOCALES = new Set(["it", "en", "zh"]);
const DEFAULT_LOCALE = "it";
const COOKIE_NAME = "bt_locale";

function readLocaleCookie(cookieHeader) {
    if (!cookieHeader) return null;

    for (const part of cookieHeader.split(";")) {
        const [rawName, ...rawValue] = part.trim().split("=");
        if (rawName !== COOKIE_NAME) continue;

        try {
            const value = decodeURIComponent(rawValue.join("=") || "");
            return SUPPORTED_LOCALES.has(value) ? value : null;
        } catch (error) {
            return null;
        }
    }

    return null;
}

function preferredLocale(acceptLanguage) {
    if (!acceptLanguage) return DEFAULT_LOCALE;

    const candidates = acceptLanguage
        .split(",")
        .map((item) => {
            const [tagPart, ...params] = item.trim().split(";");
            const quality = params
                .map((param) => param.trim().match(/^q=([0-9.]+)$/i))
                .find(Boolean)?.[1];

            return {
                tag: tagPart.toLowerCase(),
                quality: quality ? Number(quality) : 1,
            };
        })
        .filter((item) => item.tag && Number.isFinite(item.quality) && item.quality > 0)
        .sort((left, right) => right.quality - left.quality);

    for (const { tag } of candidates) {
        if (tag === "zh" || tag.startsWith("zh-")) return "zh";
        if (tag === "en" || tag.startsWith("en-")) return "en";
        if (tag === "it" || tag.startsWith("it-")) return "it";
    }

    return DEFAULT_LOCALE;
}

function redirectToLocale(request) {
    const url = new URL(request.url);
    const cookieLocale = readLocaleCookie(request.headers.get("cookie"));
    const locale = cookieLocale || preferredLocale(request.headers.get("accept-language"));

    url.pathname = `/${locale}/`;
    url.hash = "";

    return Response.redirect(url.toString(), 302);
}

export function onRequestGet({ request }) {
    return redirectToLocale(request);
}

export function onRequestHead({ request }) {
    return redirectToLocale(request);
}
