export interface ViaggiaTrenoStop {
  stazione?: string;
  name?: string;
  actualFermataType?: number | string;
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
  return stops.findIndex((stop) => normalizeStationMatchName(stop?.stazione || stop?.name) === target);
}

export function collectSuppressedStopNames(data: unknown): string[] {
  const names: string[] = [];
  const recordData = (data || {}) as PartialCancellationPayload;
  const raw = recordData.fermateSoppresse;
  if (!Array.isArray(raw)) return names;
  for (const item of raw) {
    if (typeof item === "string") {
      names.push(item);
    } else if (item && typeof item === "object") {
      const record = item as SuppressedStopRecord;
      names.push(String(record.stazione || record.nome || record.name || record.descrizione || ""));
    }
  }
  return names.filter(Boolean);
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

  const subtitle = String(data?.subTitle || data?.subtitle || "");
  if (!subtitle) return state;

  const cancelledRange = subtitle.match(/treno\s+cancellato\s+da\s+(.+?)\s+a\s+(.+?)(?:\.|$)/i);
  const startsFrom = subtitle.match(/parte\s+da\s+(.+?)(?:\.|$)/i);
  const arrivesAt = subtitle.match(/arriva\s+a\s+(.+?)(?:\.|$)/i);
  const trainChange = /viaggio\s+con\s+cambio\s+di\s+treno/i.test(subtitle);

  if (startsFrom?.[1]) {
    const startIndex = findStopIndexByName(stops, startsFrom[1]);
    if (startIndex >= 0) {
      for (let index = 0; index < startIndex; index += 1) state[index].cancelled = true;
      state[startIndex].cancelled = false;
      state[startIndex].boundary = "actualStart";
    }
  }

  if (arrivesAt?.[1]) {
    const endIndex = findStopIndexByName(stops, arrivesAt[1]);
    if (endIndex >= 0) {
      for (let index = endIndex + 1; index < state.length; index += 1) state[index].cancelled = true;
      state[endIndex].cancelled = false;
      state[endIndex].boundary = "actualEnd";
    }
  }

  if (cancelledRange && trainChange) {
    const fromIndex = findStopIndexByName(stops, cancelledRange[1]);
    const toIndex = findStopIndexByName(stops, cancelledRange[2]);
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
