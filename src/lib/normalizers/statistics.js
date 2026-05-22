/**
 * @typedef {Object} CategoryCountInput
 * @property {string=} label
 * @property {string=} category
 * @property {string=} name
 * @property {number|string=} value
 * @property {number|string=} count
 * @property {number|string=} total
 */

/**
 * @typedef {Object} CategoryCount
 * @property {string} label
 * @property {number} value
 */

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

/** @type {Record<string, string>} */
export const CATEGORY_COLORS = {
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

/**
 * @param {unknown} value
 * @returns {string}
 */
export function categoryCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  const normalized = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (normalized === "ECFR" || normalized === "EC FR") return "EC FR";
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function chartCategoryCode(value) {
  const code = categoryCode(value);
  if (code === "RE" || code === "RV") return "REG";
  return code;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function categorySortIndex(value) {
  const index = CATEGORY_ORDER.indexOf(categoryCode(value));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function statisticsCategoryColor(value) {
  return CATEGORY_COLORS[categoryCode(value)] || "#65bfc0";
}

/**
 * Normalize raw statistics category rows into display categories.
 *
 * This intentionally keeps EC FR separate from FR for display, while regional
 * board aliases RE/RV are folded into REG because they are operating variants
 * of the regional bucket in BelloTreno statistics.
 *
 * @param {CategoryCountInput[]} items
 * @returns {CategoryCount[]}
 */
export function normalizeCategoryCounts(items) {
  const totals = new Map();
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
