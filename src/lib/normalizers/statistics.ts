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
  REG: "#83b85b",
  MET: "#83b85b",
  FR: "#c94b45",
  "EC FR": "#c94b45",
  FA: "#c94b45",
  FB: "#c94b45",
  IC: "#3f95dd",
  ICN: "#3f95dd",
  EC: "#4d8d55",
  EN: "#4d8d55",
  EXP: "#5b748c",
  NCL: "#e9edf3",
  IR: "#7c8796",
  TS: "#69c6d4",
};

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
  return CATEGORY_COLORS[categoryCode(value)] || "#65bfc0";
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
