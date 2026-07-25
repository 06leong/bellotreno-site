import assert from "node:assert/strict";
import test from "node:test";
import {
    extractWSessionId,
    normalizeLeFrecceOnboardDetail,
    rfiStationIdToLeFrecceId,
    selectLeFrecceSolution,
    selectLeFrecceTrainDetail,
} from "../../src/lib/normalizers/lefrecce.ts";
import { requestIsAllowed } from "../../functions/api/trenitalia/_shared.ts";
import { onRequestGet } from "../../functions/api/trenitalia/onboard.ts";

interface ServiceFixture {
    expectedAmenities: string[];
    expectedClassServices: string[];
    expectedLevels: string[];
    expectedStock: string | null;
    number: string;
    services: string[];
}

const commonWheelchair = "Treno con carrozza dotata di posto attrezzato e bagno accessibile per passeggeri su sedia a ruote.";
const commonBar = "Treno con servizio bar.";

test("allows same-origin API calls after a Cloudflare Access redirect", () => {
    const request = new Request("https://preview.bellotreno-site.pages.dev/api/trenitalia/onboard", {
        headers: {
            referer: "https://example.cloudflareaccess.com/",
            "sec-fetch-site": "same-origin",
        },
    });
    assert.equal(requestIsAllowed(request), true);
});

test("does not trust a Cloudflare Access referrer for cross-site API calls", () => {
    const request = new Request("https://preview.bellotreno-site.pages.dev/api/trenitalia/onboard", {
        headers: {
            referer: "https://example.cloudflareaccess.com/",
            "sec-fetch-site": "cross-site",
        },
    });
    assert.equal(requestIsAllowed(request), false);
});

test("allows Pages Functions calls when Cloudflare strips navigation metadata", () => {
    const request = new Request("https://preview.bellotreno-site.pages.dev/api/trenitalia/onboard");
    assert.equal(requestIsAllowed(request), true);
});

test("rejects metadata-free requests addressed to unknown hosts", () => {
    const request = new Request("https://example.com/api/trenitalia/onboard");
    assert.equal(requestIsAllowed(request), false);
});

const serviceFixtures: ServiceFixture[] = [
    {
        number: "9303",
        services: [
            "Treno con 4 livelli di servizio: Executive, Business, Premium e Standard",
            commonWheelchair,
            commonBar,
            "Treno effettuato con ETR 1000",
            "Servizio di ristorazione incluso nel livello Executive",
            "Servizio di benvenuto nel livello Business",
            "Ristorazione Premium",
        ],
        expectedStock: "etr-1000",
        expectedLevels: ["executive", "business", "premium", "standard"],
        expectedAmenities: ["wheelchair-accessible", "bar"],
        expectedClassServices: ["executive-meal", "business-welcome", "premium-catering"],
    },
    {
        number: "9607",
        services: [
            "Treno con 4 livelli di servizio: Executive, Business, Premium e Standard",
            commonWheelchair,
            "Servizio di minibar lungo il treno.",
            commonBar,
            "Treno effettuato con ETR500.",
            "Servizio di ristorazione incluso nel livello Executive",
            "Ristorazione Business Full",
            "Ristorazione Premium",
            "Servizio di ristorazione al posto disponibile ordinando dal portale FRECCIAPlay",
        ],
        expectedStock: "etr-500",
        expectedLevels: ["executive", "business", "premium", "standard"],
        expectedAmenities: ["wheelchair-accessible", "minibar", "bar", "seat-service"],
        expectedClassServices: ["executive-meal", "business-catering", "premium-catering"],
    },
    {
        number: "9703",
        services: [
            commonWheelchair,
            commonBar,
            "Treno con 3 livelli di servizio: Business, Premium e Standard",
            "Treno effettuato con ETR 700",
            "Servizio di benvenuto nel livello Business",
            "Ristorazione Premium",
        ],
        expectedStock: "etr-700",
        expectedLevels: ["business", "premium", "standard"],
        expectedAmenities: ["wheelchair-accessible", "bar"],
        expectedClassServices: ["business-welcome", "premium-catering"],
    },
    {
        number: "9757",
        services: [
            commonWheelchair,
            commonBar,
            "Treno con 3 livelli di servizio: Business, Premium e Standard",
            "Treno effettuato con materiale ETR 600.",
            "Servizio di benvenuto nel livello Business",
            "Ristorazione Premium",
        ],
        expectedStock: "etr-600",
        expectedLevels: ["business", "premium", "standard"],
        expectedAmenities: ["wheelchair-accessible", "bar"],
        expectedClassServices: ["business-welcome", "premium-catering"],
    },
    {
        number: "301",
        services: [
            "Treno con 2 livelli di servizio",
            commonWheelchair,
            "Treno con servizio ristorante.",
            commonBar,
            "Il servizio di trasporto biciclette è soggetto a limitazione.",
            "Materiale Giruno",
        ],
        expectedStock: "giruno-rabe-501",
        expectedLevels: [],
        expectedAmenities: ["wheelchair-accessible", "restaurant", "bar", "bicycle"],
        expectedClassServices: [],
    },
    {
        number: "141",
        services: [
            "Treno con 2 livelli di servizio",
            commonWheelchair,
            "Treno con servizio ristorante.",
            commonBar,
            "Il servizio di trasporto biciclette è soggetto a limitazione.",
            "In servizio interno Italia si applica la normativa prevista per i treni del trasporto nazionale.",
        ],
        expectedStock: null,
        expectedLevels: [],
        expectedAmenities: ["wheelchair-accessible", "restaurant", "bar", "bicycle"],
        expectedClassServices: [],
    },
];

