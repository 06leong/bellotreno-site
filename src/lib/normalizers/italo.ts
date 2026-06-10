export type ItaloProvider = "italo";

export interface ItaloStationInfo {
  aliases?: string[];
  code: string;
  name: string;
  rfiLocationCode?: string;
  slug?: string;
}

export interface ItaloStationBoardRow {
  Binario?: string | null;
  Descrizione?: string | null;
  DescrizioneLocalita?: string | null;
  InfoRoute?: string | null;
  Informazioni?: string | null;
  NuovoOrario?: string | null;
  Numero?: string | number | null;
  OraPassaggio?: string | null;
  Ritardo?: string | number | null;
}

export interface ItaloStationPayload {
  DescrizioneLocalita?: string | null;
  IsEmpty?: boolean;
  LastUpdate?: string | null;
  ListaTreniArrivo?: ItaloStationBoardRow[];
  ListaTreniPartenza?: ItaloStationBoardRow[];
}

export interface NormalizedItaloStationBoardTrain {
  binarioEffettivoArrivoDescrizione?: string | null;
  binarioEffettivoPartenzaDescrizione?: string | null;
  codiceCliente: "ITALO";
  compNumeroTreno: string;
  compOrarioArrivo?: string | null;
  compOrarioEffettivoArrivo?: string | null;
  compOrarioEffettivoPartenza?: string | null;
  compOrarioPartenza?: string | null;
  destinazione?: string | null;
  informazioni?: string | null;
  italoStationCode?: string;
  numeroTreno: string;
  operator: "Italo";
  origine?: string | null;
  provider: ItaloProvider;
  ritardo: number;
  source: ItaloProvider;
}

export interface ItaloTrainStopRaw {
  ActualArrivalDateTime?: string | null;
  ActualArrivalPlatform?: string | null;
  ActualArrivalTime?: string | null;
  ActualDepartureTime?: string | null;
  EstimatedArrivalTime?: string | null;
  EstimatedDepartureTime?: string | null;
  LocationCode?: string | null;
  LocationDescription?: string | null;
  RfiLocationCode?: string | number | null;
  StationNumber?: string | number | null;
}

export interface ItaloTrainScheduleRaw {
  ArrivalDate?: string | null;
  ArrivalStation?: string | null;
  ArrivalStationDescription?: string | null;
  DepartureDate?: string | null;
  DepartureStation?: string | null;
  DepartureStationDescription?: string | null;
  Distruption?: {
    DelayAmount?: string | number | null;
    LocationCode?: string | null;
    RunningState?: string | number | null;
    Warning?: boolean | null;
  } | null;
  Leg?: Record<string, unknown> | null;
  RfiTrainNumber?: string | number | null;
  StazionePartenza?: ItaloTrainStopRaw | null;
  StazioniFerme?: ItaloTrainStopRaw[];
  StazioniNonFerme?: ItaloTrainStopRaw[];
  TrainNumber?: string | number | null;
}

export interface ItaloTrainPayload {
  IsEmpty?: boolean;
  LastUpdate?: string | null;
  TrainSchedule?: ItaloTrainScheduleRaw | null;
}

export interface NormalizedItaloStop {
  arrivoReale: number | null;
  arrivo_teorico: number | null;
  binarioEffettivoArrivoDescrizione?: string | null;
  binarioEffettivoPartenzaDescrizione?: string | null;
  id?: string | null;
  italoLocationCode?: string | null;
  partenzaReale: number | null;
  partenza_teorica: number | null;
  progressivo?: string | number | null;
  ritardoArrivo?: number | null;
  ritardoPartenza?: number | null;
  source: ItaloProvider;
  stazione: string;
}

export interface NormalizedItaloTrain {
  available: true;
  categoria: "AV";
  categoriaDescrizione: "Alta Velocita";
  codiceCliente: "ITALO";
  compCategoria: "AV";
  compDurata: string;
  compNumeroTreno: string;
  compOraUltimoRilevamento: string | null;
  compRitardoAndamento: string[];
  dataPartenzaTreno: number | null;
  dataPartenzaTrenoAsDate: string;
  destinazione: string;
  fermate: NormalizedItaloStop[];
  italoArrivalStationCode?: string | null;
  italoDepartureStationCode?: string | null;
  italoLastUpdate?: string | null;
  numeroTreno: string;
  operator: "Italo";
  origine: string;
  provider: ItaloProvider;
  source: ItaloProvider;
  stazioneUltimoRilevamento: string | null;
}

export type NormalizedItaloTrainResult =
  | NormalizedItaloTrain
  | { available: false; provider: ItaloProvider; reason: string };

const ITALO_BADGE_CATEGORY = "AV";
const ITALO_OPERATOR = "Italo";
const INVALID_TIME = new Set(["", "00:00", "01:00"]);

