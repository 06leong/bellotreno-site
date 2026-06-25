export interface ViaggiaTrenoStop {
  stazione?: string;
  name?: string;
  actualFermataType?: number | string | null;
}

export interface PartialCancellationState {
  cancelled: boolean;
  boundary: "" | "actualStart" | "actualEnd" | "replacementStart";
}

export type StopTimeStatus = "" | "early" | "late" | "on-time";

export interface StopTimeStatusInput {
  delayMinutes: unknown;
  realMs: unknown;
  scheduledMs: unknown;
  displayedMs?: unknown;
}

export interface PartialCancellationPayload {
  fermateSoppresse?: unknown;
  subTitle?: unknown;
  subtitle?: unknown;
}

export interface RouteDisplay {
  origin: string | undefined;
  destination: string | undefined;
}

interface PartialCancellationNotice {
  cancelledFrom?: string;
  cancelledTo?: string;
  startsFrom?: string;
  arrivesAt?: string;
  trainChange: boolean;
}

interface SuppressedStopRecord {
  descrizione?: unknown;
  name?: unknown;
  nome?: unknown;
  stazione?: unknown;
}

export function normalizeStationMatchName(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019'`\u00b4]/g, " ")
    .replace(/[-_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function cleanSubtitleStationName(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[;,]+$/g, "")
    .trim();
}

function sentenceStationMatch(text: string, regex: RegExp): string | undefined {
  const match = text.match(regex);
  return match?.[1] ? cleanSubtitleStationName(match[1]) : undefined;
}

function parsePartialCancellationNotice(data: PartialCancellationPayload): PartialCancellationNotice {
  const subtitle = String(data?.subTitle || data?.subtitle || "").trim();
  const range = subtitle.match(/treno\s+cancellato\s+da\s+(.+?)\s+a\s+(.+?)(?=\.(?:\s|$)|$)/i);

  return {
    cancelledFrom: range?.[1] ? cleanSubtitleStationName(range[1]) : undefined,
    cancelledTo: range?.[2] ? cleanSubtitleStationName(range[2]) : undefined,
    startsFrom: sentenceStationMatch(subtitle, /parte\s+da\s+(.+?)(?=\.(?:\s|$)|$)/i),
    arrivesAt: sentenceStationMatch(subtitle, /arriva\s+a\s+(.+?)(?=\.(?:\s|$)|$)/i),
    trainChange: /viaggio\s+con\s+cambio\s+di\s+treno/i.test(subtitle),
  };
}

function hasTimestamp(value: unknown): boolean {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0;
}

function sameTimestampMinute(left: unknown, right: unknown): boolean {
  if (!hasTimestamp(left) || !hasTimestamp(right)) return false;
  return Math.floor(Number(left) / 60000) === Math.floor(Number(right) / 60000);
}

/**
 * Resolve the visual status badge for a stop time.
 *
 * A scheduled time by itself is not realtime evidence. Non-zero delay values can
 * still be shown because they are explicit realtime estimates, but an "on time"
 * badge requires an actual timestamp from ViaggiaTreno.
 */
export function resolveStopTimeStatus(input: StopTimeStatusInput): StopTimeStatus {
  const delay = Number(input.delayMinutes);
  const hasRealTime = hasTimestamp(input.realMs);

  if (Number.isFinite(delay)) {
    if (delay > 0) return "late";
    if (delay < 0) return "early";
    if (delay === 0 && hasRealTime) return "on-time";
    return "";
  }

  if (hasRealTime && sameTimestampMinute(input.displayedMs ?? input.realMs, input.scheduledMs)) {
    return "on-time";
  }

  return "";
}

export function findStopIndexByName(stops: ViaggiaTrenoStop[], name: unknown): number {
  const target = normalizeStationMatchName(name);
  if (!target || !Array.isArray(stops)) return -1;

  const exact = stops.findIndex((stop) => normalizeStationMatchName(stop?.stazione || stop?.name) === target);
  if (exact >= 0) return exact;

  const targetTokens = target.split(" ").filter(Boolean);
  const meaningfulTargetTokens = targetTokens.filter((token) => token.length > 1);
  if (meaningfulTargetTokens.length < 2) return -1;

  return stops.findIndex((stop) => {
    const current = normalizeStationMatchName(stop?.stazione || stop?.name);
    if (!current) return false;
    if (current.includes(target) || target.includes(current)) return true;
    const currentTokens = new Set(current.split(" ").filter(Boolean));
    return meaningfulTargetTokens.every((token) => currentTokens.has(token));
  });
}

function collectSuppressedStopNameValues(value: unknown, names: string[]): void {
  if (!value) return;
  if (typeof value === "string") {
    names.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSuppressedStopNameValues(item, names));
    return;
  }
  if (typeof value === "object") {
    const record = value as SuppressedStopRecord & { denominazione?: unknown };
    [record.stazione, record.nome, record.name, record.descrizione, record.denominazione]
      .forEach((name) => {
        if (typeof name === "string") names.push(name);
      });
  }
}

export function collectSuppressedStopNames(data: unknown): string[] {
  const names: string[] = [];
  const recordData = (data || {}) as PartialCancellationPayload;
  collectSuppressedStopNameValues(recordData.fermateSoppresse, names);
  return names.filter(Boolean);
}

function displayNameForStopIndex(stops: ViaggiaTrenoStop[], index: number): string | undefined {
  if (index < 0) return undefined;
  const stop = stops[index];
  return stop?.stazione || stop?.name;
}

function resolvedNoticeStationName(stops: ViaggiaTrenoStop[], rawName: string | undefined): string | undefined {
  if (!rawName) return undefined;
  return displayNameForStopIndex(stops, findStopIndexByName(stops, rawName)) || rawName;
}

export function resolvePartialCancellationRouteDisplay(
  data: PartialCancellationPayload,
  stops: ViaggiaTrenoStop[],
  fallback: RouteDisplay,
): RouteDisplay {
  const notice = parsePartialCancellationNotice(data);
  return {
    origin: resolvedNoticeStationName(stops, notice.startsFrom) || fallback.origin,
    destination: resolvedNoticeStationName(stops, notice.arrivesAt) || fallback.destination,
  };
}

/**
 * Infer cancelled/boundary stops from ViaggiaTreno subtitle conventions.
 *
 */
export function buildPartialCancellationState(data: PartialCancellationPayload, stops: ViaggiaTrenoStop[]): PartialCancellationState[] {
  const state = (Array.isArray(stops) ? stops : []).map((stop) => ({
    cancelled: Number(stop?.actualFermataType) === 3,
    boundary: "" as PartialCancellationState["boundary"],
  }));
  if (!state.length) return state;

  for (const name of collectSuppressedStopNames(data)) {
    const index = findStopIndexByName(stops, name);
    if (index >= 0) state[index].cancelled = true;
  }

  const notice = parsePartialCancellationNotice(data);

  if (notice.startsFrom) {
    const startIndex = findStopIndexByName(stops, notice.startsFrom);
    if (startIndex >= 0) {
      for (let index = 0; index < startIndex; index += 1) state[index].cancelled = true;
      state[startIndex].cancelled = false;
      state[startIndex].boundary = "actualStart";
    }
  }

  if (notice.arrivesAt) {
    const endIndex = findStopIndexByName(stops, notice.arrivesAt);
    if (endIndex >= 0) {
      for (let index = endIndex + 1; index < state.length; index += 1) state[index].cancelled = true;
      state[endIndex].cancelled = false;
      state[endIndex].boundary = "actualEnd";
    }
  }

  if (notice.cancelledFrom && notice.cancelledTo && notice.trainChange) {
    const fromIndex = findStopIndexByName(stops, notice.cancelledFrom);
    const toIndex = findStopIndexByName(stops, notice.cancelledTo);
    if (fromIndex >= 0 && toIndex >= 0 && fromIndex < toIndex) {
      for (let index = fromIndex; index < toIndex; index += 1) state[index].cancelled = true;
      state[toIndex].cancelled = false;
      state[toIndex].boundary = "replacementStart";
    } else if (toIndex === 0) {
      state[0].cancelled = false;
      state[0].boundary = "replacementStart";
    }
  }

  return state;
}
