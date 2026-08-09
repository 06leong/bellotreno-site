export type AnalyticsWindow = 7 | 28 | 90;
export type AnalyticsDimension = "operator" | "category" | "station" | "relation";
export type AnalyticsRankingSort = "punctuality" | "p90" | "cancellation" | "sample";

export interface AnalyticsRate {
  numerator: number;
  denominator: number;
  percent: number | null;
  confidence95?: { low: number; high: number } | null;
}

export interface AnalyticsMetricSet {
  serviceDays: number;
  observedServices: number;
  outcomeEligibleServices: number;
  excludedServices: number;
  completedServices: number;
  arrivalSample: number;
  punctuality: { within5: AnalyticsRate; within15: AnalyticsRate };
  cancellation: AnalyticsRate;
  severeDelay: { over30: AnalyticsRate; over60: AnalyticsRate; over120: AnalyticsRate };
  delayMinutes: { p50: number | null; p75: number | null; p90: number | null; p95: number | null; mean: number | null };
  distribution: Array<{ key: string; count: number }>;
}

export interface AnalyticsSeriesPoint extends AnalyticsMetricSet {
  date: string;
}

export interface AnalyticsOverview {
  available: true;
  build: {
    buildId: string;
    builtAt: string;
    metricDefinitionVersion: string;
    sourceManifests: string[];
  };
  context: {
    asOfDate: string;
    windowDays: AnalyticsWindow;
    windowStart: string;
    previousAsOfDate: string;
    previousWindowStart: string;
    windowComplete: boolean;
    previousWindowComplete: boolean;
    filter: { type: "operator" | "category" | null; key: string | null };
  };
  current: AnalyticsMetricSet;
  previous: AnalyticsMetricSet | null;
  series: AnalyticsSeriesPoint[];
  quality: {
    days: number;
    completeDays: number;
    partialDays: number;
    items: Array<Record<string, unknown>>;
  };
  disclaimer: string;
}

export interface AnalyticsMeta {
  available: true;
  schemaVersion: number;
  metricDefinitionVersion: string;
  buildId: string;
  builtAt: string;
  asOfDate: string;
  sourceLatestCreatedAt: string;
  sourceLatestAsOfDate: string;
  sourceManifests: string[];
  windows: AnalyticsWindow[];
  minimumRankingSample: number;
  serviceDate: { availableFrom: string; availableTo: string; days: number };
  collectionDate: { availableFrom: string; availableTo: string };
  dimensions: {
    operator: Array<{ key: string; label: string; sample: number }>;
    category: Array<{ key: string; label: string; sample: number }>;
  };
}

export interface AnalyticsRankingItem extends AnalyticsMetricSet {
  key: string;
  label: string;
}

export interface AnalyticsRankingPayload {
  available: true;
  dimension: AnalyticsDimension;
  asOfDate: string;
  windowDays: AnalyticsWindow;
  minimumSample: number;
  sort: AnalyticsRankingSort;
  direction: "asc" | "desc";
  items: AnalyticsRankingItem[];
  total: number;
}

export interface AnalyticsOutlier {
  service_date: string;
  train_key: string;
  train_number: string;
  operator: string | null;
  category: string | null;
  origin: string | null;
  destination: string | null;
  origin_code: string | null;
  destination_code: string | null;
  relation_key: string | null;
  status: string | null;
  cancelled: number;
  completed: number;
  final_arrival_delay: number | null;
  final_departure_delay: number | null;
  scheduled_departure: string | null;
  scheduled_arrival: string | null;
  observation_count: number;
}

export interface AnalyticsOutlierPayload {
  available: true;
  asOfDate: string;
  windowDays: AnalyticsWindow;
  items: AnalyticsOutlier[];
  total: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = finiteNumber(value);
  if (parsed === null) throw new TypeError(`Invalid analytics number: ${field}`);
  return parsed;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return finiteNumber(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`Invalid analytics string: ${field}`);
  return value;
}

function normalizeRate(value: unknown, field: string): AnalyticsRate {
  if (!isRecord(value)) throw new TypeError(`Invalid analytics rate: ${field}`);
  const denominator = requiredNumber(value.denominator, `${field}.denominator`);
  const numerator = requiredNumber(value.numerator, `${field}.numerator`);
  const percent = optionalNumber(value.percent);
  const confidence = value.confidence95;
  return {
    numerator,
    denominator,
    percent,
    confidence95: isRecord(confidence)
      ? { low: requiredNumber(confidence.low, `${field}.confidence.low`), high: requiredNumber(confidence.high, `${field}.confidence.high`) }
      : null
  };
}

