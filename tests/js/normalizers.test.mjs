import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_ORDER,
  categoryCode,
  chartCategoryCode,
  normalizeCategoryCounts,
  statisticsCategoryColor,
} from "../../src/lib/normalizers/statistics.js";
import {
  buildPartialCancellationState,
  normalizeStationMatchName,
} from "../../src/lib/normalizers/viaggiatreno.js";
import {
  hasSwissHint,
  isSwissBoundaryName,
  mergeSwissVehicleRecords,
  normalizeSwissStationName,
  shouldQuerySwissFormation,
} from "../../src/lib/normalizers/swiss.js";
import {
  extractTrenordNoticeUrls,
  filterTrenordNoticesForDisplay,
  normalizeTrenordTrafficInformation,
} from "../../src/lib/normalizers/trenord.js";

test("statistics category helpers preserve special categories and regional aliases", () => {
  assert.equal(categoryCode("ECFR"), "EC FR");
  assert.equal(categoryCode("ec-fr"), "EC FR");
  assert.equal(chartCategoryCode("RE"), "REG");
  assert.equal(chartCategoryCode("RV"), "REG");
  assert.ok(CATEGORY_ORDER.includes("IR"));
  assert.ok(CATEGORY_ORDER.includes("NCL"));
  assert.ok(CATEGORY_ORDER.includes("TS"));
  assert.equal(statisticsCategoryColor("EC FR"), statisticsCategoryColor("FR"));

  assert.deepEqual(normalizeCategoryCounts([
    { label: "RE", value: 2 },
    { label: "RV", value: 3 },
    { label: "IR", value: 1 },
    { label: "EC FR", value: 4 },
  ]), [
    { label: "REG", value: 5 },
    { label: "EC FR", value: 4 },
    { label: "IR", value: 1 },
  ]);
});

test("station name matching is accent and punctuation tolerant", () => {
  assert.equal(normalizeStationMatchName("DOMEGLIARA-S. AMBROGIO"), "DOMEGLIARA S AMBROGIO");
  assert.equal(normalizeStationMatchName("Genova Brignole"), "GENOVA BRIGNOLE");
});

test("partial cancellation before actual start is marked as cancelled", () => {
  const stops = [
    { stazione: "SESTRI LEVANTE" },
    { stazione: "LAVAGNA" },
    { stazione: "GENOVA BRIGNOLE" },
    { stazione: "MILANO CENTRALE" },
  ];
  const state = buildPartialCancellationState({
    subTitle: "Treno cancellato da SESTRI LEVANTE a GENOVA BRIGNOLE. Parte da GENOVA BRIGNOLE.",
  }, stops);

  assert.equal(state[0].cancelled, true);
  assert.equal(state[1].cancelled, true);
  assert.equal(state[2].cancelled, false);
  assert.equal(state[2].boundary, "actualStart");
  assert.equal(state[3].cancelled, false);
});

test("partial cancellation after actual end is marked as cancelled", () => {
  const stops = [
    { stazione: "MILANO PORTA GARIBALDI" },
    { stazione: "SEREGNO" },
    { stazione: "SARONNO" },
  ];
  const state = buildPartialCancellationState({
    subTitle: "Treno cancellato da SEREGNO a SARONNO. Arriva a SEREGNO",
  }, stops);

  assert.equal(state[0].cancelled, false);
  assert.equal(state[1].cancelled, false);
  assert.equal(state[1].boundary, "actualEnd");
  assert.equal(state[2].cancelled, true);
});

test("cropped replacement journey marks the first visible stop as replacement start", () => {
  const state = buildPartialCancellationState({
    subTitle: "Treno cancellato da TRENTO a ALA. Viaggio con cambio di treno",
  }, [
    { stazione: "ALA" },
    { stazione: "DOMEGLIARA-S. AMBROGIO" },
    { stazione: "VERONA PORTA NUOVA" },
  ]);

  assert.equal(state[0].cancelled, false);
  assert.equal(state[0].boundary, "replacementStart");
  assert.equal(state[1].cancelled, false);
});

test("Swiss boundary protection excludes non-continuation stations", () => {
  assert.equal(isSwissBoundaryName("Porto Ceresio"), false);
  assert.equal(isSwissBoundaryName("Ponte Tresa"), false);
  assert.equal(isSwissBoundaryName("Gaggiolo"), false);
  assert.equal(isSwissBoundaryName("Stabio"), true);
  assert.equal(normalizeSwissStationName("Staz. della Galleria Sempione"), "DOMODOSSOLA");
});

test("Swiss formation query gate requires category/date and border hints for regional trains", () => {
  const base = {
    numeroTreno: "2510",
    dataPartenzaTreno: Date.parse("2026-05-21T05:30:00+02:00"),
    categoria: "REG",
    origine: "MILANO PORTA GARIBALDI",
    destinazione: "PORTO CERESIO",
    fermate: [{ stazione: "PORTO CERESIO" }],
  };

  assert.equal(hasSwissHint(base), false);
  assert.equal(shouldQuerySwissFormation(base, "REG", "2026-05-21"), false);
  assert.equal(shouldQuerySwissFormation({ ...base, destinazione: "STABIO" }, "REG", "2026-05-21"), true);
  assert.equal(shouldQuerySwissFormation({ ...base, categoria: "EC" }, "EC", "2026-05-21"), true);
});

