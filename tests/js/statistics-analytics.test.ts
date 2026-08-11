import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAnalyticsPercent,
  normalizeAnalyticsExplore,
  normalizeAnalyticsOverview,
  percentagePointChange
} from "../../src/lib/normalizers/statistics-analytics.ts";

function metric(percent = 82.5) {
  const rate = { numerator: 82, denominator: 100, percent, confidence95: { low: 74, high: 89 } };
  return {
    serviceDays: 1,
    observedServices: 110,
    outcomeEligibleServices: 100,
    excludedServices: 10,
    completedServices: 98,
    arrivalSample: 90,
    punctuality: { within5: rate, within15: rate },
    cancellation: { ...rate, numerator: 2, percent: 2 },
    severeDelay: { over30: rate, over60: rate, over120: rate },
    delayMinutes: { p50: 3, p75: 7, p90: 16, p95: 27, mean: 6.5 },
    distribution: [{ key: "0_5", count: 60 }]
  };
}

test("analytics overview preserves denominators and excluded evidence", () => {
  const normalized = normalizeAnalyticsOverview({
    available: true,
    build: { buildId: "build", builtAt: "2026-08-09T00:00:00Z", metricDefinitionVersion: "v1", sourceManifests: ["one"] },
    context: {
      asOfDate: "2026-08-08",
      windowDays: 28,
      windowStart: "2026-07-12",
      previousAsOfDate: "2026-07-11",
      previousWindowStart: "2026-06-14",
      windowComplete: true,
      previousWindowComplete: true,
      filter: { type: null, key: null }
    },
    current: metric(),
    previous: metric(80),
    series: [{ date: "2026-08-08", ...metric() }],
    quality: { days: 28, completeDays: 27, partialDays: 1, items: [] },
    disclaimer: "observable"
  });

  assert.equal(normalized.current.arrivalSample, 90);
  assert.equal(normalized.current.excludedServices, 10);
  assert.equal(normalized.current.punctuality.within5.denominator, 100);
  assert.equal(normalized.series[0]?.date, "2026-08-08");
});

test("analytics overview fails closed for unsupported windows", () => {
  assert.throws(() => normalizeAnalyticsOverview({
    available: true,
    build: {},
    context: { windowDays: 30 },
    quality: {}
  }), /Invalid analytics/);
});

test("analytics display helpers preserve missing values and percentage points", () => {
  assert.equal(percentagePointChange(82.5, 80), 2.5);
  assert.equal(percentagePointChange(null, 80), null);
  assert.equal(formatAnalyticsPercent(null, "en"), "—");
  assert.equal(formatAnalyticsPercent(82.55, "en"), "82.6%");
});

test("analytics exploration preserves station roles, service identity and null evidence", () => {
  const compact = {
    observedServices: 100,
    outcomeEligibleServices: 90,
    arrivalSample: 80,
    punctuality: {
      within5: { numerator: 60, denominator: 80, percent: 75, confidence95: null },
      within15: { numerator: 72, denominator: 80, percent: 90, confidence95: null }
    },
    cancellation: { numerator: 2, denominator: 90, percent: 2.2, confidence95: null },
    severeDelay: {
      over30: { numerator: 8, denominator: 80, percent: 10, confidence95: null },
      over60: { numerator: 3, denominator: 80, percent: 3.75, confidence95: null },
      over120: { numerator: 1, denominator: 80, percent: 1.25, confidence95: null }
    },
    delayMinutes: { p50: 4, p75: 8, p90: 20, p95: 35, mean: 9 }
  };
  const service = {
    service_date: "2026-08-08",
    train_key: "799-S00219-1783893600000",
    train_number: "799",
    operator: "4",
    category: "IC",
    origin: "TORINO PORTA NUOVA",
    destination: "SALERNO",
    origin_code: "S00219",
    destination_code: "S01700",
    relation_key: "TORINO PORTA NUOVA -> SALERNO",
    status: "delayed",
    cancelled: 0,
    completed: 1,
    final_arrival_delay: 90,
    final_departure_delay: 20,
    scheduled_departure: "2026-08-08T20:00:00+02:00",
    scheduled_arrival: "2026-08-09T06:00:00+02:00",
    observation_count: 12
  };
  const normalized = normalizeAnalyticsExplore({
    available: true,
    asOfDate: "2026-08-08",
    windowDays: 28,
    filter: { type: null, key: null },
    composition: {
      activeOperators: 4,
      operators: [{ key: "4", label: "4", sharePercent: 30, ...compact }],
      categories: [{ key: "IC", label: "IC", sharePercent: 20, ...compact }],
      matrix: [{ operator: "4", category: "IC", ...compact }]
    },
    rhythm: [{ weekday: 0, hour: 20, ...compact }],
    categoryRhythm: [{ category: "IC", weekday: 0, hour: 20, ...compact }],
    network: {
      stations: [{
        key: "S01700", label: "SALERNO", observedServices: 100,
        previousObservedServices: 90, arrivalSample: 80,
        roles: { arrivals: 30, departures: 20, transits: 50, arrivalPercent: 30, departurePercent: 20, transitPercent: 50 },
        punctuality: { within5: compact.punctuality.within5 },
        cancellation: compact.cancellation,
        delayMinutes: { p50: 4, p90: null }
      }],
      relations: [{ key: service.relation_key, label: service.relation_key, previousObservedServices: 90, crossMidnightServices: 20, recovery: { sample: 70, recoveredServices: 30, meanMinutes: -2.5, p50Minutes: -1 }, ...compact }],
      stationRhythm: { stationCode: "S01700", stationLabel: "SALERNO", filterScope: "all_services", items: [{ weekday: 0, hour: 6, observed_services: 30, arrivals: 10, departures: 5, transits: 15 }] }
    },
    services: {
      crossMidnight: { numerator: 20, denominator: 100, percent: 20, previousPercent: 18, durationSample: 90, durationMeanMinutes: 220, durationP90Minutes: 600 },
      longestJourneys: [{ ...service, scheduled_duration_minutes: 600, cross_midnight: 1, delay_change: 70 }],
      recoveryRelations: [{ key: service.relation_key, label: service.relation_key, previousObservedServices: 90, crossMidnightServices: 20, recovery: { sample: 70, recoveredServices: 30, meanMinutes: -2.5, p50Minutes: -1 }, ...compact }],
      spotlight: { service, stops: [{ service_date: service.service_date, train_key: service.train_key, stop_number: 0, station_code: "S00219", station_name: "TORINO PORTA NUOVA", stop_type: "origine", platform: "1", arrival_expected: null, arrival_actual: null, arrival_delay: null, departure_expected: service.scheduled_departure, departure_actual: null, departure_delay: 20, stop_cancelled: 0, delay_change: null }] },
      disruptionConcentration: { eventDefinition: "relation_services_over_60_minutes", totalEvents: 3, items: [{ key: service.relation_key, label: service.relation_key, events: 3, sharePercent: 100, cumulativePercent: 100 }] }
    },
    disclaimer: "observable"
  });

  assert.equal(normalized.network.stations[0]?.roles.transits, 50);
  assert.equal(normalized.network.stations[0]?.delayMinutes.p90, null);
  assert.equal(normalized.services.spotlight.service?.train_key, service.train_key);
  assert.equal(normalized.services.spotlight.stops[0]?.arrival_delay, null);
  assert.equal(normalized.services.crossMidnight.denominator, 100);
});
