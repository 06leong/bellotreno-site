export interface TrenordTrainInfo {
  line: string | null;
  trainCategory: string | null;
  trainOperator: string | null;
  direttrice: string | null;
  direttriceSecurity: string | null;
}

export interface TrenordDirettrice {
  nome?: string;
  descrizione?: string;
  news?: TrenordDirettriceNews[];
}

export interface TrenordDirettriceNews {
  description?: string;
  date?: string;
  severity_code?: number | string;
  severity_description?: string;
}

export type TrenordMatchSource = "primary-direttrice" | "security-direttrice-fallback" | "none";

export interface TrenordNotice {
  id: string;
  source: "trenord-direttrici";
  direttriceCode: string;
  direttriceDescription: string;
  description: string;
  date?: string;
  severityCode?: number;
  severityDescription?: string;
  severityLevel: "disruption" | "warning" | "info";
  urls: string[];
}

export interface TrenordTrafficInformationResult {
  available: boolean;
  trainNumber: string;
  date: string;
  line: string | null | undefined;
  trainCategory: string | null | undefined;
  trainOperator: string | null | undefined;
  direttrice: string | null | undefined;
  direttriceDescription: string | null | undefined;
  direttriceSecurity: string | null | undefined;
  matchSource: TrenordMatchSource;
  reason?: string;
  notices: TrenordNotice[];
}

interface TrenordTrainRecord {
  [key: string]: unknown;
  category?: unknown;
  direction?: unknown;
  direttrice?: unknown;
  direttrice_security?: unknown;
  line?: unknown;
  operator?: unknown;
  operator_name?: unknown;
  train?: unknown;
  train_category?: unknown;
  train_operator?: unknown;
  trainId?: unknown;
  train_id?: unknown;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asTrainRecord(value: unknown): TrenordTrainRecord {
  return value && typeof value === "object" ? value as TrenordTrainRecord : {};
}

function hasDirettrice(train: TrenordTrainRecord): boolean {
  return Boolean(asString(train.direttrice) || asString(train.direttrice_security));
}

function isTrainLikeRecord(record: TrenordTrainRecord): boolean {
  return Boolean(
    asString(record.train_id)
    || asString(record.trainId)
    || asString(record.train_category)
    || asString(record.trainCategory)
    || asString(record.line)
    || asString(record.direction)
  );
}

/**
 */
function collectTrainCandidates(
  value: unknown,
  candidates: TrenordTrainRecord[] = [],
  seen = new WeakSet<object>(),
  depth = 0,
): TrenordTrainRecord[] {
  if (value === null || value === undefined || depth > 8) return candidates;

  if (Array.isArray(value)) {
    for (const item of value) collectTrainCandidates(item, candidates, seen, depth + 1);
    return candidates;
  }

  if (typeof value !== "object") return candidates;
  if (seen.has(value)) return candidates;
  seen.add(value);

  const record = asTrainRecord(value);
  if (hasDirettrice(record) || isTrainLikeRecord(record)) {
    candidates.push(record);
  }

  if (record.train && typeof record.train === "object") {
    collectTrainCandidates(record.train, candidates, seen, depth + 1);
  }

  for (const child of Object.values(record)) {
    if (child && typeof child === "object" && child !== record.train) {
      collectTrainCandidates(child, candidates, seen, depth + 1);
    }
  }

  return candidates;
}

export function getTrenordTrainRecord(payload: unknown): TrenordTrainRecord {
  const candidates = collectTrainCandidates(payload);

  return candidates.find(hasDirettrice) || candidates[0] || {};
}

export function getTrenordTrainInfo(payload: unknown): TrenordTrainInfo {
  const train = getTrenordTrainRecord(payload);
  return {
    line: asString(train.line),
    trainCategory: asString(train.train_category) || asString(train.category),
    trainOperator: asString(train.train_operator) || asString(train.operator) || asString(train.operator_name),
    direttrice: asString(train.direttrice),
    direttriceSecurity: asString(train.direttrice_security),
  };
}

export function findTrenordDirettrice(direttrici: TrenordDirettrice[], code: string | null | undefined): TrenordDirettrice | null {
  const normalizedCode = asString(code);
  if (!normalizedCode || !Array.isArray(direttrici)) return null;
  return direttrici.find((item) => asString(item?.nome) === normalizedCode) || null;
}

export function extractTrenordNoticeUrls(description: unknown): string[] {
  const text = String(description || "");
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const urls = matches
    .map((url) => url.replace(/[)\].,;:!?]+$/g, ""))
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
  return Array.from(new Set(urls));
}

export function trenordSeverityLevel(value: unknown): "disruption" | "warning" | "info" {
  const severity = String(value || "").trim().toLowerCase();
  if (severity === "critical" || severity === "high" || severity === "disruption") return "disruption";
  if (severity === "warning" || severity === "warn") return "warning";
  return "info";
}

/**
 * FNV-1a hash for stable browser/server ids without a crypto dependency.
 *
 */
