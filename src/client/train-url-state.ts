export interface TrainUrlState {
  originId?: string;
  timestamp?: string;
  trainNumber: string;
}

export function normalizeTrainUrlNumber(value: unknown): string {
  return String(value || "").replace(/\D+/g, "").trim();
}

export function parseTrainTriple(triple: unknown): TrainUrlState | null {
  const [trainNumber, originId, timestamp] = String(triple || "").split("-");
  const normalizedTrain = normalizeTrainUrlNumber(trainNumber);
  const normalizedOrigin = String(originId || "").trim();
  const normalizedTimestamp = String(timestamp || "").trim();

  if (!normalizedTrain || !normalizedOrigin || !/^\d+$/.test(normalizedTimestamp)) {
    return null;
  }

  return {
    trainNumber: normalizedTrain,
    originId: normalizedOrigin,
    timestamp: normalizedTimestamp,
  };
}

export function readTrainUrlState(search: string): TrainUrlState | null {
  const params = new URLSearchParams(search);
  const trainNumber = normalizeTrainUrlNumber(params.get("train"));
  if (!trainNumber) return null;

  const originId = String(params.get("origin") || "").trim();
  const timestamp = String(params.get("ts") || "").trim();

  if (originId && /^\d+$/.test(timestamp)) {
    return { trainNumber, originId, timestamp };
  }

  return { trainNumber };
}

export function trainStateToSearch(state: TrainUrlState): string {
  const trainNumber = normalizeTrainUrlNumber(state.trainNumber);
  if (!trainNumber) return "";

  const params = new URLSearchParams();
  params.set("train", trainNumber);

  if (state.originId && state.timestamp && /^\d+$/.test(state.timestamp)) {
    params.set("origin", state.originId);
    params.set("ts", state.timestamp);
  }

  return params.toString();
}

export function trainTripleToSearch(triple: unknown): string {
  const state = parseTrainTriple(triple);
  return state ? trainStateToSearch(state) : "";
}
