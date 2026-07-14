import test from "node:test";
import assert from "node:assert/strict";

import {
  compareStatisticsMetric,
  normalizeStatisticsDaysResponse,
  normalizeStatisticsNumber,
  selectStatisticsComparisonBaseline,
  type StatisticsCoverageDay,
} from "../../src/lib/normalizers/statistics.ts";

function completeDay(date: string): StatisticsCoverageDay {
  return {
    date,
    label: date,
    finalized: true,
    v2Available: true,
    coverageStatus: "complete",
    comparisonEligible: true,
    reason: null,
  };
}

test("statistics numbers preserve real zero and reject missing values", () => {
  assert.equal(normalizeStatisticsNumber(0), 0);
  assert.equal(normalizeStatisticsNumber("0"), 0);
  assert.equal(normalizeStatisticsNumber(-3.5), -3.5);
  assert.equal(normalizeStatisticsNumber(undefined), null);
  assert.equal(normalizeStatisticsNumber(null), null);
  assert.equal(normalizeStatisticsNumber(""), null);
  assert.equal(normalizeStatisticsNumber(false), null);
  assert.equal(normalizeStatisticsNumber(Number.NaN), null);
  assert.equal(normalizeStatisticsNumber(Number.POSITIVE_INFINITY), null);
});

test("statistics metric comparison distinguishes missing values from zero", () => {
  assert.deepEqual(compareStatisticsMetric(0, 10), {
    current: 0,
    baseline: 10,
    delta: -10,
    percent: -100,
  });
  assert.deepEqual(compareStatisticsMetric(5, 0), {
    current: 5,
    baseline: 0,
    delta: 5,
    percent: null,
  });
  assert.deepEqual(compareStatisticsMetric(0, 0), {
    current: 0,
    baseline: 0,
    delta: 0,
    percent: null,
  });
  assert.equal(compareStatisticsMetric(undefined, 10), null);
  assert.equal(compareStatisticsMetric(10, null), null);
});

test("statistics days response preserves the forward-only coverage contract", () => {
  const normalized = normalizeStatisticsDaysResponse({
    days: [
      {
        date: "2026-07-15",
        label: "15 July",
        finalized: true,
        v2Available: true,
        coverageStatus: "complete",
        comparisonEligible: true,
        reason: null,
      },
      {
        date: "2026-07-14",
        finalized: true,
        v2Available: true,
        coverageStatus: "partial",
        comparisonEligible: false,
        reason: "partial_rollout_day",
      },
    ],
    coverage: {
      schemaVersion: 2,
      mode: "forward_only",
      rolloutDate: "2026-07-14",
      collectionDate: {
        availableFrom: "2026-07-14",
        availableTo: "2026-07-15",
      },
      serviceDate: {
        availableFrom: "2026-07-13",
        availableTo: "2026-07-15",
      },
    },
  });

  assert.deepEqual(normalized.coverage, {
    schemaVersion: 2,
    mode: "forward_only",
    rolloutDate: "2026-07-14",
    collectionDate: {
      availableFrom: "2026-07-14",
      availableTo: "2026-07-15",
    },
    serviceDate: {
      availableFrom: "2026-07-13",
      availableTo: "2026-07-15",
    },
  });
  assert.equal(normalized.days[0]?.comparisonEligible, true);
  assert.equal(normalized.days[1]?.coverageStatus, "partial");
});

test("statistics days response fails closed without inventing coverage values", () => {
  const normalized = normalizeStatisticsDaysResponse({
    days: [
      { date: "2026-02-30", comparisonEligible: true },
      { date: "2026-07-15" },
    ],
    coverage: {
      collectionDate: {},
      serviceDate: { availableFrom: "", availableTo: "invalid" },
    },
  });

  assert.deepEqual(normalized.coverage, {
    schemaVersion: null,
    mode: null,
    rolloutDate: null,
    collectionDate: { availableFrom: null, availableTo: null },
    serviceDate: { availableFrom: null, availableTo: null },
  });
  assert.deepEqual(normalized.days, [{
    date: "2026-07-15",
    finalized: false,
    v2Available: false,
    coverageStatus: "unavailable",
    comparisonEligible: false,
    reason: "v2_not_available",
  }]);
  assert.equal(normalizeStatisticsNumber(undefined), null);
});

test("statistics days response preserves incomplete collection evidence", () => {
  const normalized = normalizeStatisticsDaysResponse({
    days: [{
      date: "2026-07-16",
      finalized: true,
      v2Available: true,
      coverageStatus: "partial",
      comparisonEligible: false,
      reason: "incomplete_collection_day",
    }],
    coverage: {
      schemaVersion: 2,
      mode: "forward_only",
      rolloutDate: "2026-07-14",
    },
  });

  assert.equal(normalized.days[0]?.reason, "incomplete_collection_day");
  assert.equal(normalized.days[0]?.comparisonEligible, false);
  assert.equal(normalized.coverage.rolloutDate, "2026-07-14");
});

test("comparison baseline selects the nearest eligible earlier day and reports gaps", () => {
  const partialDay = {
    ...completeDay("2026-07-17"),
    coverageStatus: "partial" as const,
    comparisonEligible: false,
    reason: "partial_rollout_day" as const,
  };
  const days = [
    completeDay("2026-07-18"),
    partialDay,
    completeDay("2026-07-16"),
    completeDay("2026-07-14"),
  ];

  assert.deepEqual(selectStatisticsComparisonBaseline(days, "2026-07-18"), {
    date: "2026-07-16",
    gapDays: 1,
  });
  assert.deepEqual(selectStatisticsComparisonBaseline(days, "2026-07-16"), {
    date: "2026-07-14",
    gapDays: 1,
  });
  assert.equal(selectStatisticsComparisonBaseline(days, "2026-07-14"), null);
});

test("comparison baseline trusts per-day eligibility instead of coverage ranges", () => {
  const partial = {
    ...completeDay("2026-07-14"),
    coverageStatus: "partial" as const,
    comparisonEligible: false,
    reason: "partial_rollout_day" as const,
  };
  const unavailable = {
    ...completeDay("2026-07-13"),
    v2Available: false,
    coverageStatus: "unavailable" as const,
    comparisonEligible: false,
    reason: "v2_not_available" as const,
  };
  const live = {
    ...completeDay("2026-07-16"),
    finalized: false,
    coverageStatus: "live" as const,
    comparisonEligible: false,
    reason: "live_day" as const,
  };

  assert.equal(
    selectStatisticsComparisonBaseline([completeDay("2026-07-15"), partial, unavailable], "2026-07-15"),
    null,
  );
  assert.equal(
    selectStatisticsComparisonBaseline([live, completeDay("2026-07-15")], "2026-07-16"),
    null,
  );
  assert.equal(
    selectStatisticsComparisonBaseline([completeDay("2026-07-15")], "2026-07-12"),
    null,
  );
});