export function stableTrenordNoticeHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 */
export function buildTrenordNoticeId(trainNumber: string, date: string, direttriceCode: string, notice: TrenordDirettriceNews): string {
  return `tn-${stableTrenordNoticeHash([
    trainNumber,
    date,
    direttriceCode,
    notice?.date || "",
    notice?.description || "",
  ].join(":"))}`;
}

/**
 */
export function normalizeTrenordNotices(trainNumber: string, date: string, direttrice: TrenordDirettrice | null): TrenordNotice[] {
  const direttriceCode = asString(direttrice?.nome);
  const direttriceDescription = asString(direttrice?.descrizione);
  if (!direttriceCode || !direttriceDescription || !Array.isArray(direttrice?.news)) return [];

  const notices = direttrice.news
    .map((notice) => {
      const description = asString(notice?.description);
      if (!description) return null;
      const severityDescription = asString(notice?.severity_description) || undefined;
      const normalized: TrenordNotice = {
        id: buildTrenordNoticeId(trainNumber, date, direttriceCode, notice),
        source: "trenord-direttrici",
        direttriceCode,
        direttriceDescription,
        description,
        date: asString(notice?.date) || undefined,
        severityCode: asOptionalNumber(notice?.severity_code),
        severityDescription,
        severityLevel: trenordSeverityLevel(severityDescription),
        urls: extractTrenordNoticeUrls(description),
      };
      return normalized;
    })
    .filter((notice): notice is TrenordNotice => notice !== null)
    .sort((left, right) => {
      const leftTime = Date.parse(left?.date || "");
      const rightTime = Date.parse(right?.date || "");
      const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
      const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
      return safeRight - safeLeft;
    });

  return filterTrenordNoticesForDisplay(notices, date);
}

/**
 */
export function normalizeTrenordTrafficInformation(
  trainNumber: string,
  date: string,
  trainPayload: unknown,
  direttrici: TrenordDirettrice[],
): TrenordTrafficInformationResult {
  const info = getTrenordTrainInfo(trainPayload);
  const primary = findTrenordDirettrice(direttrici, info.direttrice);
  const primaryNotices = normalizeTrenordNotices(trainNumber, date, primary);
  const primaryHasNews = hasTrenordDirettriceNews(primary);

  if (primary && primaryNotices.length > 0) {
    return buildResult(trainNumber, date, info, primary, "primary-direttrice", primaryNotices);
  }

  const security = (!primary || !primaryHasNews) && info.direttriceSecurity !== info.direttrice
    ? findTrenordDirettrice(direttrici, info.direttriceSecurity)
    : null;
  const securityNotices = normalizeTrenordNotices(trainNumber, date, security);

  if (security && securityNotices.length > 0) {
    return buildResult(trainNumber, date, info, security, "security-direttrice-fallback", securityNotices);
  }

  if (primary) {
    return buildResult(trainNumber, date, info, primary, "primary-direttrice", []);
  }

  if (security) {
    return buildResult(trainNumber, date, info, security, "security-direttrice-fallback", []);
  }

  const reason = info.direttrice || info.direttriceSecurity
    ? "direttrice_not_found"
    : "no_direttrice_in_train_payload";
  return buildResult(trainNumber, date, info, null, "none", [], reason);
}

function hasTrenordDirettriceNews(direttrice: TrenordDirettrice | null): boolean {
  return Array.isArray(direttrice?.news)
    && direttrice.news.some((notice) => Boolean(asString(notice?.description)));
}

function toRomeDateKey(value: unknown): string | null {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

/**
 * SmartCaring-like compact display rule:
 * show today's notices when present, otherwise show recent notices in the
 * 14-day window ending on the requested operation date.
 *
 */
export function filterTrenordNoticesForDisplay(notices: TrenordNotice[], operationDate: string): TrenordNotice[] {
  if (!Array.isArray(notices) || !/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) return [];

  const today = notices.filter((notice) => toRomeDateKey(notice.date) === operationDate);
  if (today.length) return today;

  const operationEnd = Date.parse(`${operationDate}T23:59:59+01:00`);
  if (!Number.isFinite(operationEnd)) return [];
  const cutoff = operationEnd - 13 * 86400000;

  return notices.filter((notice) => {
    const timestamp = Date.parse(notice.date || "");
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= operationEnd;
  });
}

/**
 */
function buildResult(
  trainNumber: string,
  date: string,
  info: TrenordTrainInfo,
  direttrice: TrenordDirettrice | null,
  matchSource: TrenordMatchSource,
  notices: TrenordNotice[],
  reason: string | undefined = undefined,
): TrenordTrafficInformationResult {
  const result: TrenordTrafficInformationResult = {
    available: Boolean(direttrice),
    trainNumber,
    date,
    line: info.line,
    trainCategory: info.trainCategory,
    trainOperator: info.trainOperator,
    direttrice: asString(direttrice?.nome) || info.direttrice,
    direttriceDescription: asString(direttrice?.descrizione),
    direttriceSecurity: info.direttriceSecurity,
    matchSource,
    notices,
  };
  if (reason) result.reason = reason;
  return result;
}
