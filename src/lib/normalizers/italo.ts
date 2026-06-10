export type ItaloProvider = "italo";

export interface ItaloStationInfo {
  aliases?: string[];
  code: string;
  name: string;
  rfiLocationCode?: string;
  slug?: string;
  viaggiaName?: string;
  viaggiaStationId?: string;
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
  italoStationName?: string | null;
  partenzaReale: number | null;
  partenza_teorica: number | null;
  progressivo?: string | number | null;
  rfiLocationCode?: string | null;
  ritardoArrivo?: number | null;
  ritardoPartenza?: number | null;
  source: ItaloProvider;
  stazione: string;
  viaggiaStationId?: string | null;
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

export interface ItaloStationLookupQuery {
  code?: unknown;
  name?: unknown;
  rfiLocationCode?: unknown;
  viaggiaStationId?: unknown;
}

const ITALO_BADGE_CATEGORY = "AV";
const ITALO_OPERATOR = "Italo";
const INVALID_TIME = new Set(["", "00:00", "01:00"]);

export const ITALO_FALLBACK_STATIONS: ItaloStationInfo[] = [
  { code: "MC_", name: "Milano Centrale", rfiLocationCode: "1728", viaggiaStationId: "S01700", viaggiaName: "MILANO CENTRALE", slug: "milano-centrale", aliases: ["Milano C.le", "Milan Centrale"] },
  { code: "RRO", name: "Milano Rho Fiera", rfiLocationCode: "3098", viaggiaStationId: "S01039", viaggiaName: "RHO FIERA", slug: "milano-rho-fiera", aliases: ["Milano Expo Rho", "Rho Fiera Milano", "Rho Fiera"] },
  { code: "RMT", name: "Roma Termini", rfiLocationCode: "2416", viaggiaStationId: "S08409", viaggiaName: "ROMA TERMINI", slug: "roma-termini" },
  { code: "RTB", name: "Roma Tiburtina", rfiLocationCode: "2385", viaggiaStationId: "S08217", viaggiaName: "ROMA TIBURTINA", slug: "roma-tiburtina" },
  { code: "SMN", name: "Firenze Santa Maria Novella", rfiLocationCode: "1325", viaggiaStationId: "S06421", viaggiaName: "FIRENZE SANTA MARIA NOVELLA", slug: "firenze-santa-maria-novella", aliases: ["Firenze SMN", "Firenze S. M. Novella"] },
  { code: "BO2", name: "Bologna Centrale", rfiLocationCode: "942", viaggiaStationId: "S05043", viaggiaName: "BOLOGNA CENTRALE", slug: "bologna-centrale", aliases: ["Bologna centrale"] },
  { code: "AAV", name: "Reggio Emilia AV Mediopadana", rfiLocationCode: "4054", viaggiaStationId: "S05254", viaggiaName: "REGGIO EMILIA AV MEDIOPADANA", slug: "reggio-emilia-av-mediopadana", aliases: ["Mediopadana R.Emilia"] },
  { code: "OUE", name: "Torino Porta Susa", rfiLocationCode: "3163", viaggiaStationId: "S00035", viaggiaName: "TORINO PORTA SUSA", slug: "torino-porta-susa", aliases: ["Torino Porta di Susa"] },
  { code: "TOP", name: "Torino Porta Nuova", rfiLocationCode: "2876", viaggiaStationId: "S00219", viaggiaName: "TORINO PORTA NUOVA", slug: "torino-porta-nuova" },
  { code: "RG_", name: "Milano Rogoredo", rfiLocationCode: "1720", viaggiaStationId: "S01820", viaggiaName: "MILANO ROGOREDO", slug: "milano-rogoredo" },
  { code: "NAF", name: "Napoli Afragola", rfiLocationCode: "4020", viaggiaStationId: "S09988", viaggiaName: "NAPOLI AFRAGOLA", slug: "napoli-afragola" },
  { code: "NAC", name: "Napoli", rfiLocationCode: "1888", viaggiaStationId: "S09218", viaggiaName: "NAPOLI CENTRALE", slug: "napoli-centrale", aliases: ["Napoli Centrale"] },
  { code: "CEA", name: "Caserta", rfiLocationCode: "945", viaggiaStationId: "S09211", viaggiaName: "CASERTA", slug: "caserta" },
  { code: "SAL", name: "Salerno", rfiLocationCode: "2617", viaggiaStationId: "S09818", viaggiaName: "SALERNO", slug: "salerno" },
  { code: "RCE", name: "Reggio Calabria", rfiLocationCode: "116", viaggiaStationId: "S11781", viaggiaName: "REGGIO DI CALABRIA CENTRALE", slug: "reggio-di-calabria-centrale", aliases: ["Reggio Calabria Centrale"] },
  { code: "VSG", name: "Villa S.Giovanni", rfiLocationCode: "183", viaggiaStationId: "S11774", viaggiaName: "VILLA S.GIOVANNI", slug: "villa-s-giovanni", aliases: ["Villa S. Giovanni", "Villa San Giovanni"] },
  { code: "RUT", name: "Rosarno", rfiLocationCode: "133", viaggiaStationId: "S11765", viaggiaName: "ROSARNO", slug: "rosarno" },
  { code: "LON", name: "Lamezia Terme C", rfiLocationCode: "75", viaggiaStationId: "S11749", viaggiaName: "LAMEZIA TERME CENTRALE", slug: "lamezia-terme-centrale", aliases: ["Lamezia Terme Centrale"] },
  { code: "PAR", name: "Paola", rfiLocationCode: "107", viaggiaStationId: "S11739", viaggiaName: "PAOLA", slug: "paola" },
  { code: "SDC", name: "Scalea", rfiLocationCode: "154", viaggiaStationId: "S11727", viaggiaName: "SCALEA S.DOMENICA TALAO", slug: "scalea-s-domenica-talao", aliases: ["Scalea S. Domenica Talao"] },
  { code: "MRT", name: "Maratea", rfiLocationCode: "81", viaggiaStationId: "S11723", viaggiaName: "MARATEA", slug: "maratea" },
  { code: "SRI", name: "Sapri", rfiLocationCode: "153", viaggiaStationId: "S11721", viaggiaName: "SAPRI", slug: "sapri" },
  { code: "VLH", name: "Vallo d.Lucania", rfiLocationCode: "177", viaggiaStationId: "S11709", viaggiaName: "VALLO DELLA LUCANIA-CASTELNUOVO", slug: "vallo-della-lucania-castelnuovo", aliases: ["Vallo della Lucania", "Vallo della Lucania-Castelnuovo"] },
  { code: "AGR", name: "Agropoli Castellabate", rfiLocationCode: "5", viaggiaStationId: "S11705", viaggiaName: "AGROPOLI CASTELLABATE", slug: "agropoli-castellabate" },
  { code: "TSC", name: "Trieste C.le", rfiLocationCode: "2925", viaggiaStationId: "S03317", viaggiaName: "TRIESTE CENTRALE", slug: "trieste-centrale", aliases: ["Trieste Centrale"] },
  { code: "MNF", name: "Monfalcone", rfiLocationCode: "1770", viaggiaStationId: "S03310", viaggiaName: "MONFALCONE", slug: "monfalcone" },
  { code: "RHA", name: "Trieste Airport", rfiLocationCode: "2925", viaggiaStationId: "S03213", viaggiaName: "TRIESTE AIRPORT", slug: "trieste-airport" },
  { code: "LTL", name: "Latisana-Lignano", rfiLocationCode: "1540", viaggiaStationId: "S03202", viaggiaName: "LATISANA LIGNANO-BIBIONE", slug: "latisana-lignano-bibione", aliases: ["Latisana Lignano Bibione"] },
  { code: "PGR", name: "Portogruaro", rfiLocationCode: "2261", viaggiaStationId: "S03200", viaggiaName: "PORTOGRUARO CAORLE", slug: "portogruaro-caorle", aliases: ["Portogruaro Caorle"] },
  { code: "SDP", name: "S.Dona-Jesolo", rfiLocationCode: "2489", viaggiaStationId: "S02666", viaggiaName: "S.DONA' DI PIAVE-JESOLO", slug: "s-dona-di-piave-jesolo", aliases: ["S.Dona' di Piave-Jesolo", "S. Dona di Piave Jesolo"] },
  { code: "VEM", name: "Venezia Mestre", rfiLocationCode: "3002", viaggiaStationId: "S02589", viaggiaName: "VENEZIA MESTRE", slug: "venezia-mestre" },
  { code: "VSL", name: "Venezia Santa Lucia", rfiLocationCode: "3009", viaggiaStationId: "S02593", viaggiaName: "VENEZIA S.LUCIA", slug: "venezia-s-lucia", aliases: ["Venezia S.Lucia"] },
  { code: "PD_", name: "Padova", rfiLocationCode: "2000", viaggiaStationId: "S02581", viaggiaName: "PADOVA", slug: "padova" },
  { code: "VPN", name: "Verona Porta Nuova", rfiLocationCode: "3025", viaggiaStationId: "S02430", viaggiaName: "VERONA PORTA NUOVA", slug: "verona-porta-nuova" },
  { code: "BSC", name: "Brescia", rfiLocationCode: "734", viaggiaStationId: "S01717", viaggiaName: "BRESCIA", slug: "brescia" },
  { code: "DSG", name: "Desenzano", rfiLocationCode: "1229", viaggiaStationId: "S02084", viaggiaName: "DESENZANO DEL GARDA-SIRMIONE", slug: "desenzano-del-garda-sirmione", aliases: ["Desenzano del Garda-Sirmione"] },
  { code: "PSY", name: "Peschiera", rfiLocationCode: "2099", viaggiaStationId: "S02088", viaggiaName: "PESCHIERA DEL GARDA", slug: "peschiera-del-garda" },
  { code: "VIC", name: "Vicenza", rfiLocationCode: "3043", viaggiaStationId: "S02446", viaggiaName: "VICENZA", slug: "vicenza" },
  { code: "F__", name: "Ferrara", rfiLocationCode: "1309", viaggiaStationId: "S05712", viaggiaName: "FERRARA", slug: "ferrara" },
  { code: "R__", name: "Rovigo", rfiLocationCode: "2445", viaggiaStationId: "S05706", viaggiaName: "ROVIGO", slug: "rovigo" },
  { code: "BAC", name: "Bari Centrale", rfiLocationCode: "995", viaggiaStationId: "S11119", viaggiaName: "BARI CENTRALE", slug: "bari-centrale" },
  { code: "ML_", name: "Molfetta", rfiLocationCode: "652", viaggiaStationId: "S11114", viaggiaName: "MOLFETTA", slug: "molfetta" },
  { code: "BIG", name: "Bisceglie", rfiLocationCode: "652", viaggiaStationId: "S11113", viaggiaName: "BISCEGLIE", slug: "bisceglie" },
  { code: "TR_", name: "Trani", rfiLocationCode: "2902", viaggiaStationId: "S11112", viaggiaName: "TRANI", slug: "trani" },
  { code: "BLT", name: "Barletta", rfiLocationCode: "598", viaggiaStationId: "S11108", viaggiaName: "BARLETTA", slug: "barletta" },
  { code: "FG_", name: "Foggia", rfiLocationCode: "1334", viaggiaStationId: "S11100", viaggiaName: "FOGGIA", slug: "foggia" },
  { code: "BEN", name: "Benevento", rfiLocationCode: "626", viaggiaStationId: "S09311", viaggiaName: "BENEVENTO", slug: "benevento" },
  { code: "BLZ", name: "Bolzano", rfiLocationCode: "685", viaggiaStationId: "S02026", viaggiaName: "BOLZANO", slug: "bolzano" },
  { code: "TCN", name: "Trento", rfiLocationCode: "2912", viaggiaStationId: "S02038", viaggiaName: "TRENTO", slug: "trento" },
  { code: "RVR", name: "Rovereto", rfiLocationCode: "2440", viaggiaStationId: "S02044", viaggiaName: "ROVERETO", slug: "rovereto" },
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

export function normalizeItaloStationName(value: unknown): string {
  return asString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019'`\u00b4]/g, " ")
    .replace(/[.\-_/(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function normalizeRfiLocationCode(value: unknown): string {
  const digits = asString(value).replace(/\D+/g, "");
  return digits.replace(/^0+/, "") || digits;
}

export function normalizeViaggiaStationId(value: unknown): string {
  return asString(value).toUpperCase().replace(/\s+/g, "");
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
      viaggiaName: asString(station.viaggiaName || existing?.viaggiaName) || undefined,
      viaggiaStationId: asString(station.viaggiaStationId || existing?.viaggiaStationId) || undefined,
    });
  }
  return [...byCode.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeItaloStations(stations: ItaloStationInfo[] = []): ItaloStationInfo[] {
  return mergeStations(stations);
}

function italoStationNameCandidates(station: ItaloStationInfo): string[] {
  return [station.name, station.viaggiaName, station.slug, ...(station.aliases || [])].map(normalizeItaloStationName);
}

function uniqueStationByRfi(stations: ItaloStationInfo[], rfiLocationCode: string): ItaloStationInfo | null {
  const matches = stations.filter((station) => normalizeRfiLocationCode(station.rfiLocationCode) === rfiLocationCode);
  return matches.length === 1 ? matches[0] : null;
}

export function findItaloStation(stations: ItaloStationInfo[], query: ItaloStationLookupQuery): ItaloStationInfo | null {
  const normalized = normalizeItaloStations(stations);
  const code = asString(query.code).toUpperCase();
  if (code) {
    const byCode = normalized.find((station) => station.code.toUpperCase() === code);
    if (byCode) return byCode;
  }

  const viaggiaStationId = normalizeViaggiaStationId(query.viaggiaStationId);
  if (viaggiaStationId) {
    const byViaggiaId = normalized.find((station) => normalizeViaggiaStationId(station.viaggiaStationId) === viaggiaStationId);
    if (byViaggiaId) return byViaggiaId;
  }

  const rfi = normalizeRfiLocationCode(query.rfiLocationCode);
  if (rfi) {
    const byRfi = uniqueStationByRfi(normalized, rfi);
    if (byRfi) return byRfi;
  }

  const name = normalizeItaloStationName(query.name);
  if (!name) return null;
  return normalized.find((station) => {
    const candidates = italoStationNameCandidates(station);
    return candidates.some((candidate) => candidate === name);
  }) || null;
}

export function normalizeItaloStationBoard(payload: ItaloStationPayload, stationCode: string, type: "partenze" | "arrivi"): NormalizedItaloStationBoardTrain[] {
  const rows = type === "arrivi" ? payload.ListaTreniArrivo : payload.ListaTreniPartenza;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const number = asString(row.Numero).replace(/\D+/g, "");
    const delay = asNumber(row.Ritardo);
    const platform = asString(row.Binario);
    const routeStation = findItaloStation([], { name: row.DescrizioneLocalita });
    const routeName = routeStation?.viaggiaName || asString(row.DescrizioneLocalita) || null;
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
      train.origine = routeName;
      train.compOrarioArrivo = asString(row.OraPassaggio) || null;
      train.compOrarioEffettivoArrivo = asString(row.NuovoOrario) || null;
      train.binarioEffettivoArrivoDescrizione = platform || null;
    } else {
      train.destinazione = routeName;
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
  const station = findItaloStation([], {
    code: raw.LocationCode,
    name,
    rfiLocationCode: raw.RfiLocationCode,
  });

  const scheduledArrival = parseRomeTime(raw.EstimatedArrivalTime, dateKey);
  const scheduledDeparture = parseRomeTime(raw.EstimatedDepartureTime, dateKey);
  const actualArrival = reached ? parseRomeTime(raw.ActualArrivalTime, dateKey) : null;
  const actualDeparture = reached ? parseRomeTime(raw.ActualDepartureTime, dateKey) : null;

  return {
    arrivoReale: actualArrival,
    arrivo_teorico: scheduledArrival,
    binarioEffettivoArrivoDescrizione: asString(raw.ActualArrivalPlatform) || null,
    binarioEffettivoPartenzaDescrizione: null,
    id: station?.viaggiaStationId || null,
    italoLocationCode: asString(raw.LocationCode) || null,
    italoStationName: name,
    partenzaReale: actualDeparture,
    partenza_teorica: scheduledDeparture,
    progressivo: asString(raw.StationNumber) || null,
    rfiLocationCode: asString(raw.RfiLocationCode) || null,
    ritardoArrivo: minutesBetween(scheduledArrival, actualArrival),
    ritardoPartenza: minutesBetween(scheduledDeparture, actualDeparture),
    source: "italo",
    stazione: station?.viaggiaName || name,
    viaggiaStationId: station?.viaggiaStationId || null,
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
    destinazione: last?.stazione || asString(schedule.ArrivalStationDescription) || "",
    fermate: stops,
    italoArrivalStationCode: asString(schedule.ArrivalStation) || null,
    italoDepartureStationCode: asString(schedule.DepartureStation) || null,
    italoLastUpdate: asString(payload.LastUpdate) || null,
    numeroTreno: trainNumber,
    operator: ITALO_OPERATOR,
    origine: first?.stazione || asString(schedule.DepartureStationDescription) || "",
    provider: "italo",
    source: "italo",
    stazioneUltimoRilevamento: lastReached?.stazione || null,
  };
}
