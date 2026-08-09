import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAnalyticsPercent,
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
