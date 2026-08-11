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

export interface AnalyticsCompactMetric {
  observedServices: number;
  outcomeEligibleServices: number;
  arrivalSample: number;
  punctuality: { within5: AnalyticsRate; within15: AnalyticsRate };
  cancellation: AnalyticsRate;
  severeDelay: { over30: AnalyticsRate; over60: AnalyticsRate; over120: AnalyticsRate };
  delayMinutes: { p50: number | null; p75: number | null; p90: number | null; p95: number | null; mean: number | null };
}

export interface AnalyticsMixItem extends AnalyticsCompactMetric {
  key: string;
  label: string;
  sharePercent: number | null;
}

export interface AnalyticsRhythmItem extends AnalyticsCompactMetric {
  weekday: number;
  hour: number;
}

export interface AnalyticsStationItem {
  key: string;
  label: string;
  observedServices: number;
  previousObservedServices: number;
  arrivalSample: number;
  roles: {
    arrivals: number;
    departures: number;
    transits: number;
    arrivalPercent: number | null;
    departurePercent: number | null;
    transitPercent: number | null;
  };
  punctuality: { within5: AnalyticsRate };
  cancellation: AnalyticsRate;
  delayMinutes: { p50: number | null; p90: number | null };
}

export interface AnalyticsRelationItem extends AnalyticsCompactMetric {
  key: string;
  label: string;
  previousObservedServices: number;
  crossMidnightServices: number;
  recovery: {
    sample: number;
    recoveredServices: number;
    meanMinutes: number | null;
    p50Minutes: number | null;
  };
}

export interface AnalyticsStationRhythmItem {
  weekday: number;
  hour: number;
  observed_services: number;
  arrivals: number;
  departures: number;
  transits: number;
}

export interface AnalyticsJourney {
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
  scheduled_departure: string | null;
  scheduled_arrival: string | null;
  scheduled_duration_minutes: number | null;
  cross_midnight: number;
  delay_change: number | null;
  final_departure_delay: number | null;
  final_arrival_delay: number | null;
  observation_count: number;
}

export interface AnalyticsSpotlightStop {
  service_date: string;
  train_key: string;
  stop_number: number;
  station_code: string | null;
  station_name: string | null;
  stop_type: string | null;
  platform: string | null;
  arrival_expected: string | null;
  arrival_actual: string | null;
  arrival_delay: number | null;
  departure_expected: string | null;
  departure_actual: string | null;
  departure_delay: number | null;
  stop_cancelled: number;
  delay_change: number | null;
}

