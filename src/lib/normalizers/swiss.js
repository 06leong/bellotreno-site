/**
 * @typedef {Object} SwissTrainLike
 * @property {string|number=} numeroTreno
 * @property {string|number=} trainNumber
 * @property {string|number=} dataPartenzaTreno
 * @property {string|number=} dataPartenza
 * @property {string=} categoria
 * @property {string=} categoriaDescrizione
 * @property {string=} compNumeroTreno
 * @property {string=} origine
 * @property {string=} destinazione
 * @property {{ stazione?: string }[]=} fermate
 */

/**
 * @typedef {Object} SwissVehicleSegment
 * @property {string=} fromStop
 * @property {string=} toStop
 * @property {boolean=} closed
 * @property {boolean=} vehicleWillBePutAway
 * @property {string=} trolleyStatus
 */

/**
 * @typedef {Object} SwissVehicle
 * @property {string=} evn
 * @property {string|number=} countryCode
 * @property {string|number=} vehicleNumber
 * @property {string|number=} checkNumber
 * @property {number|string=} position
 * @property {number|string=} number
 * @property {string=} typeCodeName
 * @property {string=} typeCode
 * @property {number|string=} firstClassSeats
 * @property {number|string=} secondClassSeats
 * @property {boolean=} closed
 * @property {boolean=} vehicleWillBePutAway
 * @property {string=} trolleyStatus
 * @property {SwissVehicleSegment[]=} segments
 * @property {Record<string, unknown>[]=} stopSectors
 */

export const SWISS_BORDER_HINTS = new Set(["CHIASSO", "DOMODOSSOLA", "LUINO", "TIRANO", "STABIO"]);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSwissStationName(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019'`\u00b4]/g, " ")
    .replace(/[-_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (isSimplonGalleryKey(normalized)) return "DOMODOSSOLA";
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSimplonGalleryKey(value) {
  const key = String(value || "").toUpperCase();
  return key.includes("GALLERIA SEMPIONE") || key.includes("SIMPLON");
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSwissBoundaryName(value) {
  return SWISS_BORDER_HINTS.has(normalizeSwissStationName(value));
}

/**
 * @param {SwissTrainLike} data
 * @returns {string}
 */
export function getSwissTrainNumber(data) {
  return String(data?.numeroTreno || data?.trainNumber || "").replace(/\D/g, "");
}

/**
 * @param {SwissTrainLike} data
 * @returns {string}
 */
export function getSwissOperationDate(data) {
  const raw = Number(data?.dataPartenzaTreno || data?.dataPartenza);
  if (Number.isFinite(raw) && raw > 0) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(raw));
  }
  return "";
}

/**
 * @param {SwissTrainLike} data
 * @returns {string}
 */
export function getSwissCategory(data) {
  const category = String(data?.categoria || data?.categoriaDescrizione || "").trim().toUpperCase();
  const comp = String(data?.compNumeroTreno || "").toUpperCase();
  if (comp.includes("EC FR")) return "FR";
  if (category) return category;
  const match = comp.match(/[A-Z]+/);
  return match ? match[0] : "";
}

/**
 * @param {SwissTrainLike} data
 * @returns {boolean}
 */
export function hasSwissHint(data) {
  const values = [data?.origine, data?.destinazione, ...(Array.isArray(data?.fermate) ? data.fermate.map((stop) => stop?.stazione) : [])];
  return values.some(isSwissBoundaryName);
}

/**
 * @param {SwissTrainLike} data
 * @param {string=} category
 * @param {string=} today
 * @returns {boolean}
 */
export function shouldQuerySwissFormation(data, category = getSwissCategory(data), today = getTodayInZurich()) {
  const trainNumber = getSwissTrainNumber(data);
  const operationDate = getSwissOperationDate(data);
  if (!trainNumber || !operationDate || operationDate !== today) return false;

  const normalizedCategory = String(category || "").toUpperCase();
  if (normalizedCategory === "EC" || normalizedCategory === "EN") return true;
  if (["REG", "RE", "RV", "S", "IR"].includes(normalizedCategory)) return hasSwissHint(data);
  return false;
}

/**
 * @param {SwissVehicle} vehicle
 * @returns {string}
 */
export function swissVehicleIdentityKey(vehicle) {
  const evn = String(vehicle?.evn || "").replace(/\s+/g, "");
  if (evn) return `evn:${evn}`;

  const vehicleNumber = [
    vehicle?.countryCode,
    vehicle?.typeCode,
    vehicle?.vehicleNumber,
    vehicle?.checkNumber,
  ]
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .join("-");
  if (vehicleNumber) return `number:${vehicleNumber}`;

  return `fallback:${vehicle?.position ?? ""}:${vehicle?.number ?? ""}:${vehicle?.typeCodeName ?? ""}:${vehicle?.typeCode ?? ""}`;
}

/**
 * Merge vehicle records that represent the same physical vehicle.
 *
 * Swiss formation payloads may repeat one EVN across route segments. Status
 * remains segment-aware: a closed segment must not globally mark the vehicle
 * closed for every selected station.
 *
 * @param {SwissVehicle[]} records
 * @returns {SwissVehicle[]}
 */
export function mergeSwissVehicleRecords(records) {
  const merged = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    const key = swissVehicleIdentityKey(record);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...record,
        segments: uniqueObjects(record?.segments || []),
        stopSectors: uniqueObjects(record?.stopSectors || []),
      });
      continue;
    }

    existing.segments = uniqueObjects([...(existing.segments || []), ...(record?.segments || [])]);
    existing.stopSectors = uniqueObjects([...(existing.stopSectors || []), ...(record?.stopSectors || [])]);
    existing.firstClassSeats = Math.max(Number(existing.firstClassSeats || 0), Number(record?.firstClassSeats || 0));
    existing.secondClassSeats = Math.max(Number(existing.secondClassSeats || 0), Number(record?.secondClassSeats || 0));
    existing.closed = Boolean(existing.closed && record?.closed);
    existing.vehicleWillBePutAway = Boolean(existing.vehicleWillBePutAway && record?.vehicleWillBePutAway);
    if (!existing.trolleyStatus || existing.trolleyStatus === "Normal") {
      existing.trolleyStatus = record?.trolleyStatus || existing.trolleyStatus;
    }
  }

  return [...merged.values()].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
}

/**
 * @param {Record<string, unknown>[]} items
 * @returns {Record<string, unknown>[]}
 */
function uniqueObjects(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = JSON.stringify(item || {});
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function getTodayInZurich() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
