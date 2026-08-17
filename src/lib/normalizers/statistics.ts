export interface CategoryCountInput {
  label?: string;
  category?: string;
  name?: string;
  value?: number | string;
  count?: number | string;
  total?: number | string;
}

export interface CategoryCount {
  label: string;
  value: number;
}

export type StatisticsCoverageMode = "forward_only";
export type StatisticsCoverageStatus = "live" | "partial" | "complete" | "unavailable";
export type StatisticsCoverageReason =
  | "live_day"
  | "partial_rollout_day"
  | "incomplete_collection_day"
  | "v2_not_available"
  | null;

export interface StatisticsCoverageRange {
  availableFrom: string | null;
  availableTo: string | null;
}

export interface StatisticsCoverage {
  schemaVersion: 2 | null;
  mode: StatisticsCoverageMode | null;
  rolloutDate: string | null;
  collectionDate: StatisticsCoverageRange;
  serviceDate: StatisticsCoverageRange;
}

export interface StatisticsCoverageDay {
  date: string;
  label?: string;
  finalized: boolean;
  v2Available: boolean;
  coverageStatus: StatisticsCoverageStatus;
  comparisonEligible: boolean;
  reason: StatisticsCoverageReason;
}

export interface StatisticsDaysResponse {
  days: StatisticsCoverageDay[];
  coverage: StatisticsCoverage;
}

export interface StatisticsMetricComparison {
  current: number;
  baseline: number;
  delta: number;
  percent: number | null;
}

export interface StatisticsComparisonBaseline {
  date: string;
  gapDays: number;
}

export const CATEGORY_ORDER = [
  "REG",
  "MET",
  "FR",
  "EC FR",
  "FA",
  "FB",
  "IC",
  "ICN",
  "EC",
  "EN",
  "EXP",
  "NCL",
  "IR",
  "TS",
];

export const CATEGORY_COLORS: Record<string, string> = {
  AV: "#982719",
  REG: "#70a84a",
  MET: "#70a84a",
  FR: "#bc3433",
  "EC FR": "#bc3433",
  FA: "#bc3433",
  FB: "#bc3433",
  IC: "#008ad8",
  ICN: "#008ad8",
  EC: "#3c8149",
  EN: "#3c8149",
  EXP: "#35556b",
  NCL: "#d9dee7",
  IR: "#69737f",
  TS: "#827654",
};

/**
 * Statistics keeps the ViaggiaTreno client-code distinction because the
 * operator dimension is also a service-family dimension for Trenitalia.
 * Search and train-detail surfaces intentionally continue to use CLIENT_MAP,
 * where 1/2/4 all display as the consumer-facing "Trenitalia" brand.
 */
export const STATISTICS_OPERATOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "1": "Trenitalia AV",
  "2": "Trenitalia REG",
  "4": "Trenitalia IC",
  "18": "Trenitalia TPER",
  "63": "Trenord",
  "64": "ÖBB",
  "77": "FS Treni Turistici Italiani",
  "910": "Ferrovie del Sud Est",
  ITALO: "Italo",
});

export const STATISTICS_OPERATOR_COLORS: Readonly<Record<string, string>> = Object.freeze({
  "1": "#bc3433",
  "2": "#70a84a",
  "4": "#008ad8",
  "18": "#d19525",
  "63": "#7864b8",
  "64": "#d71920",
  "77": "#827654",
  "910": "#008878",
  ITALO: "#982719",
});