for (const fixture of serviceFixtures) {
    test(`normalizes LeFrecce onboard services for train ${fixture.number}`, () => {
        const payload = normalizeLeFrecceOnboardDetail({
            services: fixture.services.map((description) => ({
                description,
                imageData: "data intentionally ignored",
            })),
            stops: [{ name: "must not escape the normalizer" }],
        }, {
            fetchedAt: "2026-07-25T12:00:00.000Z",
            operationDate: "2026-07-26",
            trainNumber: fixture.number,
        });

        assert.equal(payload.rollingStock?.code ?? null, fixture.expectedStock);
        assert.deepEqual(payload.serviceLevels, fixture.expectedLevels);
        assert.deepEqual(payload.amenities.map((item) => item.code), fixture.expectedAmenities);
        assert.deepEqual(payload.classServices.map((item) => item.code), fixture.expectedClassServices);
        assert.equal("stops" in payload, false);
        assert.equal(JSON.stringify(payload).includes("imageData"), false);
    });
}

test("converts ViaggiaTreno S station IDs to LeFrecce UIC IDs", () => {
    assert.equal(rfiStationIdToLeFrecceId("S01700"), 830001700);
    assert.equal(rfiStationIdToLeFrecceId("s01820"), 830001820);
    assert.equal(rfiStationIdToLeFrecceId("S08409"), 830008409);
    assert.equal(rfiStationIdToLeFrecceId("Milano"), null);
});

test("extracts only WSESSIONID from combined Set-Cookie headers", () => {
    const header = "foo=bar; Path=/, WSESSIONID=abc123_XYZ; Path=/; Secure; HttpOnly, other=value";
    assert.equal(extractWSessionId(header), "abc123_XYZ");
    assert.equal(extractWSessionId("foo=bar"), null);
});

function searchSolution(id: string, number = "9303") {
    return {
        solution: {
            id,
            departureTime: "2026-07-26T06:00:00+02:00",
            arrivalTime: "2026-07-26T10:35:00+02:00",
            departureLocationId: 830001820,
            arrivalLocationId: 830008409,
            trains: [{ description: number }],
        },
    };
}

const solutionCriteria = {
    arrivalAt: "2026-07-26T08:35:00.000Z",
    departureAt: "2026-07-26T04:00:00.000Z",
    destinationId: 830008409,
    destinationName: "Roma Termini",
    operationDate: "2026-07-26",
    originId: 830001820,
    originName: "Milano Rogoredo",
    trainNumber: "9303",
};

test("strictly selects one solution and one train segment", () => {
    const solution = selectLeFrecceSolution({ solutions: [searchSolution("solution-1")] }, solutionCriteria);
    assert.equal(solution.status, "matched");

    const segment = selectLeFrecceTrainDetail([
        { summary: { trainInfo: { description: "Regionale 123" } } },
        { summary: { trainInfo: { description: "Frecciarossa 9303" } }, services: [] },
    ], "9303");
    assert.equal(segment.status, "matched");
});

