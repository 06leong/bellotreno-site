/**
 * @typedef {Object} ViaggiaTrenoStop
 * @property {string=} stazione
 * @property {string=} name
 * @property {number|string=} actualFermataType
 */

/**
 * @typedef {Object} PartialCancellationState
 * @property {boolean} cancelled
 * @property {""|"actualStart"|"actualEnd"|"replacementStart"} boundary
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeStationMatchName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019'`\u00b4]/g, " ")
    .replace(/[-_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * @param {ViaggiaTrenoStop[]} stops
 * @param {unknown} name
 * @returns {number}
 */
export function findStopIndexByName(stops, name) {
  const target = normalizeStationMatchName(name);
  if (!target || !Array.isArray(stops)) return -1;
  return stops.findIndex((stop) => normalizeStationMatchName(stop?.stazione || stop?.name) === target);
}

/**
 * @param {unknown} data
 * @returns {string[]}
 */
export function collectSuppressedStopNames(data) {
  /** @type {string[]} */
  const names = [];
  const recordData = /** @type {Record<string, unknown>} */ (data || {});
  const raw = recordData.fermateSoppresse;
  if (!Array.isArray(raw)) return names;
  for (const item of raw) {
    if (typeof item === "string") {
      names.push(item);
    } else if (item && typeof item === "object") {
      const record = /** @type {Record<string, unknown>} */ (item);
      names.push(String(record.stazione || record.nome || record.name || record.descrizione || ""));
    }
  }
  return names.filter(Boolean);
}

/**
 * Infer cancelled/boundary stops from ViaggiaTreno subtitle conventions.
 *
 * @param {Record<string, unknown>} data
 * @param {ViaggiaTrenoStop[]} stops
 * @returns {PartialCancellationState[]}
 */
export function buildPartialCancellationState(data, stops) {
  /** @type {PartialCancellationState[]} */
  const state = (Array.isArray(stops) ? stops : []).map((stop) => ({
    cancelled: Number(stop?.actualFermataType) === 3,
    boundary: "",
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