export interface AnalyticsExplore {
  available: true;
  asOfDate: string;
  windowDays: AnalyticsWindow;
  filter: { type: "operator" | "category" | null; key: string | null };
  composition: {
    activeOperators: number;
    operators: AnalyticsMixItem[];
    categories: AnalyticsMixItem[];
    matrix: Array<{ operator: string; category: string } & AnalyticsCompactMetric>;
  };
  rhythm: AnalyticsRhythmItem[];
  categoryRhythm: Array<AnalyticsRhythmItem & { category: string }>;
  network: {
    stations: AnalyticsStationItem[];
    relations: AnalyticsRelationItem[];
    stationRhythm: {
      stationCode: string | null;
      stationLabel: string | null;
      filterScope: "all_services";
      items: AnalyticsStationRhythmItem[];
    };
  };
  services: {
    crossMidnight: {
      numerator: number;
      denominator: number;
      percent: number | null;
      previousPercent: number | null;
      durationSample: number;
      durationMeanMinutes: number | null;
      durationP90Minutes: number | null;
    };
    longestJourneys: AnalyticsJourney[];
    recoveryRelations: AnalyticsRelationItem[];
    spotlight: { service: AnalyticsOutlier | null; stops: AnalyticsSpotlightStop[] };
    disruptionConcentration: {
      eventDefinition: string;
      totalEvents: number;
      items: Array<{ key: string; label: string; events: number; sharePercent: number | null; cumulativePercent: number | null }>;
    };
  };
  disclaimer: string;
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

function normalizeCompactMetric(value: unknown, field: string): AnalyticsCompactMetric {
  if (!isRecord(value) || !isRecord(value.punctuality) || !isRecord(value.severeDelay) || !isRecord(value.delayMinutes)) {
    throw new TypeError(`Invalid analytics compact metric: ${field}`);
  }
  return {
    observedServices: requiredNumber(value.observedServices, `${field}.observedServices`),
    outcomeEligibleServices: requiredNumber(value.outcomeEligibleServices, `${field}.outcomeEligibleServices`),
    arrivalSample: requiredNumber(value.arrivalSample, `${field}.arrivalSample`),
    punctuality: {
      within5: normalizeRate(value.punctuality.within5, `${field}.punctuality.within5`),
      within15: normalizeRate(value.punctuality.within15, `${field}.punctuality.within15`)
    },
    cancellation: normalizeRate(value.cancellation, `${field}.cancellation`),
    severeDelay: {
      over30: normalizeRate(value.severeDelay.over30, `${field}.severeDelay.over30`),
      over60: normalizeRate(value.severeDelay.over60, `${field}.severeDelay.over60`),
      over120: normalizeRate(value.severeDelay.over120, `${field}.severeDelay.over120`)
    },
    delayMinutes: {
      p50: optionalNumber(value.delayMinutes.p50),
      p75: optionalNumber(value.delayMinutes.p75),
      p90: optionalNumber(value.delayMinutes.p90),
      p95: optionalNumber(value.delayMinutes.p95),
      mean: optionalNumber(value.delayMinutes.mean)
    }
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

export function normalizeAnalyticsExplore(value: unknown): AnalyticsExplore {
  if (!isRecord(value) || value.available !== true || !isRecord(value.composition) || !isRecord(value.network) || !isRecord(value.services)) {
    throw new TypeError("Analytics exploration is unavailable");
  }
  const windowDays = requiredNumber(value.windowDays, "windowDays");
  if (windowDays !== 7 && windowDays !== 28 && windowDays !== 90) throw new TypeError("Invalid exploration window");
  const filter = isRecord(value.filter) ? value.filter : {};
  const normalizeMix = (item: JsonRecord, field: string): AnalyticsMixItem => ({
    key: requiredString(item.key, `${field}.key`),
    label: requiredString(item.label, `${field}.label`),
    sharePercent: optionalNumber(item.sharePercent),
    ...normalizeCompactMetric(item, field)
  });
  const normalizeStation = (item: JsonRecord): AnalyticsStationItem => {
    if (!isRecord(item.roles) || !isRecord(item.punctuality) || !isRecord(item.delayMinutes)) throw new TypeError("Invalid station exploration item");
    return {
      key: requiredString(item.key, "station.key"),
      label: requiredString(item.label, "station.label"),
      observedServices: requiredNumber(item.observedServices, "station.observedServices"),
      previousObservedServices: requiredNumber(item.previousObservedServices, "station.previousObservedServices"),
      arrivalSample: requiredNumber(item.arrivalSample, "station.arrivalSample"),
      roles: {
        arrivals: requiredNumber(item.roles.arrivals, "station.roles.arrivals"),
        departures: requiredNumber(item.roles.departures, "station.roles.departures"),
        transits: requiredNumber(item.roles.transits, "station.roles.transits"),
        arrivalPercent: optionalNumber(item.roles.arrivalPercent),
        departurePercent: optionalNumber(item.roles.departurePercent),
        transitPercent: optionalNumber(item.roles.transitPercent)
      },
      punctuality: { within5: normalizeRate(item.punctuality.within5, "station.punctuality.within5") },
      cancellation: normalizeRate(item.cancellation, "station.cancellation"),
      delayMinutes: { p50: optionalNumber(item.delayMinutes.p50), p90: optionalNumber(item.delayMinutes.p90) }
    };
  };
  const normalizeRelation = (item: JsonRecord): AnalyticsRelationItem => {
    if (!isRecord(item.recovery)) throw new TypeError("Invalid relation exploration item");
    return {
      key: requiredString(item.key, "relation.key"),
      label: requiredString(item.label, "relation.label"),
      previousObservedServices: requiredNumber(item.previousObservedServices, "relation.previousObservedServices"),
      crossMidnightServices: requiredNumber(item.crossMidnightServices, "relation.crossMidnightServices"),
      recovery: {
        sample: requiredNumber(item.recovery.sample, "relation.recovery.sample"),
        recoveredServices: requiredNumber(item.recovery.recoveredServices, "relation.recovery.recoveredServices"),
        meanMinutes: optionalNumber(item.recovery.meanMinutes),
        p50Minutes: optionalNumber(item.recovery.p50Minutes)
      },
      ...normalizeCompactMetric(item, "relation")
    };
  };
  const nullableString = (item: JsonRecord, field: string): string | null => typeof item[field] === "string" ? item[field] as string : null;
  const normalizeJourney = (item: JsonRecord): AnalyticsJourney => ({
    service_date: requiredString(item.service_date, "journey.service_date"),
    train_key: requiredString(item.train_key, "journey.train_key"),
    train_number: requiredString(item.train_number, "journey.train_number"),
    operator: nullableString(item, "operator"),
    category: nullableString(item, "category"),
    origin: nullableString(item, "origin"),
    destination: nullableString(item, "destination"),
    origin_code: nullableString(item, "origin_code"),
    destination_code: nullableString(item, "destination_code"),
    relation_key: nullableString(item, "relation_key"),
    scheduled_departure: nullableString(item, "scheduled_departure"),
    scheduled_arrival: nullableString(item, "scheduled_arrival"),
    scheduled_duration_minutes: optionalNumber(item.scheduled_duration_minutes),
    cross_midnight: requiredNumber(item.cross_midnight, "journey.cross_midnight"),
    delay_change: optionalNumber(item.delay_change),
    final_departure_delay: optionalNumber(item.final_departure_delay),
    final_arrival_delay: optionalNumber(item.final_arrival_delay),
    observation_count: requiredNumber(item.observation_count, "journey.observation_count")
  });
  const composition = value.composition;
  const network = value.network;
  const services = value.services;
  if (!isRecord(network.stationRhythm) || !isRecord(services.crossMidnight) || !isRecord(services.spotlight) || !isRecord(services.disruptionConcentration)) {
    throw new TypeError("Invalid analytics exploration sections");
  }
  const relations = Array.isArray(network.relations) ? network.relations.filter(isRecord).map(normalizeRelation) : [];
  const spotlightService = services.spotlight.service;
  const normalizedSpotlight = spotlightService === null || spotlightService === undefined
    ? null
    : normalizeAnalyticsOutliers({ available: true, asOfDate: value.asOfDate, windowDays, items: [spotlightService], total: 1 }).items[0] ?? null;
  return {
    available: true,
    asOfDate: requiredString(value.asOfDate, "asOfDate"),
    windowDays,
    filter: {
      type: filter.type === "operator" || filter.type === "category" ? filter.type : null,
      key: typeof filter.key === "string" ? filter.key : null
    },
    composition: {
      activeOperators: requiredNumber(composition.activeOperators, "composition.activeOperators"),
      operators: Array.isArray(composition.operators) ? composition.operators.filter(isRecord).map((item) => normalizeMix(item, "operator")) : [],
      categories: Array.isArray(composition.categories) ? composition.categories.filter(isRecord).map((item) => normalizeMix(item, "category")) : [],
      matrix: Array.isArray(composition.matrix) ? composition.matrix.filter(isRecord).map((item) => ({
        operator: requiredString(item.operator, "matrix.operator"),
        category: requiredString(item.category, "matrix.category"),
        ...normalizeCompactMetric(item, "matrix")
      })) : []
    },
    rhythm: Array.isArray(value.rhythm) ? value.rhythm.filter(isRecord).map((item) => ({
      weekday: requiredNumber(item.weekday, "rhythm.weekday"),
      hour: requiredNumber(item.hour, "rhythm.hour"),
      ...normalizeCompactMetric(item, "rhythm")
    })) : [],
    categoryRhythm: Array.isArray(value.categoryRhythm) ? value.categoryRhythm.filter(isRecord).map((item) => ({
      category: requiredString(item.category, "categoryRhythm.category"),
      weekday: requiredNumber(item.weekday, "categoryRhythm.weekday"),
      hour: requiredNumber(item.hour, "categoryRhythm.hour"),
      ...normalizeCompactMetric(item, "categoryRhythm")
    })) : [],
    network: {
      stations: Array.isArray(network.stations) ? network.stations.filter(isRecord).map(normalizeStation) : [],
      relations,
      stationRhythm: {
        stationCode: typeof network.stationRhythm.stationCode === "string" ? network.stationRhythm.stationCode : null,
        stationLabel: typeof network.stationRhythm.stationLabel === "string" ? network.stationRhythm.stationLabel : null,
        filterScope: "all_services",
        items: Array.isArray(network.stationRhythm.items) ? network.stationRhythm.items.filter(isRecord).map((item) => ({
          weekday: requiredNumber(item.weekday, "stationRhythm.weekday"),
          hour: requiredNumber(item.hour, "stationRhythm.hour"),
          observed_services: requiredNumber(item.observed_services, "stationRhythm.observed_services"),
          arrivals: requiredNumber(item.arrivals, "stationRhythm.arrivals"),
          departures: requiredNumber(item.departures, "stationRhythm.departures"),
          transits: requiredNumber(item.transits, "stationRhythm.transits")
        })) : []
      }
    },
    services: {
      crossMidnight: {
        numerator: requiredNumber(services.crossMidnight.numerator, "crossMidnight.numerator"),
        denominator: requiredNumber(services.crossMidnight.denominator, "crossMidnight.denominator"),
        percent: optionalNumber(services.crossMidnight.percent),
        previousPercent: optionalNumber(services.crossMidnight.previousPercent),
        durationSample: requiredNumber(services.crossMidnight.durationSample, "crossMidnight.durationSample"),
        durationMeanMinutes: optionalNumber(services.crossMidnight.durationMeanMinutes),
        durationP90Minutes: optionalNumber(services.crossMidnight.durationP90Minutes)
      },
      longestJourneys: Array.isArray(services.longestJourneys) ? services.longestJourneys.filter(isRecord).map(normalizeJourney) : [],
      recoveryRelations: Array.isArray(services.recoveryRelations) ? services.recoveryRelations.filter(isRecord).map(normalizeRelation) : [],
      spotlight: {
        service: normalizedSpotlight,
        stops: Array.isArray(services.spotlight.stops) ? services.spotlight.stops.filter(isRecord).map((item) => ({
          service_date: requiredString(item.service_date, "stop.service_date"),
          train_key: requiredString(item.train_key, "stop.train_key"),
          stop_number: requiredNumber(item.stop_number, "stop.stop_number"),
          station_code: nullableString(item, "station_code"),
          station_name: nullableString(item, "station_name"),
          stop_type: nullableString(item, "stop_type"),
          platform: nullableString(item, "platform"),
          arrival_expected: nullableString(item, "arrival_expected"),
          arrival_actual: nullableString(item, "arrival_actual"),
          arrival_delay: optionalNumber(item.arrival_delay),
          departure_expected: nullableString(item, "departure_expected"),
          departure_actual: nullableString(item, "departure_actual"),
          departure_delay: optionalNumber(item.departure_delay),
          stop_cancelled: requiredNumber(item.stop_cancelled, "stop.stop_cancelled"),
          delay_change: optionalNumber(item.delay_change)
        })) : []
      },
      disruptionConcentration: {
        eventDefinition: requiredString(services.disruptionConcentration.eventDefinition, "concentration.eventDefinition"),
        totalEvents: requiredNumber(services.disruptionConcentration.totalEvents, "concentration.totalEvents"),
        items: Array.isArray(services.disruptionConcentration.items) ? services.disruptionConcentration.items.filter(isRecord).map((item) => ({
          key: requiredString(item.key, "concentration.key"),
          label: requiredString(item.label, "concentration.label"),
          events: requiredNumber(item.events, "concentration.events"),
          sharePercent: optionalNumber(item.sharePercent),
          cumulativePercent: optionalNumber(item.cumulativePercent)
        })) : []
      }
    },
    disclaimer: typeof value.disclaimer === "string" ? value.disclaimer : ""
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