export function normalizeAnalyticsMetricSet(value: unknown): AnalyticsMetricSet {
  if (!isRecord(value) || !isRecord(value.punctuality) || !isRecord(value.severeDelay) || !isRecord(value.delayMinutes)) {
    throw new TypeError("Invalid analytics metric payload");
  }
  const distribution = Array.isArray(value.distribution)
    ? value.distribution.filter(isRecord).map((item) => ({
        key: requiredString(item.key, "distribution.key"),
        count: requiredNumber(item.count, "distribution.count")
      }))
    : [];
  return {
    serviceDays: requiredNumber(value.serviceDays, "serviceDays"),
    observedServices: requiredNumber(value.observedServices, "observedServices"),
    outcomeEligibleServices: requiredNumber(value.outcomeEligibleServices, "outcomeEligibleServices"),
    excludedServices: requiredNumber(value.excludedServices, "excludedServices"),
    completedServices: requiredNumber(value.completedServices, "completedServices"),
    arrivalSample: requiredNumber(value.arrivalSample, "arrivalSample"),
    punctuality: {
      within5: normalizeRate(value.punctuality.within5, "punctuality.within5"),
      within15: normalizeRate(value.punctuality.within15, "punctuality.within15")
    },
    cancellation: normalizeRate(value.cancellation, "cancellation"),
    severeDelay: {
      over30: normalizeRate(value.severeDelay.over30, "severeDelay.over30"),
      over60: normalizeRate(value.severeDelay.over60, "severeDelay.over60"),
      over120: normalizeRate(value.severeDelay.over120, "severeDelay.over120")
    },
    delayMinutes: {
      p50: optionalNumber(value.delayMinutes.p50),
      p75: optionalNumber(value.delayMinutes.p75),
      p90: optionalNumber(value.delayMinutes.p90),
      p95: optionalNumber(value.delayMinutes.p95),
      mean: optionalNumber(value.delayMinutes.mean)
    },
    distribution
  };
}

export function normalizeAnalyticsOverview(value: unknown): AnalyticsOverview {
  if (!isRecord(value) || value.available !== true || !isRecord(value.build) || !isRecord(value.context) || !isRecord(value.quality)) {
    throw new TypeError("Historical analytics are unavailable");
  }
  const windowDays = requiredNumber(value.context.windowDays, "context.windowDays");
  if (windowDays !== 7 && windowDays !== 28 && windowDays !== 90) throw new TypeError("Invalid analytics window");
  const rawSeries = Array.isArray(value.series) ? value.series : [];
  return {
    available: true,
    build: {
      buildId: requiredString(value.build.buildId, "buildId"),
      builtAt: requiredString(value.build.builtAt, "builtAt"),
      metricDefinitionVersion: requiredString(value.build.metricDefinitionVersion, "metricDefinitionVersion"),
      sourceManifests: Array.isArray(value.build.sourceManifests) ? value.build.sourceManifests.filter((item): item is string => typeof item === "string") : []
    },
    context: {
      asOfDate: requiredString(value.context.asOfDate, "asOfDate"),
      windowDays,
      windowStart: requiredString(value.context.windowStart, "windowStart"),
      previousAsOfDate: requiredString(value.context.previousAsOfDate, "previousAsOfDate"),
      previousWindowStart: requiredString(value.context.previousWindowStart, "previousWindowStart"),
      windowComplete: value.context.windowComplete === true,
      previousWindowComplete: value.context.previousWindowComplete === true,
      filter: isRecord(value.context.filter)
        ? {
            type: value.context.filter.type === "operator" || value.context.filter.type === "category" ? value.context.filter.type : null,
            key: typeof value.context.filter.key === "string" ? value.context.filter.key : null
          }
        : { type: null, key: null }
    },
    current: normalizeAnalyticsMetricSet(value.current),
    previous: value.previous === null || value.previous === undefined ? null : normalizeAnalyticsMetricSet(value.previous),
    series: rawSeries.filter(isRecord).map((item) => ({ date: requiredString(item.date, "series.date"), ...normalizeAnalyticsMetricSet(item) })),
    quality: {
      days: requiredNumber(value.quality.days, "quality.days"),
      completeDays: requiredNumber(value.quality.completeDays, "quality.completeDays"),
      partialDays: requiredNumber(value.quality.partialDays, "quality.partialDays"),
      items: Array.isArray(value.quality.items) ? value.quality.items.filter(isRecord) : []
    },
    disclaimer: typeof value.disclaimer === "string" ? value.disclaimer : ""
  };
}

