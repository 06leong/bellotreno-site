/**
 * @typedef {Object} TrenordTrainInfo
 * @property {string|null} line
 * @property {string|null} trainCategory
 * @property {string|null} trainOperator
 * @property {string|null} direttrice
 * @property {string|null} direttriceSecurity
 */

/**
 * @typedef {Object} TrenordDirettrice
 * @property {string=} nome
 * @property {string=} descrizione
 * @property {TrenordDirettriceNews[]=} news
 */

/**
 * @typedef {Object} TrenordDirettriceNews
 * @property {string=} description
 * @property {string=} date
 * @property {number|string=} severity_code
 * @property {string=} severity_description
 */

/**
 * @typedef {"primary-direttrice"|"security-direttrice-fallback"|"none"} TrenordMatchSource
 */

/**
 * @typedef {Object} TrenordNotice
 * @property {string} id
 * @property {"trenord-direttrici"} source
 * @property {string} direttriceCode
 * @property {string} direttriceDescription
 * @property {string} description
 * @property {string|undefined} date
 * @property {number|undefined} severityCode
 * @property {string|undefined} severityDescription
 * @property {"disruption"|"warning"|"info"} severityLevel
 * @property {string[]} urls
 */

/**
 * @typedef {Object} TrenordTrafficInformationResult
 * @property {boolean} available
 * @property {string} trainNumber
 * @property {string} date
 * @property {string|null|undefined} line
 * @property {string|null|undefined} trainCategory
 * @property {string|null|undefined} trainOperator
 * @property {string|null|undefined} direttrice
 * @property {string|null|undefined} direttriceDescription
 * @property {string|null|undefined} direttriceSecurity
 * @property {TrenordMatchSource} matchSource
 * @property {string=} reason
 * @property {TrenordNotice[]} notices
 */

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function asString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function asOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function getTrenordTrainRecord(payload) {
  const root = asRecord(payload);
  const journeyList = Array.isArray(root.journey_list) ? root.journey_list : [];
  for (const journey of journeyList) {
    const train = asRecord(asRecord(journey).train);
    if (Object.keys(train).length) return train;
  }
  return asRecord(root.train);
}

/**
 * @param {unknown} payload
 * @returns {TrenordTrainInfo}
 */
export function getTrenordTrainInfo(payload) {
  const train = getTrenordTrainRecord(payload);
  return {
    line: asString(train.line),
    trainCategory: asString(train.train_category) || asString(train.category),
    trainOperator: asString(train.train_operator) || asString(train.operator) || asString(train.operator_name),
    direttrice: asString(train.direttrice),
    direttriceSecurity: asString(train.direttrice_security),
  };
}

/**
 * @param {TrenordDirettrice[]} direttrici
 * @param {string|null|undefined} code
 * @returns {TrenordDirettrice|null}
 */
export function findTrenordDirettrice(direttrici, code) {
  const normalizedCode = asString(code);
  if (!normalizedCode || !Array.isArray(direttrici)) return null;
  return direttrici.find((item) => asString(item?.nome) === normalizedCode) || null;
}

/**
 * @param {unknown} description
 * @returns {string[]}
 */
export function extractTrenordNoticeUrls(description) {
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

/**
 * @param {unknown} value
 * @returns {"disruption"|"warning"|"info"}
 */
export function trenordSeverityLevel(value) {
  const severity = String(value || "").trim().toLowerCase();
  if (severity === "critical" || severity === "high" || severity === "disruption") return "disruption";
  if (severity === "warning" || severity === "warn") return "warning";
  return "info";
}

/**
 * FNV-1a hash for stable browser/server ids without a crypto dependency.
 *
 * @param {string} value
 * @returns {string}
 */
export function stableTrenordNoticeHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * @param {string} trainNumber
 * @param {string} date
 * @param {string} direttriceCode
 * @param {TrenordDirettriceNews} notice
 * @returns {string}
 */
export function buildTrenordNoticeId(trainNumber, date, direttriceCode, notice) {
  return `tn-${stableTrenordNoticeHash([
    trainNumber,
    date,
    direttriceCode,
    notice?.date || "",
    notice?.description || "",
  ].join(":"))}`;
}

/**
 * @param {string} trainNumber
 * @param {string} date
 * @param {TrenordDirettrice|null} direttrice
 * @returns {TrenordNotice[]}
 */
export function normalizeTrenordNotices(trainNumber, date, direttrice) {
  const direttriceCode = asString(direttrice?.nome);
  const direttriceDescription = asString(direttrice?.descrizione);
  if (!direttriceCode || !direttriceDescription || !Array.isArray(direttrice?.news)) return [];

  return direttrice.news
    .map((notice) => {
      const description = asString(notice?.description);
      if (!description) return null;
      const severityDescription = asString(notice?.severity_description) || undefined;
      /** @type {TrenordNotice} */
      const normalized = {
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
    .filter((notice) => notice !== null)
    .sort((left, right) => {
      const leftTime = Date.parse(left?.date || "");
      const rightTime = Date.parse(right?.date || "");
      const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
      const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
      return safeRight - safeLeft;
    });
}

/**
 * @param {string} trainNumber
 * @param {string} date
 * @param {unknown} trainPayload
 * @param {TrenordDirettrice[]} direttrici
 * @returns {TrenordTrafficInformationResult}
 */
export function normalizeTrenordTrafficInformation(trainNumber, date, trainPayload, direttrici) {
  const info = getTrenordTrainInfo(trainPayload);
  const primary = findTrenordDirettrice(direttrici, info.direttrice);
  const primaryNotices = normalizeTrenordNotices(trainNumber, date, primary);

  if (primary && primaryNotices.length > 0) {
    return buildResult(trainNumber, date, info, primary, "primary-direttrice", primaryNotices);
  }

  const security = info.direttriceSecurity !== info.direttrice
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

/**
 * @param {string} trainNumber
 * @param {string} date
 * @param {TrenordTrainInfo} info
 * @param {TrenordDirettrice|null} direttrice
 * @param {TrenordMatchSource} matchSource
 * @param {TrenordNotice[]} notices
 * @param {string=} reason
 * @returns {TrenordTrafficInformationResult}
 */
function buildResult(trainNumber, date, info, direttrice, matchSource, notices, reason = undefined) {
  /** @type {TrenordTrafficInformationResult} */
  const result = {
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