export const ITALO_FALLBACK_STATIONS: ItaloStationInfo[] = [
  { code: "MC_", name: "Milano Centrale", rfiLocationCode: "1728", slug: "milano-centrale", aliases: ["Milano", "Milan Centrale"] },
  { code: "RRO", name: "Milano Rho Fiera", rfiLocationCode: "3098", slug: "milano-rho-fiera", aliases: ["Milano Expo Rho", "Rho Fiera Milano"] },
  { code: "RMT", name: "Roma Termini", rfiLocationCode: "2416", slug: "roma-termini" },
  { code: "RTB", name: "Roma Tiburtina", rfiLocationCode: "2385", slug: "roma-tiburtina" },
  { code: "SMN", name: "Firenze Santa Maria Novella", rfiLocationCode: "1325", slug: "firenze-santa-maria-novella", aliases: ["Firenze SMN"] },
  { code: "BO2", name: "Bologna Centrale", rfiLocationCode: "942", slug: "bologna-centrale", aliases: ["Bologna centrale"] },
  { code: "AAV", name: "Reggio Emilia AV Mediopadana", rfiLocationCode: "4054", slug: "reggio-emilia-av-mediopadana", aliases: ["Mediopadana R.Emilia"] },
  { code: "OUE", name: "Torino Porta Susa", rfiLocationCode: "3163", slug: "torino-porta-susa", aliases: ["Torino Porta di Susa"] },
  { code: "TOP", name: "Torino Porta Nuova", rfiLocationCode: "2876", slug: "torino-porta-nuova" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeName(value: unknown): string {
  return asString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´]/g, " ")
    .replace(/[.\-_/(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function getTodayInRome(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function romeOffsetForDate(dateKey: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(`${dateKey}T12:00:00Z`));
  const raw = parts.find((part) => part.type === "timeZoneName")?.value || "GMT+1";
  const match = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return "+01:00";
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] || "00"}`;
}

function parseRomeTime(value: unknown, dateKey: string): number | null {
  const time = asString(value);
  if (INVALID_TIME.has(time) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const normalized = time.length === 4 ? `0${time}` : time;
  const timestamp = Date.parse(`${dateKey}T${normalized}:00${romeOffsetForDate(dateKey)}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function minutesBetween(left: number | null, right: number | null): number | null {
  if (!left || !right) return null;
  return Math.round((right - left) / 60000);
}

function formatDuration(startMs: number | null, endMs: number | null): string {
  const minutes = minutesBetween(startMs, endMs);
  if (!Number.isFinite(minutes) || minutes === null || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

function delayStatusText(delay: number): string {
  if (delay > 0) return `con un ritardo di ${delay} min`;
  if (delay < 0) return `con un anticipo di ${Math.abs(delay)} min`;
  return "in orario";
}

function mergeStations(stations: ItaloStationInfo[]): ItaloStationInfo[] {
  const byCode = new Map<string, ItaloStationInfo>();
  for (const station of [...ITALO_FALLBACK_STATIONS, ...stations]) {
    const code = asString(station.code);
    if (!code) continue;
    const existing = byCode.get(code);
    const base = existing || {};
    byCode.set(code, {
      ...base,
      ...station,
      aliases: Array.from(new Set([...(existing?.aliases || []), ...(station.aliases || [])].filter(Boolean))),
    });
  }
  return [...byCode.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeItaloStations(stations: ItaloStationInfo[] = []): ItaloStationInfo[] {
  return mergeStations(stations);
}

export function findItaloStation(stations: ItaloStationInfo[], query: { code?: unknown; name?: unknown; rfiLocationCode?: unknown }): ItaloStationInfo | null {
  const normalized = normalizeItaloStations(stations);
  const code = asString(query.code).toUpperCase();
  if (code) {
    const byCode = normalized.find((station) => station.code.toUpperCase() === code);
    if (byCode) return byCode;
  }

  const rfi = asString(query.rfiLocationCode);
  if (rfi) {
    const byRfi = normalized.find((station) => asString(station.rfiLocationCode) === rfi);
    if (byRfi) return byRfi;
  }

  const name = normalizeName(query.name);
  if (!name) return null;
  return normalized.find((station) => {
    const candidates = [station.name, station.slug, ...(station.aliases || [])].map(normalizeName);
    return candidates.some((candidate) => candidate === name || candidate.includes(name) || name.includes(candidate));
  }) || null;
}

export function normalizeItaloStationBoard(payload: ItaloStationPayload, stationCode: string, type: "partenze" | "arrivi"): NormalizedItaloStationBoardTrain[] {
  const rows = type === "arrivi" ? payload.ListaTreniArrivo : payload.ListaTreniPartenza;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const number = asString(row.Numero).replace(/\D+/g, "");
    const delay = asNumber(row.Ritardo);
    const platform = asString(row.Binario);
    const train: NormalizedItaloStationBoardTrain = {
      codiceCliente: "ITALO",
      compNumeroTreno: `${ITALO_BADGE_CATEGORY} ${number}`.trim(),
      informazioni: asString(row.Informazioni) || null,
      italoStationCode: stationCode,
      numeroTreno: number,
      operator: ITALO_OPERATOR,
      provider: "italo",
      ritardo: delay,
      source: "italo",
    };

    if (type === "arrivi") {
      train.origine = asString(row.DescrizioneLocalita) || null;
      train.compOrarioArrivo = asString(row.OraPassaggio) || null;
      train.compOrarioEffettivoArrivo = asString(row.NuovoOrario) || null;
      train.binarioEffettivoArrivoDescrizione = platform || null;
    } else {
      train.destinazione = asString(row.DescrizioneLocalita) || null;
      train.compOrarioPartenza = asString(row.OraPassaggio) || null;
      train.compOrarioEffettivoPartenza = asString(row.NuovoOrario) || null;
      train.binarioEffettivoPartenzaDescrizione = platform || null;
    }

    return train;
  }).filter((row) => row.numeroTreno);
}

function normalizeStop(raw: ItaloTrainStopRaw, dateKey: string, reached: boolean): NormalizedItaloStop | null {
  const name = asString(raw.LocationDescription);
  if (!name) return null;

  const scheduledArrival = parseRomeTime(raw.EstimatedArrivalTime, dateKey);
  const scheduledDeparture = parseRomeTime(raw.EstimatedDepartureTime, dateKey);
  const actualArrival = reached ? parseRomeTime(raw.ActualArrivalTime, dateKey) : null;
  const actualDeparture = reached ? parseRomeTime(raw.ActualDepartureTime, dateKey) : null;

  return {
    arrivoReale: actualArrival,
    arrivo_teorico: scheduledArrival,
    binarioEffettivoArrivoDescrizione: asString(raw.ActualArrivalPlatform) || null,
    binarioEffettivoPartenzaDescrizione: null,
    id: asString(raw.RfiLocationCode) || null,
    italoLocationCode: asString(raw.LocationCode) || null,
    partenzaReale: actualDeparture,
    partenza_teorica: scheduledDeparture,
    progressivo: asString(raw.StationNumber) || null,
    ritardoArrivo: minutesBetween(scheduledArrival, actualArrival),
    ritardoPartenza: minutesBetween(scheduledDeparture, actualDeparture),
    source: "italo",
    stazione: name,
  };
}

export function normalizeItaloTrainPayload(payload: ItaloTrainPayload, dateKey = getTodayInRome()): NormalizedItaloTrainResult {
  if (!payload || payload.IsEmpty || !payload.TrainSchedule) {
    return { available: false, provider: "italo", reason: "not_found" };
  }

  const schedule = asRecord(payload.TrainSchedule) as ItaloTrainScheduleRaw;
  const trainNumber = asString(schedule.TrainNumber || schedule.RfiTrainNumber).replace(/\D+/g, "");
  if (!trainNumber) return { available: false, provider: "italo", reason: "missing_train_number" };

  const start = normalizeStop(schedule.StazionePartenza || {}, dateKey, true);
  const reachedStops = (Array.isArray(schedule.StazioniFerme) ? schedule.StazioniFerme : [])
    .map((stop) => normalizeStop(stop, dateKey, true))
    .filter((stop): stop is NormalizedItaloStop => Boolean(stop));
  const futureStops = (Array.isArray(schedule.StazioniNonFerme) ? schedule.StazioniNonFerme : [])
    .map((stop) => normalizeStop(stop, dateKey, false))
    .filter((stop): stop is NormalizedItaloStop => Boolean(stop));

  const stops = [start, ...reachedStops, ...futureStops]
    .filter((stop): stop is NormalizedItaloStop => Boolean(stop))
    .sort((left, right) => Number(left.progressivo || 0) - Number(right.progressivo || 0));

  const first = stops[0];
  const last = stops[stops.length - 1];
  const departureMs = parseRomeTime(schedule.DepartureDate, dateKey) || first?.partenza_teorica || first?.arrivo_teorico || null;
  const arrivalMs = parseRomeTime(schedule.ArrivalDate, dateKey) || last?.arrivo_teorico || last?.partenza_teorica || null;
  const delay = asNumber(schedule.Distruption?.DelayAmount);
  const lastReached = [...stops].reverse().find((stop) => stop.arrivoReale || stop.partenzaReale) || first || null;

  return {
    available: true,
    categoria: ITALO_BADGE_CATEGORY,
    categoriaDescrizione: "Alta Velocita",
    codiceCliente: "ITALO",
    compCategoria: ITALO_BADGE_CATEGORY,
    compDurata: formatDuration(departureMs, arrivalMs),
    compNumeroTreno: `${ITALO_BADGE_CATEGORY} ${trainNumber}`,
    compOraUltimoRilevamento: asString(payload.LastUpdate) || null,
    compRitardoAndamento: [delayStatusText(delay)],
    dataPartenzaTreno: departureMs,
    dataPartenzaTrenoAsDate: dateKey,
    destinazione: asString(schedule.ArrivalStationDescription) || last?.stazione || "",
    fermate: stops,
    italoArrivalStationCode: asString(schedule.ArrivalStation) || null,
    italoDepartureStationCode: asString(schedule.DepartureStation) || null,
    italoLastUpdate: asString(payload.LastUpdate) || null,
    numeroTreno: trainNumber,
    operator: ITALO_OPERATOR,
    origine: asString(schedule.DepartureStationDescription) || first?.stazione || "",
    provider: "italo",
    source: "italo",
    stazioneUltimoRilevamento: lastReached?.stazione || null,
  };
}
