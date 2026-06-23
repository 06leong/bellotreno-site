export type TrenitaliaRegionKey =
  | "abruzzo"
  | "alto_adige"
  | "basilicata"
  | "calabria"
  | "campania"
  | "emilia_romagna"
  | "friuli_venezia_giulia"
  | "lazio"
  | "liguria"
  | "lombardia"
  | "marche"
  | "molise"
  | "piemonte"
  | "puglia"
  | "sardegna"
  | "sicilia"
  | "toscana"
  | "trentino"
  | "umbria"
  | "valle_d_aosta"
  | "veneto";

export type TrenitaliaNoticeKind =
  | "regular"
  | "av_disruption"
  | "line"
  | "infotreni"
  | "regional"
  | "infolavori"
  | "other";

export type TrenitaliaNoticeBadgeKey =
  | "alta_velocita"
  | "linea"
  | "infotreni"
  | "regionale"
  | "infolavori"
  | "avviso";

export type TrenitaliaFilterKey =
  | "all"
  | "highlighted"
  | "avviso"
  | "line_train"
  | "infotreni"
  | "infolavori"
  | TrenitaliaRegionKey;

export interface TrenitaliaRegionFilter {
  key: TrenitaliaRegionKey;
  label: string;
  titleToken: string;
}

export interface TrenitaliaInfomobilityNoticeInput {
  evidenzia?: unknown;
  link?: unknown;
  pubDate?: unknown;
  regionTags?: unknown;
  title?: unknown;
  trainTags?: unknown;
}

export interface TrenitaliaNoticeClassification {
  badgeKey: TrenitaliaNoticeBadgeKey;
  filterKeys: TrenitaliaFilterKey[];
  isHighlighted: boolean;
  kind: TrenitaliaNoticeKind;
  regionKeys: TrenitaliaRegionKey[];
  regionTags: string[];
  safeLink: string;
  title: string;
  trainTags: string[];
}

export const TRENITALIA_REGION_FILTERS: readonly TrenitaliaRegionFilter[] = Object.freeze([
  { key: "abruzzo", label: "Abruzzo", titleToken: "ABRUZZO" },
  { key: "alto_adige", label: "Alto Adige", titleToken: "ALTO ADIGE" },
  { key: "basilicata", label: "Basilicata", titleToken: "BASILICATA" },
  { key: "calabria", label: "Calabria", titleToken: "CALABRIA" },
  { key: "campania", label: "Campania", titleToken: "CAMPANIA" },
  { key: "emilia_romagna", label: "Emilia-Romagna", titleToken: "EMILIA-ROMAGNA" },
  { key: "friuli_venezia_giulia", label: "Friuli Venezia Giulia", titleToken: "FRIULI VENEZIA GIULIA" },
  { key: "lazio", label: "Lazio", titleToken: "LAZIO" },
  { key: "liguria", label: "Liguria", titleToken: "LIGURIA" },
  { key: "lombardia", label: "Lombardia", titleToken: "LOMBARDIA" },
  { key: "marche", label: "Marche", titleToken: "MARCHE" },
  { key: "molise", label: "Molise", titleToken: "MOLISE" },
  { key: "piemonte", label: "Piemonte", titleToken: "PIEMONTE" },
  { key: "puglia", label: "Puglia", titleToken: "PUGLIA" },
  { key: "sardegna", label: "Sardegna", titleToken: "SARDEGNA" },
  { key: "sicilia", label: "Sicilia", titleToken: "SICILIA" },
  { key: "toscana", label: "Toscana", titleToken: "TOSCANA" },
  { key: "trentino", label: "Trentino", titleToken: "TRENTINO" },
  { key: "umbria", label: "Umbria", titleToken: "UMBRIA" },
  { key: "valle_d_aosta", label: "Valle d'Aosta", titleToken: "VALLE D'AOSTA" },
  { key: "veneto", label: "Veneto", titleToken: "VENETO" },
]);

const REGION_BY_NORMALIZED_LABEL = new Map<string, TrenitaliaRegionKey>(
  TRENITALIA_REGION_FILTERS.flatMap((region) => {
    const aliases = [region.label, region.titleToken, region.key.replace(/_/g, " ")];
    if (region.key === "emilia_romagna") aliases.push("EMILIA ROMAGNA");
    if (region.key === "friuli_venezia_giulia") aliases.push("FRIULI-VENEZIA GIULIA");
    if (region.key === "valle_d_aosta") aliases.push("VALLE D AOSTA", "VALLE D'AOSTA");
    return aliases.map((label) => [normalizeForMatch(label), region.key] as const);
  }),
);

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
}

