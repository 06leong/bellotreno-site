(function () {
    const cache = new Map();
    const SWISS_ENDPOINT = window.SWISS_FORMATION_BASE || window.SWISS_EC_BASE || "/api/swiss/formation";
    const ALWAYS_TRY_CATEGORIES = new Set(["EC", "EN"]);
    const HINTED_TRY_CATEGORIES = new Set(["REG", "RE", "RV", "S", "IR"]);
    const SWISS_BORDER_HINTS = new Set([
        "CHIASSO",
        "DOMODOSSOLA",
        "LUINO",
        "TIRANO",
        "GAGGIOLO",
        "PORTO CERESIO",
        "PONTE TRESA"
    ]);

    function tr(key, fallback) {
        const dict = typeof translations !== "undefined" ? translations : window.translations;
        return (dict && dict[window.currentLang] && dict[window.currentLang][key])
            || (dict && dict.en && dict.en[key])
            || fallback
            || key;
    }

    function esc(value) {
        return window.escapeHtml ? window.escapeHtml(value) : String(value ?? "");
    }

    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function getTrainNumber(data) {
        const direct = String(data?.numeroTreno || "").replace(/\D+/g, "");
        if (direct) return direct;
        return String(data?.compNumeroTreno || "").replace(/\D+/g, "");
    }

    function getOperationDate(data) {
        if (data?.dataPartenzaTrenoAsDate && /^\d{4}-\d{2}-\d{2}$/.test(data.dataPartenzaTrenoAsDate)) {
            return data.dataPartenzaTrenoAsDate;
        }

        const timestamp = Number(data?.dataPartenzaTreno);
        if (Number.isFinite(timestamp) && timestamp > 0) {
            return new Date(timestamp).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
        }

        return null;
    }

    function getTodayInZurich() {
        return new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Zurich",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(new Date());
    }

    function getCategory(data) {
        const comp = String(data?.compNumeroTreno || data?.categoria || "").trim().toUpperCase();
        if (comp.includes("EC FR")) return "FR";
        const match = comp.match(/^([A-Z]+(?:\s+[A-Z]+)?)\s*\d*$/);
        if (match) return match[1].trim();
        return String(data?.categoria || "").trim().toUpperCase();
    }

    function isSwissBoundaryName(name) {
        const key = normalizeStationName(name);
        if (!key) return false;
        return Array.from(SWISS_BORDER_HINTS).some((hint) => key === hint || key.includes(hint));
    }

    function hasSwissHint(data) {
        const directFields = [
            data?.origine,
            data?.destinazione,
            data?.origineEstera,
            data?.destinazioneEstera,
            data?.stazioneUltimoRilevamento
        ];

        if (directFields.some(isSwissBoundaryName)) return true;
        if (data?.origineEstera && data.origineEstera !== data.origine) return true;
        if (data?.destinazioneEstera && data.destinazioneEstera !== data.destinazione) return true;

        return asArray(data?.fermate).some((stop) => isSwissBoundaryName(stop?.stazione));
    }

    function shouldQuery(data, category) {
        const train = getTrainNumber(data);
        const operationDate = getOperationDate(data);
        if (!train || !operationDate || operationDate !== getTodayInZurich()) return false;

        const cat = String(category || getCategory(data)).toUpperCase();
        if (ALWAYS_TRY_CATEGORIES.has(cat)) return true;
        if (HINTED_TRY_CATEGORIES.has(cat) && hasSwissHint(data)) return true;
        return false;
    }

    async function fetchSwissByTrainNumber(trainNumber, operationDate) {
        const train = String(trainNumber || "").replace(/\D+/g, "");
        const date = String(operationDate || "").trim();

        if (!train || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return { available: false, reason: "bad_request" };
        }

        if (date !== getTodayInZurich()) {
            return { available: false, reason: "not_same_day" };
        }

        const key = `${train}-${date}`;
        if (!cache.has(key)) {
            const requestUrl = `${SWISS_ENDPOINT}?train=${encodeURIComponent(train)}&date=${encodeURIComponent(date)}`;
            cache.set(key, fetch(requestUrl).then(async (response) => {
                let payload = null;
                try {
                    payload = await response.json();
                } catch {
                    payload = null;
                }
                if (!response.ok || !payload) {
                    return { available: false, reason: payload?.reason || "upstream_error" };
                }
                return payload;
            }).catch(() => ({ available: false, reason: "upstream_error" })));
        }

        return cache.get(key);
    }

    async function fetchSwissEc(data, category) {
        const train = getTrainNumber(data);
        const operationDate = getOperationDate(data);

        if (!shouldQuery(data, category)) {
            return { available: false, reason: "not_supported" };
        }

        if (!train || !operationDate) {
            return { available: false, reason: "bad_request" };
        }

        return fetchSwissByTrainNumber(train, operationDate);
    }

    function normalizeStationName(name) {
        let text = String(name || "")
            .replace(/\((?:I|IT|CH)\)/gi, " ")
            .replace(/\b(?:I|IT|CH)\b$/gi, " ");

        text = text
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase()
            .replace(/\bSTAZIONE\b/g, "")
            .replace(/\b(?:FFS|SBB|CFF)\b/g, "")
            .replace(/[^A-Z0-9]+/g, " ")
            .trim()
            .replace(/\s+/g, " ");

        if (isSimplonGalleryKey(text)) {
            return "DOMODOSSOLA";
        }

        return text.replace(/\b(?:I|IT|CH)\b$/g, "").trim();
    }

    function isSimplonGalleryKey(key) {
        const text = String(key || "").toUpperCase();
        return text.includes("GALLERIA SEMPIONE")
            || text.includes("GALLERIE DU SIMPLON")
            || text.includes("GALERIE DU SIMPLON")
            || text.includes("SIMPLON TUNNEL")
            || text.includes("SIMPLONTUNNEL")
            || (text.includes("SIMPLON") && (text.includes("GALLERY") || text.includes("GALLERIE") || text.includes("GALERIE") || text.includes("TUNNEL")));
    }

    function isTechnicalSwissStop(stop) {
        const key = normalizeStationName(stop?.name || stop?.stazione || "");
        const raw = String(stop?.name || stop?.stazione || "").toUpperCase();
        return key === "DOMODOSSOLA" && isSimplonGalleryKey(raw);
    }

    function stationKeys(name) {
        const key = normalizeStationName(name);
        if (!key) return [];
        const keys = new Set([key]);
        const withoutSuffix = key.replace(/\b(?:I|IT|CH)\b$/g, "").trim();
        if (withoutSuffix) keys.add(withoutSuffix);
        return Array.from(keys);
    }

    function findVtEntryForSwiss(swissEntry, vtByName) {
        for (const key of stationKeys(swissEntry.stop?.name)) {
            const exact = vtByName.get(key);
            if (exact) return exact;
        }

        const swissKey = normalizeStationName(swissEntry.stop?.name);
        if (!swissKey) return null;

        for (const [key, entry] of vtByName.entries()) {
            if (key.length >= 5 && swissKey.length >= 5 && (key.includes(swissKey) || swissKey.includes(key))) {
                return entry;
            }
        }

        return null;
    }

    function parseIsoMs(value) {
        if (!value) return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }

    function cleanTrack(track) {
        const value = String(track || "").trim();
        if (!value || value.toUpperCase() === "N/A") return "";
        return value;
    }

    function toSwissTimelineStop(stop) {
        const arrivalMs = parseIsoMs(stop.arrivalTime);
        const departureMs = parseIsoMs(stop.departureTime);
        const track = cleanTrack(stop.track);
        const displayName = isTechnicalSwissStop(stop) ? "Domodossola" : stop.name;

        return {
            source: "swiss",
            id: stop.uic ? `CH-${stop.uic}` : `CH-${normalizeStationName(stop.name)}`,
            stazione: displayName,
            arrivo_teorico: arrivalMs,
            partenza_teorica: departureMs,
            programmata: departureMs || arrivalMs,
            arrivoReale: null,
            partenzaReale: null,
            ritardoArrivo: 0,
            ritardoPartenza: 0,
            binarioProgrammatoArrivoDescrizione: track,
            binarioProgrammatoPartenzaDescrizione: track,
            binarioEffettivoArrivoDescrizione: track,
            binarioEffettivoPartenzaDescrizione: track,
            progressivo: "SBB",
            actualFermataType: stop.stopType === "D" ? 0 : 1,
            swissStop: stop
        };
    }

    function decorateVtStop(stop, swissStop, vtIndex) {
        const copy = { ...stop, swissStop, __btVtIndex: vtIndex };
        const hasPlatform = stop.binarioProgrammatoPartenzaDescrizione
            || stop.binarioProgrammatoArrivoDescrizione
            || stop.binarioEffettivoPartenzaDescrizione
            || stop.binarioEffettivoArrivoDescrizione;
        const track = cleanTrack(swissStop?.track);

        if (!hasPlatform && track) {
            copy.binarioEffettivoArrivoDescrizione = track;
            copy.binarioEffettivoPartenzaDescrizione = track;
        }

        return copy;
    }

    function stripInternal(stop) {
        const copy = { ...stop };
        delete copy.__btVtIndex;
        return copy;
    }

    function insertByVtIndex(merged, stop, vtIndex, anchorIndexes) {
        const previousAnchors = anchorIndexes.filter((idx) => idx < vtIndex);
        const nextAnchors = anchorIndexes.filter((idx) => idx > vtIndex);
        const previous = previousAnchors.length ? previousAnchors[previousAnchors.length - 1] : null;
        const next = nextAnchors.length ? nextAnchors[0] : null;

        if (previous !== null) {
            let pos = -1;
            for (let i = merged.length - 1; i >= 0; i--) {
                if (merged[i].__btVtIndex === previous) {
                    pos = i;
                    break;
                }
            }
            merged.splice(pos >= 0 ? pos + 1 : merged.length, 0, { ...stop, __btVtIndex: vtIndex });
            return;
        }

        if (next !== null) {
            const pos = merged.findIndex((item) => item.__btVtIndex === next);
            merged.splice(pos >= 0 ? pos : 0, 0, { ...stop, __btVtIndex: vtIndex });
            return;
        }

        merged.push({ ...stop, __btVtIndex: vtIndex });
    }

    function swissTimelineStops(swissEntries) {
        return swissEntries
            .filter((entry) => !isTechnicalSwissStop(entry.stop))
            .map((entry) => toSwissTimelineStop(entry.stop));
    }

    function mergeByBoundaryAnchor(sourceStops, vtEntries, swissEntries) {
        const swissStops = swissTimelineStops(swissEntries);
        if (!sourceStops.length || !swissStops.length) return null;

        const firstEntry = vtEntries[0];
        const lastEntry = vtEntries[vtEntries.length - 1];

        if (lastEntry && isSwissBoundaryName(lastEntry.stop?.stazione)) {
            return [...sourceStops, ...swissStops];
        }

        if (firstEntry && isSwissBoundaryName(firstEntry.stop?.stazione)) {
            return [...swissStops, ...sourceStops];
        }

        return null;
    }

    function mergeTimelineStops(vtStops, swissData) {
        const sourceStops = asArray(vtStops);
        if (!swissData?.available || !asArray(swissData.stops).length) return sourceStops;

        const vtEntries = sourceStops.map((stop, index) => ({
            stop,
            index,
            key: normalizeStationName(stop.stazione)
        })).filter((entry) => entry.key);

        const vtByName = new Map();
        for (const entry of vtEntries) {
            for (const key of stationKeys(entry.stop?.stazione)) {
                if (!vtByName.has(key)) vtByName.set(key, entry);
            }
        }

        const swissEntries = asArray(swissData.stops).map((stop) => ({
            stop,
            key: normalizeStationName(stop.name)
        })).filter((entry) => entry.key);

        const hasMatch = swissEntries.some((entry) => findVtEntryForSwiss(entry, vtByName));
        if (!hasMatch) return mergeByBoundaryAnchor(sourceStops, vtEntries, swissEntries) || sourceStops;

        const merged = [];
        const usedVtIndexes = new Set();

        for (const swissEntry of swissEntries) {
            const vtEntry = findVtEntryForSwiss(swissEntry, vtByName);
            if (vtEntry && !usedVtIndexes.has(vtEntry.index)) {
                merged.push(decorateVtStop(vtEntry.stop, swissEntry.stop, vtEntry.index));
                usedVtIndexes.add(vtEntry.index);
            } else if (!vtEntry && !isTechnicalSwissStop(swissEntry.stop)) {
                merged.push(toSwissTimelineStop(swissEntry.stop));
            }
        }

        const anchorIndexes = Array.from(usedVtIndexes).sort((a, b) => a - b);
        for (const entry of vtEntries) {
            if (!usedVtIndexes.has(entry.index)) {
                insertByVtIndex(merged, entry.stop, entry.index, anchorIndexes);
                usedVtIndexes.add(entry.index);
                anchorIndexes.push(entry.index);
                anchorIndexes.sort((a, b) => a - b);
            }
        }

        return merged.map(stripInternal);
    }

    function formatZurichDateTime(value) {
        if (!value) return "--";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "--";
        return date.toLocaleString(window.currentLang === "it" ? "it-IT" : window.currentLang === "zh" ? "zh-CN" : "en-GB", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Zurich"
        });
    }

    function formatZurichTime(value) {
        if (!value) return "--";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "--";
        return date.toLocaleTimeString(window.currentLang === "it" ? "it-IT" : "en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Zurich"
        });
    }

    function parseCoachToken(rawToken, sector, previousClass, insideGroup, hasExplicitGroup) {
        if (hasExplicitGroup && !insideGroup) return null;

        let token = rawToken.trim();
        if (!token || token === "[" || token === "]") return null;

        token = token.replace(/^[([]+/, "").replace(/[\])]+$/, "").trim();
        if (!token) return null;

        const closed = token.includes("-");
        token = token.replace(/[>\-=]/g, "");

        const [mainPart, servicePart] = token.split("#");
        const main = (mainPart || "").trim();
        if (!main) return null;

        let classCode = "";
        let number = null;
        const parts = main.split(":");
        const kind = parts[0] || "";
        if (parts.length > 1 && parts[1]) {
            const parsedNumber = Number.parseInt(parts[1], 10);
            if (Number.isFinite(parsedNumber)) number = parsedNumber;
        }

        if (kind) {
            classCode = kind;
        } else {
            classCode = previousClass || "?";
        }

        const hiddenType = classCode.toUpperCase().replace(/:.*$/, "");
        if (["F", "X"].includes(hiddenType)) return null;

        let classLabel = classCode;
        if (classCode.includes("12")) classLabel = "1/2";
        else if (classCode.includes("1")) classLabel = "1";
        else if (classCode.includes("2")) classLabel = "2";
        else if (classCode.startsWith("W")) classLabel = classCode;
        else if (classCode === "D") classLabel = "D";
        else if (classCode === "K") classLabel = "?";

        return {
            sector,
            raw: rawToken.trim(),
            classCode,
            classLabel,
            number,
            closed,
            services: servicePart ? servicePart.split(";").map((part) => part.trim()).filter(Boolean) : []
        };
    }

    function parseFormationShortString(value) {
        const text = String(value || "");
        if (!text.trim()) return [];

        const hasExplicitGroup = text.includes("[");
        const sectorChunks = text.replace(/@/g, "|@").split("|").filter(Boolean);
        const coaches = [];
        let previousClass = "";

        for (const chunk of sectorChunks) {
            const match = chunk.match(/^@([A-Z0-9]+)/);
            if (!match) continue;

            const sector = match[1];
            const body = chunk.slice(match[0].length)
                .replace(/\[/g, ",[,")
                .replace(/\]/g, ",],")
                .replace(/\(/g, ",")
                .replace(/\)/g, ",");
            const tokens = body.split(",");
            let insideGroup = !hasExplicitGroup;

            for (const rawToken of tokens) {
                const trimmed = rawToken.trim();
                if (trimmed === "[") {
                    insideGroup = true;
                    continue;
                }
                if (trimmed === "]") {
                    insideGroup = false;
                    continue;
                }

                const coach = parseCoachToken(trimmed, sector, previousClass, insideGroup, hasExplicitGroup);
                if (!coach) continue;
                coaches.push(coach);
                previousClass = coach.classCode || previousClass;
            }
        }

        return coaches;
    }

    function sectorForVehicle(vehicle, selectedStop) {
        const sectors = asArray(vehicle?.stopSectors);
        if (!sectors.length) return null;
        if (selectedStop?.uic) {
            const exactMatches = sectors.filter((item) => item.uic === selectedStop.uic);
            if (exactMatches.length) {
                return bestStopSector(exactMatches);
            }
        }
        return bestStopSector(sectors);
    }

    function sectorRanks(value) {
        const text = String(value || "").trim().toUpperCase();
        if (!text || ["TRAIN", "UNKNOWN", "--"].includes(text)) return [];
        const compact = text.replace(/[^A-Z]/g, "");
        if (!compact || (compact.length > 4 && !/[,\s;/]/.test(text))) return [];
        const letters = compact.split("");
        return Array.from(new Set(letters))
            .map((letter) => letter.charCodeAt(0) - 65)
            .filter((rank) => rank >= 0 && rank < 26)
            .sort((a, b) => a - b);
    }

    function canonicalSector(value) {
        const ranks = sectorRanks(value);
        if (!ranks.length) return value ? String(value) : "";
        return ranks.map((rank) => String.fromCharCode(65 + rank)).join(",");
    }

    function sectorSortRange(value) {
        const ranks = sectorRanks(value);
        if (!ranks.length) {
            return { min: 999, max: 999, mid: 999 };
        }
        const min = ranks[0];
        const max = ranks[ranks.length - 1];
        return { min, max, mid: (min + max) / 2 };
    }

    function normalizeStopSector(stopSector) {
        if (!stopSector) return null;
        return {
            ...stopSector,
            sectors: canonicalSector(stopSector.sectors || "")
        };
    }

    function bestStopSector(stopSectors) {
        const normalized = asArray(stopSectors).map(normalizeStopSector).filter(Boolean);
        if (!normalized.length) return null;

        const sorted = normalized.slice().sort((left, right) => {
            const leftRange = sectorSortRange(left.sectors);
            const rightRange = sectorSortRange(right.sectors);
            return leftRange.min - rightRange.min
                || leftRange.max - rightRange.max
                || String(left.track || "").localeCompare(String(right.track || ""))
                || String(left.name || "").localeCompare(String(right.name || ""));
        });
        const first = sorted[0];
        return {
            ...first,
            accessToPreviousVehicle: sorted.some((item) => item.accessToPreviousVehicle === false)
                ? false
                : first.accessToPreviousVehicle
        };
    }

    function vehicleUniqueKey(vehicle) {
        if (vehicle?.evn) return `evn:${vehicle.evn}`;
        const fullNumber = [
            vehicle?.buildTypeCode,
            vehicle?.countryCode,
            vehicle?.vehicleNumber,
            vehicle?.checkNumber
        ].filter(Boolean).join(":");
        if (fullNumber) return `vehicle:${fullNumber}`;
        return `fallback:${vehicle?.position || ""}:${vehicle?.number || ""}:${vehicle?.typeCodeName || ""}:${vehicle?.typeCode || ""}`;
    }

    function mergeUniqueBy(list, keyFn) {
        const map = new Map();
        asArray(list).forEach((item) => {
            const key = keyFn(item);
            if (!key || !map.has(key)) map.set(key || `item:${map.size}`, item);
        });
        return Array.from(map.values());
    }

    function mergeStatusFlag(existing, incoming) {
        return Boolean(existing && incoming);
    }

    function preferTrolleyStatus(existing, incoming) {
        if (!existing || existing === "Normal") return existing || incoming;
        if (!incoming || incoming === "Normal") return incoming || existing;
        return existing;
    }

    function mergeVehicle(existing, incoming) {
        return {
            ...existing,
            position: Math.min(existing.position || incoming.position || 9999, incoming.position || existing.position || 9999),
            number: existing.number || incoming.number,
            typeCode: existing.typeCode || incoming.typeCode,
            typeCodeName: existing.typeCodeName || incoming.typeCodeName,
            buildTypeCode: existing.buildTypeCode || incoming.buildTypeCode,
            countryCode: existing.countryCode || incoming.countryCode,
            vehicleNumber: existing.vehicleNumber || incoming.vehicleNumber,
            checkNumber: existing.checkNumber || incoming.checkNumber,
            evn: existing.evn || incoming.evn,
            parentEvn: existing.parentEvn || incoming.parentEvn,
            length: Math.max(existing.length || 0, incoming.length || 0),
            numberRestaurantSpace: Math.max(existing.numberRestaurantSpace || 0, incoming.numberRestaurantSpace || 0),
            numberBeds: Math.max(existing.numberBeds || 0, incoming.numberBeds || 0),
            firstClassSeats: Math.max(existing.firstClassSeats || 0, incoming.firstClassSeats || 0),
            secondClassSeats: Math.max(existing.secondClassSeats || 0, incoming.secondClassSeats || 0),
            bikeHooks: Math.max(existing.bikeHooks || 0, incoming.bikeHooks || 0),
            wheelchairSpaces: Math.max(existing.wheelchairSpaces || 0, incoming.wheelchairSpaces || 0),
            lowFloor: existing.lowFloor || incoming.lowFloor,
            wheelchairToilet: existing.wheelchairToilet || incoming.wheelchairToilet,
            wheelchairAccessibleRestaurant: existing.wheelchairAccessibleRestaurant || incoming.wheelchairAccessibleRestaurant,
            disabledCompartment: existing.disabledCompartment || incoming.disabledCompartment,
            wheelchairSpacesFirstClass: Math.max(existing.wheelchairSpacesFirstClass || 0, incoming.wheelchairSpacesFirstClass || 0),
            wheelchairSpacesSecondClass: Math.max(existing.wheelchairSpacesSecondClass || 0, incoming.wheelchairSpacesSecondClass || 0),
            wheelchairFoldingRamp: existing.wheelchairFoldingRamp || incoming.wheelchairFoldingRamp,
            wheelchairGapBridging: existing.wheelchairGapBridging || incoming.wheelchairGapBridging,
            wheelchairBoardingPlatformHeight: Math.max(existing.wheelchairBoardingPlatformHeight || 0, incoming.wheelchairBoardingPlatformHeight || 0),
            bikePlatform: existing.bikePlatform || incoming.bikePlatform,
            emergencyCallSystem: existing.emergencyCallSystem || incoming.emergencyCallSystem,
            climated: existing.climated || incoming.climated,
            wheelchairPicto: existing.wheelchairPicto || incoming.wheelchairPicto,
            bikePicto: existing.bikePicto || incoming.bikePicto,
            strollerPicto: existing.strollerPicto || incoming.strollerPicto,
            familyZonePicto: existing.familyZonePicto || incoming.familyZonePicto,
            businessZonePicto: existing.businessZonePicto || incoming.businessZonePicto,
            closed: mergeStatusFlag(existing.closed, incoming.closed),
            vehicleWillBePutAway: mergeStatusFlag(existing.vehicleWillBePutAway, incoming.vehicleWillBePutAway),
            trolleyStatus: preferTrolleyStatus(existing.trolleyStatus, incoming.trolleyStatus),
            fromStop: existing.fromStop || incoming.fromStop,
            toStop: existing.toStop || incoming.toStop,
            segments: mergeUniqueBy([...(existing.segments || []), ...(incoming.segments || [])], (segment) => [
                segment.fromStop || "",
                segment.toStop || "",
                segment.closed ? "closed" : "open",
                segment.vehicleWillBePutAway ? "putaway" : "active",
                segment.trolleyStatus || ""
            ].join("|")),
            stopSectors: mergeUniqueBy([...(existing.stopSectors || []), ...(incoming.stopSectors || [])], (stop) => [
                stop.uic || "",
                stop.name || "",
                stop.track || "",
                stop.sectors || "",
                stop.arrivalTime || "",
                stop.departureTime || "",
                stop.accessToPreviousVehicle
            ].join("|"))
        };
    }

    function allVehicles(vehicles) {
        const map = new Map();
        asArray(vehicles).forEach((vehicle) => {
            const key = vehicleUniqueKey(vehicle);
            if (map.has(key)) map.set(key, mergeVehicle(map.get(key), vehicle));
            else map.set(key, vehicle);
        });
        return Array.from(map.values()).sort(compareVehiclesByPhysicalOrder);
    }

    function compareVehiclesByPhysicalOrder(left, right) {
        return vehicleUnitSortValue(left) - vehicleUnitSortValue(right)
            || (left?.number || 9999) - (right?.number || 9999)
            || (left?.position || 9999) - (right?.position || 9999)
            || String(left?.evn || left?.vehicleNumber || "").localeCompare(String(right?.evn || right?.vehicleNumber || ""));
    }

    function vehiclesForFormation(vehicles) {
        return allVehicles(vehicles).slice().sort(compareVehiclesByPhysicalOrder);
    }

    function vehicleHasPassengerSeats(vehicle) {
        return Number(vehicle?.firstClassSeats || 0) > 0 || Number(vehicle?.secondClassSeats || 0) > 0;
    }

    function isLikelyLocomotive(vehicle) {
        if (vehicleHasPassengerSeats(vehicle)) return false;
        const type = String(vehicle?.typeCodeName || vehicle?.typeCode || "").toUpperCase();
        return /(^|[^A-Z])(LOK|LOCO|RE|AE|E[0-9]|BR|VECTRON)([^A-Z]|$)/.test(type);
    }

    function vehicleClassLabel(vehicle, coach) {
        if (coach?.classLabel && coach.classLabel !== "?") return coach.classLabel;
        const first = Number(vehicle?.firstClassSeats || 0);
        const second = Number(vehicle?.secondClassSeats || 0);
        if (first > 0 && second > 0) return "1/2";
        if (first > 0) return "1";
        if (second > 0) return "2";
        return isLikelyLocomotive(vehicle) ? tr("swiss_loco", "Loco") : tr("swiss_vehicle", "Vehicle");
    }

    function coachTokenLooksLikeLoco(coach) {
        return ["LK"].includes(String(coach?.classCode || "").toUpperCase());
    }

    function vehicleDisplayNumber(vehicle, coach) {
        return vehicle?.number || coach?.number || vehicle?.vehicleNumber || vehicle?.position || "--";
    }

    function coachQueuesByNumber(coaches) {
        const queues = new Map();
        asArray(coaches).forEach((coach) => {
            if (!coach?.number) return;
            const key = String(coach.number);
            if (!queues.has(key)) queues.set(key, []);
            queues.get(key).push(coach);
        });
        return queues;
    }

    function takeCoachForVehicle(vehicle, queues) {
        const key = vehicle?.number ? String(vehicle.number) : "";
        if (!key || !queues.has(key)) return null;
        const queue = queues.get(key);
        return queue.length ? queue.shift() : null;
    }

    function shouldShowNoPassage(selectedSector, index) {
        return index > 0 && selectedSector?.accessToPreviousVehicle === false;
    }

    function isClosedTrolleyStatus(value) {
        return /geschlossen/i.test(String(value || ""));
    }

    function stopKey(value) {
        return normalizeStationName(value?.name || value?.stazione || value || "");
    }

    function stopIndexByKey(stops, key) {
        const normalized = normalizeStationName(key);
        if (!normalized) return -1;
        return asArray(stops).findIndex((stop) => {
            const candidate = stopKey(stop);
            return candidate === normalized
                || (candidate.length >= 5 && normalized.length >= 5 && (candidate.includes(normalized) || normalized.includes(candidate)));
        });
    }

    function segmentContainsStop(segment, selectedKey, stops) {
        const fromKey = stopKey(segment?.fromStop);
        const toKey = stopKey(segment?.toStop);
        if (fromKey === selectedKey || toKey === selectedKey) return true;

        const selectedIndex = stopIndexByKey(stops, selectedKey);
        const fromIndex = stopIndexByKey(stops, fromKey);
        const toIndex = stopIndexByKey(stops, toKey);
        if (selectedIndex < 0 || fromIndex < 0 || toIndex < 0) return false;

        const start = Math.min(fromIndex, toIndex);
        const end = Math.max(fromIndex, toIndex);
        return selectedIndex >= start && selectedIndex <= end;
    }

    function segmentStatus(segment) {
        const trolleyStatus = segment?.trolleyStatus || "";
        return {
            closed: Boolean(segment?.closed) || isClosedTrolleyStatus(trolleyStatus),
            vehicleWillBePutAway: Boolean(segment?.vehicleWillBePutAway),
            trolleyStatus,
            segment: segment || null
        };
    }

    function fallbackVehicleStatus(vehicle) {
        const trolleyStatus = vehicle?.trolleyStatus || "";
        return {
            closed: Boolean(vehicle?.closed) || isClosedTrolleyStatus(trolleyStatus),
            vehicleWillBePutAway: Boolean(vehicle?.vehicleWillBePutAway),
            trolleyStatus,
            segment: null
        };
    }

    function preferredDisplaySegment(segments) {
        const list = asArray(segments);
        return list.find((segment) => {
            const status = segmentStatus(segment);
            return !status.closed && !status.vehicleWillBePutAway;
        }) || list[0] || null;
    }

    function activeVehicleStatus(vehicle, selectedStop, stops) {
        const segments = asArray(vehicle?.segments);
        const selectedKey = stopKey(selectedStop);
        if (segments.length && selectedKey) {
            const fromMatch = preferredDisplaySegment(segments.filter((segment) => stopKey(segment?.fromStop) === selectedKey));
            if (fromMatch) return segmentStatus(fromMatch);

            const containingMatch = preferredDisplaySegment(segments.filter((segment) => segmentContainsStop(segment, selectedKey, stops)));
            if (containingMatch) return segmentStatus(containingMatch);
        }

        if (segments.length) {
            const activeSegment = preferredDisplaySegment(segments);
            return segmentStatus(activeSegment);
        }

        return fallbackVehicleStatus(vehicle);
    }

    function vehicleIsClosedForDisplay(status, coach) {
        return Boolean(status?.closed || status?.vehicleWillBePutAway || (!status && coach?.closed));
    }

    function trolleyStatusLabel(status) {
        const value = String(status || "").trim();
        if (!value || value === "Normal") return "";
        if (/GeschlossenBetrieblich/i.test(value)) return tr("swiss_closed_operational", "Operationally closed");
        if (/GeschlossenTechnisch/i.test(value)) return tr("swiss_closed_technical", "Technically closed");
        if (/geschlossen/i.test(value)) return tr("swiss_closed", "Closed");
        return value;
    }

    function featureEntries(coach, vehicle, selectedSector, index = 0, status = null) {
        const services = new Set(asArray(coach?.services));
        const entries = [];
        if (vehicle?.lowFloor || services.has("NF")) entries.push({ id: "low_floor", icon: "accessible_forward", label: tr("swiss_low_floor", "Low floor") });
        if (vehicle?.wheelchairSpaces || vehicle?.wheelchairPicto || services.has("BHP")) entries.push({ id: "wheelchair", icon: "accessible", label: tr("swiss_wheelchair", "Wheelchair") });
        if (vehicle?.wheelchairToilet) entries.push({ id: "wheelchair_wc", icon: "wc", label: tr("swiss_wheelchair_wc", "Wheelchair WC") });
        if (vehicle?.bikeHooks || vehicle?.bikePlatform || vehicle?.bikePicto || services.has("VH") || services.has("VR")) entries.push({ id: "bike", icon: "directions_bike", label: services.has("VR") ? tr("swiss_bike_reservation", "Bike reservation required") : tr("swiss_bike", "Bike") });
        if (vehicle?.strollerPicto || services.has("KW")) entries.push({ id: "stroller", icon: "child_friendly", label: tr("swiss_stroller", "Stroller") });
        if (vehicle?.familyZonePicto || services.has("FZ") || services.has("FA")) entries.push({ id: "family", icon: "family_restroom", label: tr("swiss_family", "Family") });
        if (vehicle?.businessZonePicto || services.has("BZ")) entries.push({ id: "business", icon: "business_center", label: tr("swiss_business", "Business") });
        if (vehicle?.numberRestaurantSpace || vehicle?.wheelchairAccessibleRestaurant || String(coach?.classCode || vehicle?.typeCodeName || "").toUpperCase().includes("WR")) entries.push({ id: "restaurant", icon: "restaurant", label: tr("swiss_restaurant", "Restaurant") });
        if (vehicle?.climated) entries.push({ id: "climated", icon: "ac_unit", label: tr("swiss_climated", "Air-conditioned") });
        if (vehicle?.emergencyCallSystem) entries.push({ id: "emergency", icon: "emergency_home", label: tr("swiss_emergency_call", "Emergency call") });
        if (shouldShowNoPassage(selectedSector, index)) entries.push({ id: "no_passage", icon: "link_off", label: tr("swiss_no_passage", "No passage") });
        if (vehicleIsClosedForDisplay(status, coach)) entries.push({ id: "closed", icon: "block", label: tr("swiss_closed", "Closed") });
        return entries;
    }

    function renderFeatureIcons(coach, vehicle, selectedSector, index, status) {
        return featureEntries(coach, vehicle, selectedSector, index, status)
            .map((entry) => `<span class="material-symbols-outlined" title="${esc(entry.label)}">${esc(entry.icon)}</span>`)
            .join("");
    }

    function sectorLabel(sector) {
        if (!sector || sector === "TRAIN") return tr("swiss_train_segment", "Train");
        return `${tr("swiss_sector", "Sector")} ${sector}`;
    }

    function vehicleSector(vehicle, coach, selectedStop, selectedSector = null) {
        const stopSector = selectedSector || sectorForVehicle(vehicle, selectedStop);
        return canonicalSector(stopSector?.sectors || coach?.sector || "TRAIN") || "TRAIN";
    }

    function vehicleSortNumber(item) {
        const parsed = Number.parseInt(vehicleDisplayNumber(item.vehicle, item.coach), 10);
        return Number.isFinite(parsed) ? parsed : 9999;
    }

    function itemSectorRange(item) {
        return sectorSortRange(item.sector);
    }

    function itemUnitSortValue(item) {
        const key = item.unitKey || "";
        if (!key) return 9999;
        const parsed = Number.parseInt(key.split(":")[1] || "", 10);
        return Number.isFinite(parsed) ? parsed : 9999;
    }

    function directionForUnit(items) {
        const ranked = items
            .map((item) => ({
                number: vehicleSortNumber(item),
                sector: itemSectorRange(item).mid
            }))
            .filter((item) => item.number !== 9999 && item.sector !== 999);

        if (ranked.length < 2) return 1;

        let numberSum = 0;
        let sectorSum = 0;
        ranked.forEach((item) => {
            numberSum += item.number;
            sectorSum += item.sector;
        });
        const numberMean = numberSum / ranked.length;
        const sectorMean = sectorSum / ranked.length;
        let covariance = 0;
        ranked.forEach((item) => {
            covariance += (item.number - numberMean) * (item.sector - sectorMean);
        });
        return covariance < 0 ? -1 : 1;
    }

    function compareItemsWithinUnit(direction) {
        return (left, right) => {
            const leftRange = itemSectorRange(left);
            const rightRange = itemSectorRange(right);
            const leftNumber = vehicleSortNumber(left);
            const rightNumber = vehicleSortNumber(right);
            return leftRange.min - rightRange.min
                || leftRange.max - rightRange.max
                || (direction < 0 ? rightNumber - leftNumber : leftNumber - rightNumber)
                || (left.vehicle?.position || 9999) - (right.vehicle?.position || 9999)
                || String(left.vehicle?.evn || left.vehicle?.vehicleNumber || "").localeCompare(String(right.vehicle?.evn || right.vehicle?.vehicleNumber || ""));
        };
    }

    function orderVehicleItemsForStop(items) {
        const groups = [];
        const byUnit = new Map();

        items.forEach((item, index) => {
            const key = item.unitKey || `single:${index}`;
            if (!byUnit.has(key)) {
                const range = itemSectorRange(item);
                const group = {
                    key,
                    firstIndex: index,
                    minSector: range.min,
                    maxSector: range.max,
                    unitSort: itemUnitSortValue(item),
                    items: []
                };
                byUnit.set(key, group);
                groups.push(group);
            }

            const group = byUnit.get(key);
            const range = itemSectorRange(item);
            group.minSector = Math.min(group.minSector, range.min);
            group.maxSector = Math.max(group.maxSector, range.max);
            group.items.push(item);
        });

        return groups
            .sort((left, right) => left.minSector - right.minSector
                || left.maxSector - right.maxSector
                || left.unitSort - right.unitSort
                || left.firstIndex - right.firstIndex)
            .flatMap((group) => group.items.slice().sort(compareItemsWithinUnit(directionForUnit(group.items))))
            .map((item, index) => ({ ...item, displayPosition: index + 1 }));
    }

    function buildVehicleItems(stop, vehicles, stops = []) {
        const orderedVehicles = vehiclesForFormation(vehicles);
        const coaches = parseFormationShortString(stop?.formationShortString);

        if (orderedVehicles.length) {
            const coachQueues = coachQueuesByNumber(coaches);
            const items = orderedVehicles.map((vehicle) => {
                const coach = takeCoachForVehicle(vehicle, coachQueues);
                const selectedSector = sectorForVehicle(vehicle, stop);
                const status = activeVehicleStatus(vehicle, stop, stops);
                return {
                    vehicle,
                    coach,
                    selectedStop: stop,
                    selectedSector,
                    status,
                    sector: vehicleSector(vehicle, coach, stop, selectedSector),
                    unitKey: unitKeyForVehicle(vehicle)
                };
            });
            return orderVehicleItemsForStop(items);
        }

        return coaches.map((coach, index) => ({
            vehicle: null,
            coach,
            selectedStop: stop,
            selectedSector: null,
            status: null,
            sector: canonicalSector(coach?.sector || "TRAIN") || "TRAIN",
            unitKey: unitKeyForCoach(coach),
            fallbackIndex: index,
            displayPosition: index + 1
        }));
    }

    function vehiclesInDisplayOrder(stop, vehicles, stops = []) {
        const seen = new Set();
        return buildVehicleItems(stop, vehicles, stops)
            .map((item) => item.vehicle)
            .filter((vehicle) => {
                if (!vehicle) return false;
                const key = vehicleUniqueKey(vehicle);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function vehicleItemsInDisplayOrder(stop, vehicles, stops = []) {
        const seen = new Set();
        return buildVehicleItems(stop, vehicles, stops)
            .filter((item) => {
                if (!item.vehicle) return false;
                const key = vehicleUniqueKey(item.vehicle);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map((item, index) => ({ ...item, displayPosition: index + 1 }));
    }

    function buildSectorGroups(items) {
        const groups = [];
        items.forEach((item, index) => {
            const key = canonicalSector(item.sector || "TRAIN") || "TRAIN";
            const last = groups[groups.length - 1];
            if (last && last.key === key) {
                last.length += 1;
            } else {
                groups.push({ key, start: index + 1, length: 1 });
            }
        });
        return groups;
    }

    function vehicleSeries(vehicle, coach = null) {
        const raw = String(vehicle?.typeCodeName || vehicle?.typeCode || coach?.classCode || "");
        const match = raw.match(/\((\d{3})\)/);
        return match ? match[1] : "";
    }

    function vehicleTypeCodeName(vehicle, coach = null) {
        return String(vehicle?.typeCodeName || vehicle?.typeCode || coach?.classCode || "");
    }

    function typeCodeBase(value) {
        return String(value || "")
            .replace(/\([^)]*\)/g, "")
            .replace(/-TI\b/i, "")
            .replace(/\d+$/g, "");
    }

    function describeVehicleType(vehicle, coach = null) {
        const raw = vehicleTypeCodeName(vehicle, coach);
        if (!raw) return "";

        const base = typeCodeBase(raw);
        const baseUpper = base.toUpperCase();
        const parts = [];
        if (baseUpper.startsWith("WR")) parts.push(tr("swiss_type_restaurant_area", "Restaurant"));
        else if (baseUpper.startsWith("AB")) parts.push(tr("swiss_mixed_class", "Mixed 1st and 2nd class"));
        else if (baseUpper.startsWith("A")) parts.push(tr("swiss_type_first_area", "1st class"));
        else if (baseUpper.startsWith("B")) parts.push(tr("swiss_type_second_area", "2nd class"));

        const series = vehicleSeries(vehicle, coach);
        if (series === "501") parts.push(tr("swiss_type_giruno", "RABe 501 Giruno"));
        else if (series === "610") parts.push(tr("swiss_type_etr610_short", "ETR 610"));

        return mergeUniqueBy(parts.filter(Boolean), (part) => part).join(" · ");
    }

    function unitKeyForVehicle(vehicle) {
        const series = vehicleSeries(vehicle);
        const number = Number(vehicle?.number || 0);
        if (series === "610" && number) return `${series}:${number >= 10 ? Math.ceil(number / 10) : 1}`;
        if (series === "501" && number) return `${series}:${Math.max(1, Math.ceil(number / 20))}`;
        return "";
    }

    function unitKeyForCoach(coach) {
        const series = vehicleSeries(null, coach);
        const number = Number(coach?.number || 0);
        if (series === "610" && number) return `${series}:${number >= 10 ? Math.ceil(number / 10) : 1}`;
        if (series === "501" && number) return `${series}:${Math.max(1, Math.ceil(number / 20))}`;
        return "";
    }

    function vehicleUnitSortValue(vehicle) {
        const key = unitKeyForVehicle(vehicle);
        if (!key) return 0;
        const [, group] = key.split(":");
        const parsed = Number.parseInt(group, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function unitLabel(key) {
        const [series, group] = String(key || "").split(":");
        if (!series || !group) return "";
        const trainType = series === "501"
            ? tr("swiss_type_giruno", "RABe 501 Giruno")
            : series === "610"
                ? tr("swiss_type_astoro", "ETR 610 / RABe 503 Astoro")
                : series;
        return `${tr("swiss_unit", "Unit")} ${group} · ${trainType}`;
    }

    function buildUnitGroups(items) {
        const groups = [];
        items.forEach((item, index) => {
            const key = item.unitKey || "";
            if (!key) return;
            const last = groups[groups.length - 1];
            if (last && last.key === key && last.start + last.length === index + 1) {
                last.length += 1;
            } else {
                groups.push({ key, start: index + 1, length: 1 });
            }
        });
        return groups.length > 1 ? groups : [];
    }

    function renderCoachCard(item, index) {
        const { coach, vehicle, selectedSector, status } = item;
        const number = vehicleDisplayNumber(vehicle, coach);
        const classLabel = vehicleClassLabel(vehicle, coach);
        const type = vehicleTypeCodeName(vehicle, coach);
        const typeDescription = describeVehicleType(vehicle, coach);
        const closed = vehicleIsClosedForDisplay(status, coach);
        const isLoco = isLikelyLocomotive(vehicle) || coachTokenLooksLikeLoco(coach);
        const roleClass = isLoco ? " swiss-coach-loco" : "";

        return `
            <div class="swiss-coach${closed ? " swiss-coach-closed" : ""}${roleClass}" style="grid-column:${index + 1};grid-row:2;"${typeDescription ? ` title="${esc(typeDescription)}"` : ""}>
                <div class="swiss-coach-head">
                    <span class="swiss-coach-caption">${esc(isLoco ? tr("swiss_loco", "Loco") : tr("swiss_vehicle", "Vehicle"))}</span>
                    <span class="swiss-coach-class">${esc(classLabel)}</span>
                </div>
                <div class="swiss-coach-number">${esc(number)}</div>
                ${type ? `<div class="swiss-coach-type">${esc(type)}</div>` : ""}
                ${typeDescription ? `<div class="swiss-coach-type-note">${esc(typeDescription)}</div>` : ""}
                <div class="swiss-coach-icons">${renderFeatureIcons(coach, vehicle, selectedSector, index, status)}</div>
            </div>
        `;
    }

    function addLegendEntry(map, id, label, icon = "", badge = "") {
        if (!map.has(id)) map.set(id, { id, label, icon, badge });
    }

    const LEGEND_ORDER = [
        "class_1",
        "class_2",
        "class_12",
        "restaurant",
        "low_floor",
        "wheelchair",
        "wheelchair_wc",
        "bike",
        "stroller",
        "family",
        "business",
        "climated",
        "no_passage",
        "closed",
        "emergency",
        "loco"
    ];

    function renderCoachLegend(items) {
        const legend = new Map();
        items.forEach((item, index) => {
            const classLabel = vehicleClassLabel(item.vehicle, item.coach);
            if (classLabel === "1") addLegendEntry(legend, "class_1", tr("swiss_first_class", "1st class"), "", "1");
            else if (classLabel === "2") addLegendEntry(legend, "class_2", tr("swiss_second_class", "2nd class"), "", "2");
            else if (classLabel === "1/2") addLegendEntry(legend, "class_12", tr("swiss_mixed_class", "Mixed 1st and 2nd class"), "", "1/2");
            if (isLikelyLocomotive(item.vehicle) || coachTokenLooksLikeLoco(item.coach)) {
                addLegendEntry(legend, "loco", tr("swiss_loco", "Loco"), "train");
            }
            featureEntries(item.coach, item.vehicle, item.selectedSector, index, item.status).forEach((entry) => {
                addLegendEntry(legend, entry.id, entry.label, entry.icon);
            });
        });

        if (!legend.size) return "";
        const entries = Array.from(legend.values())
            .sort((left, right) => {
                const leftIndex = LEGEND_ORDER.includes(left.id) ? LEGEND_ORDER.indexOf(left.id) : LEGEND_ORDER.length;
                const rightIndex = LEGEND_ORDER.includes(right.id) ? LEGEND_ORDER.indexOf(right.id) : LEGEND_ORDER.length;
                return leftIndex - rightIndex;
            })
            .map((entry) => `
            <div class="swiss-legend-item">
                ${entry.badge
                    ? `<span class="swiss-legend-badge">${esc(entry.badge)}</span>`
                    : `<span class="material-symbols-outlined">${esc(entry.icon)}</span>`}
                <span>${esc(entry.label)}</span>
            </div>
        `).join("");

        return `
            <div class="swiss-legend">
                <div class="swiss-legend-title">${esc(tr("swiss_legend", "Legend"))}</div>
                <div class="swiss-legend-grid">${entries}</div>
            </div>
        `;
    }

    function renderCoachStrip(stop, vehicles, stops = []) {
        const items = buildVehicleItems(stop, vehicles, stops);
        if (!items.length) {
            return `<div class="swiss-empty">${esc(tr("swiss_no_coaches", "No coach layout available"))}</div>`;
        }

        const groups = buildSectorGroups(items).map((group) => `
            <div class="swiss-sector-segment" style="grid-column:${group.start} / span ${group.length};grid-row:1;">
                ${esc(sectorLabel(group.key))}
            </div>
        `).join("");
        const unitGroups = buildUnitGroups(items).map((group) => `
            <div class="swiss-unit-segment" style="grid-column:${group.start} / span ${group.length};grid-row:3;">
                ${esc(unitLabel(group.key))}
            </div>
        `).join("");

        return `
            <div class="swiss-formation-track" style="--vehicle-count:${items.length}">
                ${groups}
                ${items.map(renderCoachCard).join("")}
                ${unitGroups}
            </div>
            ${renderCoachLegend(items)}
        `;
    }

    function renderVehicleChips(vehicle, selectedSector, index, status = null) {
        const chips = [];
        chips.push(`${esc(tr("swiss_first_class", "1st"))}: ${vehicle.firstClassSeats || 0}`);
        chips.push(`${esc(tr("swiss_second_class", "2nd"))}: ${vehicle.secondClassSeats || 0}`);
        if (vehicle.bikeHooks) chips.push(`${esc(tr("swiss_bike", "Bike"))}: ${vehicle.bikeHooks}`);
        if (vehicle.bikePlatform) chips.push(esc(tr("swiss_bike_platform", "Bike platform")));
        if (vehicle.lowFloor) chips.push(esc(tr("swiss_low_floor", "Low floor")));
        if (vehicle.wheelchairSpaces) chips.push(`${esc(tr("swiss_wheelchair", "Wheelchair"))}: ${vehicle.wheelchairSpaces}`);
        if (vehicle.wheelchairToilet) chips.push(`${esc(tr("swiss_wheelchair", "Wheelchair"))} WC`);
        if (vehicle.wheelchairAccessibleRestaurant) chips.push(`${esc(tr("swiss_wheelchair", "Wheelchair"))} ${esc(tr("swiss_restaurant", "Restaurant"))}`);
        if (vehicle.disabledCompartment) chips.push(esc(tr("swiss_disabled_compartment", "Disabled compartment")));
        if (vehicle.numberRestaurantSpace) chips.push(`${esc(tr("swiss_restaurant", "Restaurant"))}: ${vehicle.numberRestaurantSpace}`);
        if (vehicle.numberBeds) chips.push(`${esc(tr("swiss_beds", "Beds"))}: ${vehicle.numberBeds}`);
        if (vehicle.familyZonePicto) chips.push(esc(tr("swiss_family", "Family")));
        if (vehicle.businessZonePicto) chips.push(esc(tr("swiss_business", "Business")));
        if (vehicle.strollerPicto) chips.push(esc(tr("swiss_stroller", "Stroller")));
        if (vehicle.climated) chips.push(esc(tr("swiss_climated", "Air-conditioned")));
        if (vehicle.emergencyCallSystem) chips.push(esc(tr("swiss_emergency_call", "Emergency call")));
        if (status?.closed) chips.push(esc(tr("swiss_closed", "Closed")));
        if (status?.vehicleWillBePutAway) chips.push(esc(tr("swiss_put_away", "Put away")));
        const statusLabel = trolleyStatusLabel(status?.trolleyStatus);
        if (statusLabel) chips.push(esc(statusLabel));
        if (shouldShowNoPassage(selectedSector, index)) chips.push(esc(tr("swiss_no_passage", "No passage")));
        if (selectedSector?.sectors) chips.push(`${esc(tr("swiss_sector", "Sector"))}: ${esc(selectedSector.sectors)}`);
        if (selectedSector?.track) chips.push(`${esc(tr("swiss_track", "Track"))}: ${esc(selectedSector.track)}`);
        if (vehicle.length) chips.push(`${esc(tr("swiss_length", "Length"))}: ${esc(vehicle.length)} m`);
        return chips.map((chip) => `<span class="swiss-vehicle-chip">${chip}</span>`).join("");
    }

    function renderVehicleDiagnostics(vehicle) {
        const parts = [];
        if (vehicle.evn) parts.push(`${tr("swiss_evn", "EVN")}: ${vehicle.evn}`);
        if (vehicle.parentEvn) parts.push(`${tr("swiss_parent_evn", "Parent EVN")}: ${vehicle.parentEvn}`);
        if (vehicle.typeCode) parts.push(`${tr("swiss_type_code", "Type code")}: ${vehicle.typeCode}`);
        if (vehicle.buildTypeCode || vehicle.countryCode || vehicle.vehicleNumber || vehicle.checkNumber) {
            parts.push(`${tr("swiss_vehicle_number", "Vehicle no.")}: ${[vehicle.buildTypeCode, vehicle.countryCode, vehicle.vehicleNumber, vehicle.checkNumber].filter(Boolean).join(" ")}`);
        }
        return parts.length
            ? `<div class="swiss-vehicle-diagnostics">${parts.map(esc).join(" - ")}</div>`
            : "";
    }

    function renderVehicleSegments(vehicle) {
        const segments = asArray(vehicle.segments).length
            ? vehicle.segments
            : (vehicle.fromStop || vehicle.toStop ? [{ fromStop: vehicle.fromStop, toStop: vehicle.toStop }] : []);
        const labels = segments
            .map((segment) => `${esc(segment.fromStop || "--")} -> ${esc(segment.toStop || "--")}`)
            .filter(Boolean);
        return labels.length ? labels.join("; ") : "";
    }

    function renderVehicleDetails(data, selectedStop) {
        const items = vehicleItemsInDisplayOrder(selectedStop, data?.vehicles, data?.stops);
        if (!items.length) {
            return `<div class="swiss-empty">${esc(tr("swiss_unavailable", "Swiss data unavailable"))}</div>`;
        }

        return items.map((item, index) => {
            const vehicle = item.vehicle;
            const selectedSector = item.selectedSector || sectorForVehicle(vehicle, selectedStop);
            const status = item.status || activeVehicleStatus(vehicle, selectedStop, data?.stops);
            const fromTo = renderVehicleSegments(vehicle);
            const label = isLikelyLocomotive(vehicle) ? tr("swiss_loco", "Loco") : tr("swiss_vehicle", "Vehicle");
            const typeDescription = describeVehicleType(vehicle);
            return `
                <div class="swiss-vehicle-row${vehicleIsClosedForDisplay(status, null) ? " swiss-vehicle-closed" : ""}">
                    <div class="swiss-vehicle-main">
                        <div class="swiss-vehicle-title">
                            <span class="swiss-vehicle-position">${esc(tr("swiss_position", "Pos."))} ${item.displayPosition || index + 1}</span>
                            <span>${esc(label)} ${esc(vehicle.number || vehicle.vehicleNumber || "--")}</span>
                            <span class="swiss-vehicle-type">${esc(vehicle.typeCodeName || vehicle.typeCode || "--")}</span>
                        </div>
                        ${typeDescription ? `<div class="swiss-vehicle-type-note">${esc(typeDescription)}</div>` : ""}
                        ${fromTo ? `<div class="swiss-vehicle-route">${esc(tr("swiss_from_to", "From/To"))}: ${fromTo}</div>` : ""}
                    </div>
                    <div class="swiss-vehicle-chips">${renderVehicleChips(vehicle, selectedSector, index, status)}</div>
                    ${renderVehicleDiagnostics(vehicle)}
                </div>
            `;
        }).join("");
    }

    function runStatusLabel(runs) {
        if (runs === "J") return tr("swiss_runs_J", "Runs");
        if (runs === "N") return tr("swiss_runs_N", "Does not run");
        if (runs === "T") return tr("swiss_runs_T", "Partially operated");
        if (runs === "L") return tr("swiss_runs_L", "Deleted");
        return runs || "--";
    }

    function hideFormationCard() {
        const card = document.getElementById("swissFormationCard");
        if (card) {
            card.style.display = "none";
            card.innerHTML = "";
        }
    }

    function renderLoadingCard() {
        const card = document.getElementById("swissFormationCard");
        if (!card) return;
        card.innerHTML = `<div class="swiss-loading"><span class="loading loading-spinner loading-sm text-primary"></span><span>${esc(tr("swiss_loading", "Loading train formation..."))}</span></div>`;
        card.style.display = "block";
    }

    function renderFormationCard(data) {
        const card = document.getElementById("swissFormationCard");
        if (!card) return;

        if (!data?.available) {
            hideFormationCard();
            return;
        }

        const stops = asArray(data.stops);
        if (!stops.length && !asArray(data.vehicles).length) {
            hideFormationCard();
            return;
        }

        let selectedIndex = Number.parseInt(card.dataset.swissSelectedStop || "", 10);
        if (!Number.isFinite(selectedIndex) || selectedIndex < 0 || selectedIndex >= stops.length) {
            const withFormation = stops.findIndex((stop) => stop.formationShortString);
            selectedIndex = withFormation >= 0 ? withFormation : 0;
        }
        const selectedStop = stops[selectedIndex] || stops[0] || null;
        const wasCollapsed = card.querySelector(".swiss-body-wrap")?.classList.contains("swiss-collapsed") || false;
        const formationKey = `${data.trainNumber || ""}|${data.operationDate || ""}`;
        if (card.dataset.swissFormationKey !== formationKey) {
            card.dataset.swissFormationKey = formationKey;
            card.dataset.swissVehiclesExpanded = "false";
        }
        const vehiclesExpanded = card.dataset.swissVehiclesExpanded === "true";
        const terminalName = stops.length ? (stops[stops.length - 1]?.name || "") : "";
        const orderedVehicles = vehiclesInDisplayOrder(selectedStop, data?.vehicles, stops);
        const vehicleCount = Number(orderedVehicles.length || data.vehicleCount || 0);

        const stopTabs = stops.map((stop, index) => `
            <button type="button" class="swiss-stop-tab${index === selectedIndex ? " active" : ""}" data-swiss-stop-index="${index}">
                <span>${esc(stop.name || "--")}</span>
                <small>${esc(formatZurichTime(stop.departureTime || stop.arrivalTime))}${stop.track ? ` - ${esc(tr("swiss_track", "Track"))} ${esc(stop.track)}` : ""}</small>
            </button>
        `).join("");

        card.innerHTML = `
            <div class="swiss-header">
                <div class="swiss-title">
                    <span class="material-symbols-outlined">view_carousel</span>
                    <span>${esc(tr("swiss_title", "Train formation"))}</span>
                </div>
                <div class="swiss-header-actions">
                    <div class="swiss-provider">${esc(tr("swiss_source", "CH"))}</div>
                    <button type="button" class="swiss-toggle" aria-label="Toggle formation">
                        <span class="material-symbols-outlined${wasCollapsed ? "" : " swiss-rotated"}">expand_more</span>
                    </button>
                </div>
            </div>
            <div class="swiss-collapse-source${wasCollapsed ? "" : " hidden"}">${esc(tr("swiss_data_source", "Data from opentransportdata.swiss."))}</div>
            <div class="swiss-body-wrap${wasCollapsed ? " swiss-collapsed" : ""}">
                <div class="swiss-body">
                    <div class="swiss-meta">
                        <span><span class="material-symbols-outlined">update</span>${esc(tr("swiss_updated", "Updated"))}: ${esc(formatZurichDateTime(data.lastUpdate))}</span>
                        <span><span class="material-symbols-outlined">route</span>${esc(tr("swiss_run_status", "Run status"))}: ${esc(runStatusLabel(data.runs))}</span>
                        ${vehicleCount ? `<span><span class="material-symbols-outlined">train</span>${esc(tr("swiss_vehicle_count", "Vehicles"))}: ${esc(vehicleCount)}</span>` : ""}
                        ${terminalName ? `<span class="swiss-direction"><span class="material-symbols-outlined">trending_flat</span>${esc(terminalName)}</span>` : ""}
                    </div>
                    ${stops.length ? `<div class="swiss-stop-tabs">${stopTabs}</div>` : ""}
                    <div class="swiss-section">
                        <div class="swiss-section-title">${esc(tr("swiss_coach", "Coach"))} ${selectedStop?.track ? `<span>${esc(tr("swiss_track", "Track"))} ${esc(selectedStop.track)}</span>` : ""}</div>
                        <div class="swiss-coach-strip">${renderCoachStrip(selectedStop, asArray(data.vehicles), stops)}</div>
                    </div>
                    <div class="swiss-section">
                        <button type="button" class="swiss-section-title swiss-vehicles-toggle" aria-expanded="${vehiclesExpanded ? "true" : "false"}">
                            <span>${esc(tr("swiss_vehicle_details_info", "Vehicle Details Info"))}</span>
                            <span class="material-symbols-outlined${vehiclesExpanded ? " swiss-rotated" : ""}">expand_more</span>
                        </button>
                        <div class="swiss-vehicle-list-wrap${vehiclesExpanded ? "" : " swiss-vehicles-collapsed"}">
                            <div class="swiss-vehicle-list">${renderVehicleDetails(data, selectedStop)}</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        card.dataset.swissSelectedStop = String(selectedIndex);
        card.style.display = "block";
        card.querySelector(".swiss-toggle")?.addEventListener("click", () => {
            const body = card.querySelector(".swiss-body-wrap");
            const icon = card.querySelector(".swiss-toggle .material-symbols-outlined");
            const source = card.querySelector(".swiss-collapse-source");
            body?.classList.toggle("swiss-collapsed");
            icon?.classList.toggle("swiss-rotated");
            source?.classList.toggle("hidden", !body?.classList.contains("swiss-collapsed"));
        });
        card.querySelector(".swiss-vehicles-toggle")?.addEventListener("click", () => {
            const wrap = card.querySelector(".swiss-vehicle-list-wrap");
            const button = card.querySelector(".swiss-vehicles-toggle");
            const icon = card.querySelector(".swiss-vehicles-toggle .material-symbols-outlined");
            const expanded = wrap?.classList.toggle("swiss-vehicles-collapsed") === false;
            card.dataset.swissVehiclesExpanded = expanded ? "true" : "false";
            button?.setAttribute("aria-expanded", expanded ? "true" : "false");
            icon?.classList.toggle("swiss-rotated", expanded);
        });
        card.querySelectorAll(".swiss-stop-tab").forEach((button) => {
            button.addEventListener("click", () => {
                card.dataset.swissSelectedStop = button.dataset.swissStopIndex;
                renderFormationCard(data);
            });
        });
    }

    window.BelloSwiss = {
        fetchSwissByTrainNumber,
        fetchSwissEc,
        getCategory,
        getOperationDate,
        getTodayInZurich,
        getTrainNumber,
        hasSwissHint,
        hideFormationCard,
        isSwissBoundaryName,
        isTechnicalSwissStop,
        mergeTimelineStops,
        normalizeStationName,
        renderFormationCard,
        renderLoadingCard,
        shouldQuery
    };
})();