test("Swiss vehicle records merge by EVN without global closed pollution", () => {
  const merged = mergeSwissVehicleRecords([
    {
      evn: "93 85 1 501 222-8",
      position: 12,
      number: 31,
      closed: true,
      segments: [{ fromStop: "Chiasso Olimpino I", toStop: "Chiasso", closed: true }],
    },
    {
      evn: "93 85 1 501 222-8",
      position: 1,
      number: 31,
      closed: false,
      segments: [{ fromStop: "Chiasso", toStop: "Zurich HB", closed: false }],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].closed, false);
  assert.equal(merged[0].segments.length, 2);
});

test("Trenord traffic information resolves S9 primary direttrice", () => {
  const result = normalizeTrenordTrafficInformation("24946", "2026-05-25", {
    journey_list: [{
      train: {
        train_id: "24946",
        train_category: "S9",
        line: "S9",
        train_operator: "Trenord",
        direttrice: "D038",
        direttrice_security: "D002",
      },
    }],
  }, [
    {
      nome: "D038",
      descrizione: "SARONNO-SEREGNO-MILANO-ALBAIRATE",
      news: [{
        description: "Si informa la Gentile Clientela che il servizio e regolare.",
        date: "2026-05-25T08:00:00.000Z",
        severity_code: 1,
        severity_description: "info",
      }],
    },
  ]);

  assert.equal(result.available, true);
  assert.equal(result.direttrice, "D038");
  assert.equal(result.direttriceDescription, "SARONNO-SEREGNO-MILANO-ALBAIRATE");
  assert.equal(result.matchSource, "primary-direttrice");
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].severityLevel, "info");
});

test("Trenord traffic information resolves RE primary direttrice", () => {
  const result = normalizeTrenordTrafficInformation("2634", "2026-05-25", {
    journey_list: [{
      train: {
        train_id: "2634",
        train_category: "RE",
        line: "RE",
        train_operator: "Trenord",
        direttrice: "D014",
        direttrice_security: "D014",
      },
    }],
  }, [
    {
      nome: "D014",
      descrizione: "VERONA-BRESCIA-TREVIGLIO-MILANO",
      news: [{
        description: "Avviso linea Verona - Milano https://www.trenord.it/example.pdf",
        date: "2026-05-25T09:00:00.000Z",
        severity_code: 2,
        severity_description: "warning",
      }],
    },
  ]);

  assert.equal(result.direttrice, "D014");
  assert.equal(result.direttriceDescription, "VERONA-BRESCIA-TREVIGLIO-MILANO");
  assert.equal(result.notices[0].severityLevel, "warning");
  assert.deepEqual(result.notices[0].urls, ["https://www.trenord.it/example.pdf"]);
});

test("Trenord traffic information prefers train record with direttrice", () => {
  const result = normalizeTrenordTrafficInformation("2237", "2026-05-25", {
    journey_list: [
      { train: { train_id: "2237", train_category: "RE" } },
      { train: { train_id: "2237", train_category: "RE", direttrice: "D014" } },
    ],
  }, [
    {
      nome: "D014",
      descrizione: "VERONA-BRESCIA-TREVIGLIO-MILANO",
      news: [{
        description: "RE line notice",
        date: "2026-05-23T12:00:00.000Z",
        severity_description: "info",
      }],
    },
  ]);

  assert.equal(result.available, true);
  assert.equal(result.direttrice, "D014");
  assert.equal(result.direttriceDescription, "VERONA-BRESCIA-TREVIGLIO-MILANO");
});

test("Trenord traffic information finds direttrice in nested payload wrappers", () => {
  const result = normalizeTrenordTrafficInformation("24946", "2026-05-25", [{
    payload: {
      result: {
        journey_list: [{
          train: {
            train_id: "24946",
            train_category: "S9",
            line: "S9",
            direttrice: "D038",
            direttrice_security: "D002",
          },
        }],
      },
    },
  }], [
    {
      nome: "D038",
      descrizione: "SARONNO-SEREGNO-MILANO-ALBAIRATE",
      news: [{
        description: "Nested payload notice",
        date: "2026-05-25T12:00:00.000Z",
        severity_description: "info",
      }],
    },
  ]);

  assert.equal(result.available, true);
  assert.equal(result.line, "S9");
  assert.equal(result.direttrice, "D038");
  assert.equal(result.direttriceDescription, "SARONNO-SEREGNO-MILANO-ALBAIRATE");
});