export function normalizeAnalyticsMeta(value: unknown): AnalyticsMeta {
  if (!isRecord(value) || value.available !== true || !isRecord(value.serviceDate) || !isRecord(value.collectionDate) || !isRecord(value.dimensions)) {
    throw new TypeError("Historical analytics metadata are unavailable");
  }
  const normalizeDimension = (items: unknown): Array<{ key: string; label: string; sample: number }> =>
    Array.isArray(items) ? items.filter(isRecord).map((item) => ({
      key: requiredString(item.key, "dimension.key"),
      label: requiredString(item.label, "dimension.label"),
      sample: requiredNumber(item.sample, "dimension.sample")
    })) : [];
  const windows = Array.isArray(value.windows)
    ? value.windows.map((item) => requiredNumber(item, "window")).filter((item): item is AnalyticsWindow => item === 7 || item === 28 || item === 90)
    : [];
  return {
    available: true,
    schemaVersion: requiredNumber(value.schemaVersion, "schemaVersion"),
    metricDefinitionVersion: requiredString(value.metricDefinitionVersion, "metricDefinitionVersion"),
    buildId: requiredString(value.buildId, "buildId"),
    builtAt: requiredString(value.builtAt, "builtAt"),
    asOfDate: requiredString(value.asOfDate, "asOfDate"),
    sourceLatestCreatedAt: requiredString(value.sourceLatestCreatedAt, "sourceLatestCreatedAt"),
    sourceLatestAsOfDate: requiredString(value.sourceLatestAsOfDate, "sourceLatestAsOfDate"),
    sourceManifests: Array.isArray(value.sourceManifests) ? value.sourceManifests.filter((item): item is string => typeof item === "string") : [],
    windows,
    minimumRankingSample: requiredNumber(value.minimumRankingSample, "minimumRankingSample"),
    serviceDate: {
      availableFrom: requiredString(value.serviceDate.availableFrom, "serviceDate.availableFrom"),
      availableTo: requiredString(value.serviceDate.availableTo, "serviceDate.availableTo"),
      days: requiredNumber(value.serviceDate.days, "serviceDate.days")
    },
    collectionDate: {
      availableFrom: requiredString(value.collectionDate.availableFrom, "collectionDate.availableFrom"),
      availableTo: requiredString(value.collectionDate.availableTo, "collectionDate.availableTo")
    },
    dimensions: {
      operator: normalizeDimension(value.dimensions.operator),
      category: normalizeDimension(value.dimensions.category)
    }
  };
}

export function normalizeAnalyticsRanking(value: unknown): AnalyticsRankingPayload {
  if (!isRecord(value) || value.available !== true || !Array.isArray(value.items)) throw new TypeError("Analytics ranking is unavailable");
  const dimension = value.dimension;
  if (dimension !== "operator" && dimension !== "category" && dimension !== "station" && dimension !== "relation") throw new TypeError("Invalid ranking dimension");
  const sort = value.sort;
  if (sort !== "punctuality" && sort !== "p90" && sort !== "cancellation" && sort !== "sample") throw new TypeError("Invalid ranking metric");
  const windowDays = requiredNumber(value.windowDays, "windowDays");
  if (windowDays !== 7 && windowDays !== 28 && windowDays !== 90) throw new TypeError("Invalid ranking window");
  return {
    available: true,
    dimension,
    asOfDate: requiredString(value.asOfDate, "asOfDate"),
    windowDays,
    minimumSample: requiredNumber(value.minimumSample, "minimumSample"),
    sort,
    direction: value.direction === "asc" ? "asc" : "desc",
    items: value.items.filter(isRecord).map((item) => ({
      key: requiredString(item.key, "ranking.key"),
      label: requiredString(item.label, "ranking.label"),
      ...normalizeAnalyticsMetricSet(item)
    })),
    total: requiredNumber(value.total, "total")
  };
}

export function normalizeAnalyticsOutliers(value: unknown): AnalyticsOutlierPayload {
  if (!isRecord(value) || value.available !== true || !Array.isArray(value.items)) throw new TypeError("Analytics outliers are unavailable");
  const windowDays = requiredNumber(value.windowDays, "windowDays");
  if (windowDays !== 7 && windowDays !== 28 && windowDays !== 90) throw new TypeError("Invalid outlier window");
  const nullableString = (item: JsonRecord, field: string): string | null => typeof item[field] === "string" ? item[field] as string : null;
  return {
    available: true,
    asOfDate: requiredString(value.asOfDate, "asOfDate"),
    windowDays,
    items: value.items.filter(isRecord).map((item) => ({
      service_date: requiredString(item.service_date, "service_date"),
      train_key: requiredString(item.train_key, "train_key"),
      train_number: requiredString(item.train_number, "train_number"),
      operator: nullableString(item, "operator"),
      category: nullableString(item, "category"),
      origin: nullableString(item, "origin"),
      destination: nullableString(item, "destination"),
      origin_code: nullableString(item, "origin_code"),
      destination_code: nullableString(item, "destination_code"),
      relation_key: nullableString(item, "relation_key"),
      status: nullableString(item, "status"),
      cancelled: requiredNumber(item.cancelled, "cancelled"),
      completed: requiredNumber(item.completed, "completed"),
      final_arrival_delay: optionalNumber(item.final_arrival_delay),
      final_departure_delay: optionalNumber(item.final_departure_delay),
      scheduled_departure: nullableString(item, "scheduled_departure"),
      scheduled_arrival: nullableString(item, "scheduled_arrival"),
      observation_count: requiredNumber(item.observation_count, "observation_count")
    })),
    total: requiredNumber(value.total, "total")
  };
}

export function percentagePointChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 10) / 10;
}

export function formatAnalyticsPercent(value: number | null, locale: string): string {
  if (value === null) return "—";
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`;
}

export function formatAnalyticsNumber(value: number | null, locale: string, maximumFractionDigits = 0): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}