test("rejects ambiguous solution and train-segment matches", () => {
    assert.equal(
        selectLeFrecceSolution({
            solutions: [searchSolution("solution-1"), searchSolution("solution-2")],
        }, solutionCriteria).status,
        "ambiguous",
    );
    assert.equal(
        selectLeFrecceTrainDetail([
            { summary: { trainInfo: { description: "Frecciarossa 9303" } } },
            { summary: { trainInfo: { description: "Frecciarossa 9303" } } },
        ], "9303").status,
        "ambiguous",
    );
});

test("preserves unknown official service descriptions as Italian notes", () => {
    const rawNote = "Informazione ufficiale non ancora classificata.";
    const payload = normalizeLeFrecceOnboardDetail({
        services: [{ description: rawNote }],
    }, {
        operationDate: "2026-07-26",
        trainNumber: "141",
    });
    assert.deepEqual(payload.notes, [rawNote]);
});

test("honors the emergency kill switch before contacting the upstream", async () => {
    const response = await onRequestGet({
        request: new Request("http://localhost/api/trenitalia/onboard"),
        env: { TRENITALIA_LEFRECCE_ENABLED: "FALSE" },
    } as PagesContext);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        available: false,
        provider: "trenitalia-lefrecce",
        reason: "disabled",
    });
});

test("orchestrates the LeFrecce session and exposes only normalized JSON", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/ticket/solutions")) {
            assert.equal(init?.method, "POST");
            return new Response(JSON.stringify({
                cartId: "private-cart",
                prices: [{ amount: 102 }],
                solutions: [{
                    solution: {
                        ...searchSolution("private-solution", "9607").solution,
                        departureTime: "2026-07-26T07:00:00+02:00",
                        arrivalTime: "2026-07-26T10:11:00+02:00",
                        departureLocationId: 830001700,
                    },
                }],
            }), {
                headers: {
                    "content-type": "application/json",
                    "set-cookie": "WSESSIONID=private-session; Path=/; Secure; HttpOnly",
                },
            });
        }

        assert.match(url, /\/stops\?/);
        assert.match(url, /cartId=private-cart/);
        assert.match(url, /solutionId=private-solution/);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("cookie"), "WSESSIONID=private-session");
        return new Response(JSON.stringify([{
            summary: { trainInfo: { description: "Frecciarossa 9607" } },
            stops: [{ name: "private stop list" }],
            services: [
                { imageData: "private base64", description: "Treno effettuato con ETR500." },
                { description: "Treno con servizio bar." },
            ],
        }]), {
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await onRequestGet({
            request: new Request(
                "http://localhost/api/trenitalia/onboard"
                + "?number=9607&date=2026-07-26"
                + "&departureAt=2026-07-26T05%3A00%3A00.000Z"
                + "&arrivalAt=2026-07-26T08%3A11%3A00.000Z"
                + "&originId=S01700&originName=Milano%20Centrale"
                + "&destinationId=S08409&destinationName=Roma%20Termini",
            ),
            env: {},
        } as PagesContext);
        assert.equal(response.status, 200);
        const payload = await response.json() as Record<string, unknown>;
        assert.equal(payload.available, true);
        assert.equal((payload.rollingStock as Record<string, unknown>).code, "etr-500");
        const serialized = JSON.stringify(payload);
        for (const privateValue of [
            "private-cart",
            "private-solution",
            "private-session",
            "private base64",
            "private stop list",
            "\"prices\"",
        ]) {
            assert.equal(serialized.includes(privateValue), false);
        }
        assert.equal(requestedUrls.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("returns an unavailable payload when the LeFrecce upstream fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new TypeError("simulated network failure");
    };

    try {
        const request = new Request(
            "http://localhost/api/trenitalia/onboard"
            + "?number=9303&date=2026-07-26"
            + "&departureAt=2026-07-26T04%3A00%3A00.000Z"
            + "&arrivalAt=2026-07-26T08%3A35%3A00.000Z"
            + "&originId=S01820&originName=Milano%20Rogoredo"
            + "&destinationId=S08409&destinationName=Roma%20Termini",
        );
        const response = await onRequestGet({
            request,
            env: {},
        } as PagesContext);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            available: false,
            provider: "trenitalia-lefrecce",
            reason: "upstream_unavailable",
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