export function normalizeForMatch(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function safeHttpUrl(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function trenitaliaRegionKeyFromText(value: unknown): TrenitaliaRegionKey | null {
  return REGION_BY_NORMALIZED_LABEL.get(normalizeForMatch(value)) || null;
}

function addTitleRegionKeys(normalizedTitle: string, regionKeys: Set<TrenitaliaRegionKey>): void {
  const prefix = "REGIONE ";
  if (!normalizedTitle.startsWith(prefix)) return;

  const titleRegion = normalizedTitle.slice(prefix.length);
  for (const region of TRENITALIA_REGION_FILTERS) {
    const token = normalizeForMatch(region.titleToken);
    if (
      titleRegion === token
      || titleRegion.startsWith(`${token}:`)
      || titleRegion.startsWith(`${token} -`)
    ) {
      regionKeys.add(region.key);
      return;
    }
  }
}

function classifyKind(title: string, trainTags: string[], regionTags: string[]): TrenitaliaNoticeKind {
  const normalizedTitle = normalizeForMatch(title);
  if (normalizedTitle.startsWith("INFOLAVORI ")) return "infolavori";
  if (normalizedTitle.startsWith("INFOTRENI ")) return "infotreni";
  if (normalizedTitle.startsWith("INFORMAZIONI SUL TRASPORTO REGIONALE")) return "regional";
  if (normalizedTitle.includes("ALTA VELOCITA") && !normalizedTitle.includes("CIRCOLAZIONE REGOLARE")) {
    return "av_disruption";
  }
  if (
    trainTags.length > 0
    || regionTags.length > 0
    || normalizedTitle.startsWith("LINEA ")
    || normalizedTitle.includes(" CIRCOLAZIONE SOSPESA")
    || normalizedTitle.includes(" CANCELLA")
  ) {
    return "line";
  }
  if (normalizedTitle.includes("CIRCOLAZIONE REGOLARE")) return "regular";
  return "other";
}

function badgeKeyForKind(kind: TrenitaliaNoticeKind): TrenitaliaNoticeBadgeKey {
  if (kind === "regular" || kind === "av_disruption") return "alta_velocita";
  if (kind === "line") return "linea";
  if (kind === "infotreni") return "infotreni";
  if (kind === "regional") return "regionale";
  if (kind === "infolavori") return "infolavori";
  return "avviso";
}

export function classifyTrenitaliaNotice(
  notice: TrenitaliaInfomobilityNoticeInput,
): TrenitaliaNoticeClassification {
  const title = asString(notice.title);
  const trainTags = asStringArray(notice.trainTags);
  const regionTags = asStringArray(notice.regionTags);
  const normalizedTitle = normalizeForMatch(title);
  const regionKeys = new Set<TrenitaliaRegionKey>();

  for (const tag of regionTags) {
    const key = trenitaliaRegionKeyFromText(tag);
    if (key) regionKeys.add(key);
  }

  if (normalizedTitle.startsWith("INFOLAVORI ")) {
    const titleRegion = normalizedTitle.replace(/^INFOLAVORI\s+/, "");
    const key = trenitaliaRegionKeyFromText(titleRegion);
    if (key) regionKeys.add(key);
  }
  addTitleRegionKeys(normalizedTitle, regionKeys);

  const kind = classifyKind(title, trainTags, regionTags);
  const isHighlighted = notice.evidenzia === true;
  const filterKeys = new Set<TrenitaliaFilterKey>(["all"]);
  if (isHighlighted) filterKeys.add("highlighted");
  if (kind === "other") filterKeys.add("avviso");
  if (kind === "line" || kind === "av_disruption") filterKeys.add("line_train");
  if (kind === "infotreni" || kind === "regional") filterKeys.add("infotreni");
  if (kind === "infolavori") filterKeys.add("infolavori");
  for (const key of regionKeys) filterKeys.add(key);

  return {
    badgeKey: badgeKeyForKind(kind),
    filterKeys: Array.from(filterKeys),
    isHighlighted,
    kind,
    regionKeys: Array.from(regionKeys),
    regionTags,
    safeLink: safeHttpUrl(notice.link),
    title,
    trainTags,
  };
}

export function trenitaliaNoticeMatchesFilter(
  notice: TrenitaliaInfomobilityNoticeInput,
  filterKey: TrenitaliaFilterKey,
): boolean {
  return classifyTrenitaliaNotice(notice).filterKeys.includes(filterKey);
}

export function buildTrenitaliaNoticeKey(notice: TrenitaliaInfomobilityNoticeInput): string {
  const title = normalizeForMatch(notice.title).toLowerCase();
  const pubDate = typeof notice.pubDate === "number" || typeof notice.pubDate === "string"
    ? String(notice.pubDate)
    : "";
  return `${title}|${pubDate}`;
}

export function dedupeTrenitaliaNotices<T extends TrenitaliaInfomobilityNoticeInput>(notices: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const notice of notices) {
    const key = buildTrenitaliaNoticeKey(notice);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(notice);
  }

  return unique;
}
