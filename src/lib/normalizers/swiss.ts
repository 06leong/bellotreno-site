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

export interface SwissStopSector {
  accessToPreviousVehicle?: boolean;
  arrivalTime?: string;
  departureTime?: string;
  name?: string;
  sectors?: string;
  track?: string;
  uic?: number | string;
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
  stopSectors?: SwissStopSector[];
}

export type SwissVehicleFamily = "" | "giruno" | "astoro" | "rabe524";

export interface SwissVehicleFamilyInput {
  buildTypeCode?: string | number | null;
  checkNumber?: string | number | null;
  classCode?: string | number | null;
  countryCode?: string | number | null;
  evn?: string | null;
  number?: string | number | null;
  parentEvn?: string | null;
  typeCode?: string | number | null;
  typeCodeName?: string | number | null;
  vehicleNumber?: string | number | null;
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

export function swissVehicleSeries(vehicle: SwissVehicleFamilyInput | null | undefined): string {
  const typeTexts = [
    vehicle?.typeCodeName,
    vehicle?.typeCode,
    vehicle?.classCode,
  ].map((value) => String(value || "").trim()).filter(Boolean);

  for (const text of typeTexts) {
    const parenthesized = text.match(/\((501|503|524|610)\)/);
    if (parenthesized) return parenthesized[1];
    const compact = text.toUpperCase().replace(/[^A-Z0-9]+/g, "");
    if (compact.includes("GIRUNO") || compact.includes("RABE501")) return "501";
    if (compact.includes("ASTORO") || compact.includes("RABE503")) return "503";
    if (compact.includes("ETR610") || compact.includes("ETR.610")) return "610";
    if (/(?:^|[A-Z])524(?:$|[^0-9])/.test(compact)) return "524";
    if (/(?:^|[^0-9])503(?:$|[^0-9])/.test(compact)) return "503";
    if (/(?:^|[^0-9])610(?:$|[^0-9])/.test(compact)) return "610";
    if (/(?:^|[^0-9])501(?:$|[^0-9])/.test(compact)) return "501";
  }

  const vehicleNumberSeries = swissVehicleNumberBlockSeries(vehicle);
  if (vehicleNumberSeries) return vehicleNumberSeries;
  if (swissVehicleUnitSerial(vehicle)) return "524";
  return "";
}

export function swissVehicleFamily(vehicle: SwissVehicleFamilyInput | null | undefined): SwissVehicleFamily {
  const series = swissVehicleSeries(vehicle);
  if (series === "501") return "giruno";
  if (series === "503" || series === "610") return "astoro";
  if (series === "524") return "rabe524";
  return "";
}

export function swissVehicleFamilyBaseLabel(family: SwissVehicleFamily): string {
  if (family === "giruno") return "RABe 501 Giruno";
  if (family === "astoro") return "ETR 610 / RABe 503 New Pendolino";
  if (family === "rabe524") return "RABe 524/ETR 524 FLIRT";
  return "";
}

export function swissVehicleFamilyDisplayLabel(vehicle: SwissVehicleFamilyInput | null | undefined): string {
  const family = swissVehicleFamily(vehicle);
  const baseLabel = swissVehicleFamilyBaseLabel(family);
  if (!baseLabel) return "";

  if (family === "rabe524") {
    const serial = swissVehicleUnitSerial(vehicle);
    return serial ? `${baseLabel} - No.${serial}` : baseLabel;
  }

  return baseLabel;
}

export function swissVehicleUnitSerial(vehicle: SwissVehicleFamilyInput | null | undefined): string {
  const candidates = [
    vehicle?.number,
    vehicle?.vehicleNumber,
    vehicle?.evn,
    vehicle?.parentEvn,
  ];

  for (const candidate of candidates) {
    const digits = String(candidate || "").replace(/\D+/g, "");
    const match = digits.match(/[1-9]?524(\d{3})/);
    if (match) return match[1];
  }

  return "";
}

function swissVehicleNumberBlockSeries(vehicle: SwissVehicleFamilyInput | null | undefined): string {
  const candidates = [
    vehicle?.vehicleNumber,
    vehicle?.evn,
    vehicle?.parentEvn,
    vehicle?.number,
  ];

  for (const candidate of candidates) {
    const digits = String(candidate || "").replace(/\D+/g, "");
    const match = digits.match(/[1-9](501|503|524|610)\d{3}/);
    if (match) return match[1];
  }

  return "";
}

export function swissVehicleElementNumber(vehicle: SwissVehicleFamilyInput | null | undefined): string {
  const candidates = [
    vehicle?.number,
    vehicle?.vehicleNumber,
    vehicle?.evn,
    vehicle?.parentEvn,
  ];

  for (const candidate of candidates) {
    const digits = String(candidate || "").replace(/\D+/g, "");
    const match = digits.match(/([1-9])524\d{3}/);
    if (match) return match[1];
  }

  return "";
}

export function swissVehicleUnitKey(vehicle: SwissVehicleFamilyInput | null | undefined): string {
  const family = swissVehicleFamily(vehicle);
  const number = Number(vehicle?.number || 0);
  if (family === "astoro" && number) return `610:${number >= 10 ? Math.ceil(number / 10) : 1}`;
  if (family === "giruno" && number) return `501:${Math.max(1, Math.ceil(number / 20))}`;
  if (family === "rabe524") {
    const serial = swissVehicleUnitSerial(vehicle);
    return serial ? `524:${serial}` : "";
  }
  return "";
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