test("Trenord notice display keeps today first or recent 14-day notices", () => {
  const notices = [
    { id: "old", source: "trenord-direttrici", direttriceCode: "D014", direttriceDescription: "Line", description: "old", date: "2026-04-10T12:00:00.000Z", severityLevel: "info", urls: [] },
    { id: "recent", source: "trenord-direttrici", direttriceCode: "D014", direttriceDescription: "Line", description: "recent", date: "2026-05-23T12:00:00.000Z", severityLevel: "info", urls: [] },
    { id: "today", source: "trenord-direttrici", direttriceCode: "D014", direttriceDescription: "Line", description: "today", date: "2026-05-25T12:00:00.000Z", severityLevel: "info", urls: [] },
  ];

  assert.deepEqual(filterTrenordNoticesForDisplay(notices, "2026-05-25").map((notice) => notice.id), ["today"]);
  assert.deepEqual(filterTrenordNoticesForDisplay(notices.slice(0, 2), "2026-05-25").map((notice) => notice.id), ["recent"]);
});

test("Trenord primary with only old notices does not fall back to security line", () => {
  const result = normalizeTrenordTrafficInformation("2237", "2026-05-25", {
    journey_list: [{ train: { train_id: "2237", direttrice: "D014", direttrice_security: "D002" } }],
  }, [
    {
      nome: "D014",
      descrizione: "VERONA-BRESCIA-TREVIGLIO-MILANO",
      news: [{ description: "Old primary", date: "2026-04-01T12:00:00.000Z", severity_description: "info" }],
    },
    {
      nome: "D002",
      descrizione: "MILANO-NOVARA",
      news: [{ description: "Recent security", date: "2026-05-23T12:00:00.000Z", severity_description: "warning" }],
    },
  ]);

  assert.equal(result.available, true);
  assert.equal(result.matchSource, "primary-direttrice");
  assert.equal(result.direttrice, "D014");
  assert.equal(result.notices.length, 0);
});

test("Trenord traffic information uses security direttrice only as fallback", () => {
  const result = normalizeTrenordTrafficInformation("24946", "2026-05-25", {
    journey_list: [{
      train: {
        train_id: "24946",
        line: "S9",
        direttrice: "D038",
        direttrice_security: "D002",
      },
    }],
  }, [
    {
      nome: "D038",
      descrizione: "SARONNO-SEREGNO-MILANO-ALBAIRATE",
      news: [],
    },
    {
      nome: "D002",
      descrizione: "MILANO-NOVARA",
      news: [{
        description: "Fallback notice",
        date: "2026-05-25T10:00:00.000Z",
        severity_description: "critical",
      }],
    },
  ]);

  assert.equal(result.matchSource, "security-direttrice-fallback");
  assert.equal(result.direttrice, "D002");
  assert.equal(result.direttriceDescription, "MILANO-NOVARA");
  assert.equal(result.notices[0].severityLevel, "disruption");
});

test("Trenord notices extract URLs, keep stable ids, and sort by date", () => {
  const direttrici = [{
    nome: "D038",
    descrizione: "SARONNO-SEREGNO-MILANO-ALBAIRATE",
    news: [
      {
        description: "Older notice https://a.mktgcdn.com/old.pdf.",
        date: "2026-04-10T14:31:55.000Z",
        severity_description: "info",
      },
      {
        description: "Newer notice https://www.trenord.it/new.pdf, short https://t.co/abc",
        date: "2026-05-25T14:31:55.000Z",
        severity_description: "warning",
      },
    ],
  }];
  const payload = { journey_list: [{ train: { direttrice: "D038" } }] };
  const left = normalizeTrenordTrafficInformation("24946", "2026-05-25", payload, direttrici);
  const right = normalizeTrenordTrafficInformation("24946", "2026-05-25", payload, direttrici);

  assert.equal(left.notices[0].description.startsWith("Newer notice"), true);
  assert.deepEqual(left.notices[0].urls, ["https://www.trenord.it/new.pdf", "https://t.co/abc"]);
  assert.deepEqual(extractTrenordNoticeUrls("See https://a.mktgcdn.com/file.pdf."), ["https://a.mktgcdn.com/file.pdf"]);
  assert.equal(left.notices[0].id, right.notices[0].id);
});

test("Trenord traffic information preserves matched line with empty notices", () => {
  const result = normalizeTrenordTrafficInformation("24946", "2026-05-25", {
    journey_list: [{ train: { direttrice: "D038", direttrice_security: "D002" } }],
  }, [{
    nome: "D038",
    descrizione: "SARONNO-SEREGNO-MILANO-ALBAIRATE",
    news: [],
  }]);

  assert.equal(result.available, true);
  assert.equal(result.matchSource, "primary-direttrice");
  assert.equal(result.notices.length, 0);
});

test("Trenord traffic information reports why no direttrice matched", () => {
  const noDirettrice = normalizeTrenordTrafficInformation("2237", "2026-05-25", {
    journey_list: [{ train: { train_id: "2237" } }],
  }, []);
  assert.equal(noDirettrice.available, false);
  assert.equal(noDirettrice.matchSource, "none");
  assert.equal(noDirettrice.reason, "no_direttrice_in_train_payload");

  const missingDirettrice = normalizeTrenordTrafficInformation("2237", "2026-05-25", {
    journey_list: [{ train: { train_id: "2237", direttrice: "D999" } }],
  }, []);
  assert.equal(missingDirettrice.available, false);
  assert.equal(missingDirettrice.matchSource, "none");
  assert.equal(missingDirettrice.reason, "direttrice_not_found");
});
