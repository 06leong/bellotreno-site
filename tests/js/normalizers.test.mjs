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