export const STATISTICS_STATION_COLORS = Object.freeze([
  "#1769d2",
  "#d85b28",
  "#18875f",
  "#7b61b7",
  "#c48a12",
  "#008f9c",
  "#c14372",
  "#65758b",
  "#4b86b4",
  "#a45a3a",
]);

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const COVERAGE_STATUSES = new Set<StatisticsCoverageStatus>([
  "live",
  "partial",
  "complete",
  "unavailable",
]);
const COVERAGE_REASONS = new Set<Exclude<StatisticsCoverageReason, null>>([
  "live_day",
  "partial_rollout_day",
  "incomplete_collection_day",
  "v2_not_available",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value
    : null;
}

function dateOrdinal(value: string): number | null {
  const normalized = normalizedIsoDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function normalizeCoverageRange(value: unknown): StatisticsCoverageRange {
  const record = asRecord(value);
  return {
    availableFrom: normalizedIsoDate(record.availableFrom),
    availableTo: normalizedIsoDate(record.availableTo),
  };
}

function normalizeCoverageDay(value: unknown): StatisticsCoverageDay | null {
  const record = asRecord(value);
  const date = normalizedIsoDate(record.date);
  if (!date) return null;
  const coverageStatus = typeof record.coverageStatus === "string"
    && COVERAGE_STATUSES.has(record.coverageStatus as StatisticsCoverageStatus)
    ? record.coverageStatus as StatisticsCoverageStatus
    : "unavailable";
  const reason = record.reason === null
    ? null
    : typeof record.reason === "string"
      && COVERAGE_REASONS.has(record.reason as Exclude<StatisticsCoverageReason, null>)
      ? record.reason as Exclude<StatisticsCoverageReason, null>
      : "v2_not_available";
  const day: StatisticsCoverageDay = {
    date,
    finalized: record.finalized === true,
    v2Available: record.v2Available === true,
    coverageStatus,
    comparisonEligible: record.comparisonEligible === true,
    reason,
  };
  if (typeof record.label === "string" && record.label.trim()) {
    day.label = record.label;
  }
  return day;
}

/**
 * Normalize a number without collapsing absent values into a real zero.
 */
export function normalizeStatisticsNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compare two present metric values. A zero baseline has a valid absolute
 * delta, but no finite percentage change.
 */
export function compareStatisticsMetric(
  currentValue: unknown,
  baselineValue: unknown,
): StatisticsMetricComparison | null {
  const current = normalizeStatisticsNumber(currentValue);
  const baseline = normalizeStatisticsNumber(baselineValue);
  if (current === null || baseline === null) return null;
  const delta = current - baseline;
  return {
    current,
    baseline,
    delta,
    percent: baseline === 0 ? null : (delta / baseline) * 100,
  };
}

/**
 * Parse the `/days` response without inventing coverage dates or numeric
 * values. Malformed day entries are omitted and malformed coverage fields fail
 * closed to null/unavailable values.
 */
export function normalizeStatisticsDaysResponse(value: unknown): StatisticsDaysResponse {
  const record = asRecord(value);
  const coverageRecord = asRecord(record.coverage);
  const rawDays = Array.isArray(record.days) ? record.days : [];
  return {
    days: rawDays
      .map(normalizeCoverageDay)
      .filter((day): day is StatisticsCoverageDay => day !== null),
    coverage: {
      schemaVersion: coverageRecord.schemaVersion === 2 ? 2 : null,
      mode: coverageRecord.mode === "forward_only" ? "forward_only" : null,
      rolloutDate: normalizedIsoDate(coverageRecord.rolloutDate),
      collectionDate: normalizeCoverageRange(coverageRecord.collectionDate),
      serviceDate: normalizeCoverageRange(coverageRecord.serviceDate),
    },
  };
}

function isComparisonEligible(day: StatisticsCoverageDay): boolean {
  return day.comparisonEligible
    && day.v2Available
    && day.coverageStatus === "complete";
}

/**
 * Select the nearest earlier day explicitly marked as comparison eligible.
 * Eligibility is never inferred from the global coverage ranges. `gapDays`
 * counts missing calendar days between the selected and baseline dates.
 */
export function selectStatisticsComparisonBaseline(
  days: readonly StatisticsCoverageDay[],
  selectedDate: string,
): StatisticsComparisonBaseline | null {
  const selectedOrdinal = dateOrdinal(selectedDate);
  if (selectedOrdinal === null) return null;
  const selected = days.find((day) => day.date === selectedDate);
  if (!selected || !isComparisonEligible(selected)) return null;

  let baseline: StatisticsCoverageDay | null = null;
  let baselineOrdinal: number | null = null;
  for (const day of days) {
    if (!isComparisonEligible(day)) continue;
    const ordinal = dateOrdinal(day.date);
    if (ordinal === null || ordinal >= selectedOrdinal) continue;
    if (baselineOrdinal === null || ordinal > baselineOrdinal) {
      baseline = day;
      baselineOrdinal = ordinal;
    }
  }
  if (!baseline || baselineOrdinal === null) return null;
  return {
    date: baseline.date,
    gapDays: Math.max(0, selectedOrdinal - baselineOrdinal - 1),
  };
}

export function categoryCode(value: unknown): string {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  const normalized = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (normalized === "ECFR" || normalized === "EC FR") return "EC FR";
  return normalized;
}

export function chartCategoryCode(value: unknown): string {
  const code = categoryCode(value);
  if (code === "RE" || code === "RV") return "REG";
  return code;
}

export function categorySortIndex(value: unknown): number {
  const index = CATEGORY_ORDER.indexOf(categoryCode(value));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function statisticsCategoryColor(value: unknown): string {
  return CATEGORY_COLORS[chartCategoryCode(value)] || "#69737f";
}

export function statisticsOperatorLabel(value: unknown, fallback?: unknown): string {
  const primary = String(value ?? "").trim();
  const secondary = String(fallback ?? "").trim();
  for (const candidate of [primary, secondary]) {
    if (!candidate) continue;
    const mapped = STATISTICS_OPERATOR_LABELS[candidate.toUpperCase()];
    if (mapped) return mapped;
  }
  return secondary || primary;
}

export function statisticsOperatorColor(value: unknown): string {
  const key = String(value ?? "").trim().toUpperCase();
  return STATISTICS_OPERATOR_COLORS[key] || "#69737f";
}

export function statisticsStationColor(index: number): string {
  const normalizedIndex = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return STATISTICS_STATION_COLORS[normalizedIndex % STATISTICS_STATION_COLORS.length] ?? "#1769d2";
}

/**
 * Normalize raw statistics category rows into display categories.
 *
 * This intentionally keeps EC FR separate from FR for display, while regional
 * board aliases RE/RV are folded into REG because they are operating variants
 * of the regional bucket in BelloTreno statistics.
 *
 */
export function normalizeCategoryCounts(items: CategoryCountInput[]): CategoryCount[] {
  const totals = new Map<string, number>();
  for (const item of Array.isArray(items) ? items : []) {
    const label = chartCategoryCode(item?.label ?? item?.category ?? item?.name);
    if (!label) continue;
    const amount = Number(item?.value ?? item?.count ?? item?.total ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    totals.set(label, (totals.get(label) || 0) + amount);
  }

  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => {
      const byOrder = categorySortIndex(a.label) - categorySortIndex(b.label);
      if (byOrder !== 0) return byOrder;
      return a.label.localeCompare(b.label);
    });
}
