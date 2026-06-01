export interface SwissTrainLike {
  numeroTreno?: string | number;
  trainNumber?: string | number;
  dataPartenzaTreno?: string | number;
  dataPartenza?: string | number;
  categoria?: string;
  categoriaDescrizione?: string;
  compNumeroTreno?: string;
  origine?: string;
  destinazione?: string;
  fermate?: { stazione?: string }[];
}

export interface SwissVehicleSegment {
  fromStop?: string;
  toStop?: string;
  closed?: boolean;
  vehicleWillBePutAway?: boolean;
  trolleyStatus?: string;
}

export interface SwissVehicle {
  evn?: string;
  countryCode?: string | number;
  vehicleNumber?: string | number;
  checkNumber?: string | number;
  position?: number | string;
  number?: number | string;
  typeCodeName?: string;
  typeCode?: string;
  firstClassSeats?: number | string;
  secondClassSeats?: number | string;
  closed?: boolean;
  vehicleWillBePutAway?: boolean;
  trolleyStatus?: string;
  segments?: SwissVehicleSegment[];
  stopSectors?: Record<string, unknown>[];
}

export const SWISS_BORDER_HINTS = new Set(["CHIASSO", "DOMODOSSOLA", "LUINO", "TIRANO", "STABIO"]);

export function normalizeSwissStationName(value: unknown): string {
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

export function isSimplonGalleryKey(value: unknown): boolean {
  const key = String(value || "").toUpperCase();
  return key.includes("GALLERIA SEMPIONE") || key.includes("SIMPLON");
}

export function isSwissBoundaryName(value: unknown): boolean {
  return SWISS_BORDER_HINTS.has(normalizeSwissStationName(value));
}

export function getSwissTrainNumber(data: SwissTrainLike): string {
  return String(data?.numeroTreno || data?.trainNumber || "").replace(/\D/g, "");
}

export function getSwissOperationDate(data: SwissTrainLike): string {
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

export function getSwissCategory(data: SwissTrainLike): string {
  const category = String(data?.categoria || data?.categoriaDescrizione || "").trim().toUpperCase();
  const comp = String(data?.compNumeroTreno || "").toUpperCase();
  if (comp.includes("EC FR")) return "FR";
  if (category) return category;
  const match = comp.match(/[A-Z]+/);
  return match ? match[0] : "";
}

export function hasSwissHint(data: SwissTrainLike): boolean {
  const values = [data?.origine, data?.destinazione, ...(Array.isArray(data?.fermate) ? data.fermate.map((stop) => stop?.stazione) : [])];
  return values.some(isSwissBoundaryName);
}

export function shouldQuerySwissFormation(data: SwissTrainLike, category = getSwissCategory(data), today = getTodayInZurich()): boolean {
  const trainNumber = getSwissTrainNumber(data);
  const operationDate = getSwissOperationDate(data);
  if (!trainNumber || !operationDate || operationDate !== today) return false;

  const normalizedCategory = String(category || "").toUpperCase();
  if (normalizedCategory === "EC" || normalizedCategory === "EN") return true;
  if (["REG", "RE", "RV", "S", "IR"].includes(normalizedCategory)) return hasSwissHint(data);
  return false;
}

export function swissVehicleIdentityKey(vehicle: SwissVehicle): string {
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
 */
export function mergeSwissVehicleRecords(records: SwissVehicle[]): SwissVehicle[] {
  const merged = new Map<string, SwissVehicle>();

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
 */
function uniqueObjects<T extends object>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item || {});
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function getTodayInZurich(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
