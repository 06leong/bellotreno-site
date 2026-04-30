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
                return exactMatches.find((item) => item.accessToPreviousVehicle === false) || exactMatches[0];
            }
        }
        return sectors[0];
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
            closed: existing.closed || incoming.closed,
            vehicleWillBePutAway: existing.vehicleWillBePutAway || incoming.vehicleWillBePutAway,
            fromStop: existing.fromStop || incoming.fromStop,
            toStop: existing.toStop || incoming.toStop,
            segments: mergeUniqueBy([...(existing.segments || []), ...(incoming.segments || [])], (segment) => `${segment.fromStop || ""}|${segment.toStop || ""}`),
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
        return Array.from(map.values()).sort((a, b) => (a.position || 9999) - (b.position || 9999));
    }

    function sectorSortKey(sector) {
        const value = String(sector || "TRAIN").toUpperCase();
        if (!value || value === "TRAIN") return "ZZZ";
        return value.split(/[,\s;]+/).filter(Boolean).join("");
    }

    function compareVehiclesByStopSector(selectedStop) {
        return (left, right) => {
            const leftSector = sectorSortKey(sectorForVehicle(left, selectedStop)?.sectors);
            const rightSector = sectorSortKey(sectorForVehicle(right, selectedStop)?.sectors);
            if (leftSector !== rightSector) return leftSector.localeCompare(rightSector);
            return (left.position || 9999) - (right.position || 9999)
                || (left.number || 9999) - (right.number || 9999);
        };
    }

    function vehiclesForStopFallback(vehicles, selectedStop) {
        return allVehicles(vehicles).slice().sort(compareVehiclesByStopSector(selectedStop));
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

    function takeVehicleForCoach(coach, vehicles, usedIndexes, fallbackIndex) {
        if (coach?.number) {
            const exactIndex = vehicles.findIndex((vehicle, index) => !usedIndexes.has(index) && vehicle.number === coach.number);
            if (exactIndex >= 0) {
                usedIndexes.add(exactIndex);
                return vehicles[exactIndex];
            }
        }

        if (fallbackIndex < vehicles.length && !usedIndexes.has(fallbackIndex)) {
            usedIndexes.add(fallbackIndex);
            return vehicles[fallbackIndex];
        }

        const nextIndex = vehicles.findIndex((_, index) => !usedIndexes.has(index));
        if (nextIndex >= 0) {
            usedIndexes.add(nextIndex);
            return vehicles[nextIndex];
        }

        return null;
    }

    function shouldShowNoPassage(selectedSector, index) {
        return index > 0 && selectedSector?.accessToPreviousVehicle === false;
    }

    function featureEntries(coach, vehicle, selectedSector, index = 0) {
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
        if (vehicle?.closed || (!vehicle && coach?.closed) || vehicle?.vehicleWillBePutAway) entries.push({ id: "closed", icon: "block", label: tr("swiss_closed", "Closed") });
        return entries;
    }

    function renderFeatureIcons(coach, vehicle, selectedSector, index) {
        return featureEntries(coach, vehicle, selectedSector, index)
            .map((entry) => `<span class="material-symbols-outlined" title="${esc(entry.label)}">${esc(entry.icon)}</span>`)
            .join("");
    }

    function sectorLabel(sector) {
        if (!sector || sector === "TRAIN") return tr("swiss_train_segment", "Train");
        return `${tr("swiss_sector", "Sector")} ${sector}`;
    }

    function vehicleSector(vehicle, coach, selectedStop) {
        const selectedSector = sectorForVehicle(vehicle, selectedStop);
        return selectedSector?.sectors || coach?.sector || "TRAIN";
    }

    function buildVehicleItems(stop, vehicles) {
        const orderedVehicles = vehiclesForStopFallback(vehicles, stop);
        const coaches = parseFormationShortString(stop?.formationShortString);

        if (coaches.length) {
            const usedVehicleIndexes = new Set();
            const items = coaches.map((coach, index) => {
                const vehicle = takeVehicleForCoach(coach, orderedVehicles, usedVehicleIndexes, index);
                const selectedSector = sectorForVehicle(vehicle, stop);
                return {
                    vehicle,
                    coach,
                    selectedStop: stop,
                    selectedSector,
                    sector: coach?.sector || selectedSector?.sectors || "TRAIN"
                };
            });

            orderedVehicles.forEach((vehicle, index) => {
                if (usedVehicleIndexes.has(index)) return;
                const selectedSector = sectorForVehicle(vehicle, stop);
                items.push({
                    vehicle,
                    coach: null,
                    selectedStop: stop,
                    selectedSector,
                    sector: selectedSector?.sectors || "TRAIN"
                });
            });

            return items;
        }

        if (orderedVehicles.length) {
            return orderedVehicles.map((vehicle) => {
                const selectedSector = sectorForVehicle(vehicle, stop);
                return {
                    vehicle,
                    coach: null,
                    selectedStop: stop,
                    selectedSector,
                    sector: vehicleSector(vehicle, null, stop)
                };
            });
        }

        return coaches.map((coach, index) => ({
            vehicle: null,
            coach,
            selectedStop: stop,
            selectedSector: null,
            sector: coach?.sector || "TRAIN",
            fallbackIndex: index
        }));
    }

    function vehiclesInDisplayOrder(stop, vehicles) {
        const seen = new Set();
        return buildVehicleItems(stop, vehicles)
            .map((item) => item.vehicle)
            .filter((vehicle) => {
                if (!vehicle) return false;
                const key = vehicleUniqueKey(vehicle);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function buildSectorGroups(items) {
        const groups = [];
        items.forEach((item, index) => {
            const key = item.sector || "TRAIN";
            const last = groups[groups.length - 1];
            if (last && last.key === key) {
                last.length += 1;
            } else {
                groups.push({ key, start: index + 1, length: 1 });
            }
        });
        return groups;
    }

    function renderCoachCard(item, index) {
        const { coach, vehicle, selectedSector } = item;
        const number = vehicleDisplayNumber(vehicle, coach);
        const classLabel = vehicleClassLabel(vehicle, coach);
        const type = vehicle?.typeCodeName || vehicle?.typeCode || coach?.classCode || "";
        const closed = vehicle ? (vehicle.closed || vehicle.vehicleWillBePutAway) : coach?.closed;
        const isLoco = isLikelyLocomotive(vehicle) || coachTokenLooksLikeLoco(coach);
        const roleClass = isLoco ? " swiss-coach-loco" : "";

        return `
            <div class="swiss-coach${closed ? " swiss-coach-closed" : ""}${roleClass}" style="grid-column:${index + 1};grid-row:2;">
                <div class="swiss-coach-head">
                    <span class="swiss-coach-caption">${esc(isLoco ? tr("swiss_loco", "Loco") : tr("swiss_vehicle", "Vehicle"))}</span>
                    <span class="swiss-coach-class">${esc(classLabel)}</span>
                </div>
                <div class="swiss-coach-number">${esc(number)}</div>
                ${type ? `<div class="swiss-coach-type">${esc(type)}</div>` : ""}
                <div class="swiss-coach-icons">${renderFeatureIcons(coach, vehicle, selectedSector, index)}</div>
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
            featureEntries(item.coach, item.vehicle, item.selectedSector, index).forEach((entry) => {
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

    function renderCoachStrip(stop, vehicles) {
        const items = buildVehicleItems(stop, vehicles);
        if (!items.length) {
            return `<div class="swiss-empty">${esc(tr("swiss_no_coaches", "No coach layout available"))}</div>`;
        }

        const groups = buildSectorGroups(items).map((group) => `
            <div class="swiss-sector-segment" style="grid-column:${group.start} / span ${group.length};grid-row:1;">
                ${esc(sectorLabel(group.key))}
            </div>
        `).join("");

        return `
            <div class="swiss-formation-track" style="--vehicle-count:${items.length}">
                ${groups}
                ${items.map(renderCoachCard).join("")}
            </div>
            ${renderCoachLegend(items)}
        `;
    }

    function renderVehicleChips(vehicle, selectedSector, index) {
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
        if (vehicle.closed) chips.push(esc(tr("swiss_closed", "Closed")));
        if (vehicle.vehicleWillBePutAway) chips.push(esc(tr("swiss_put_away", "Put away")));
        if (vehicle.trolleyStatus && vehicle.trolleyStatus !== "Normal") chips.push(esc(vehicle.trolleyStatus));
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
        const vehicles = vehiclesInDisplayOrder(selectedStop, data?.vehicles);
        if (!vehicles.length) {
            return `<div class="swiss-empty">${esc(tr("swiss_unavailable", "Swiss data unavailable"))}</div>`;
        }

        return vehicles.map((vehicle, index) => {
            const selectedSector = sectorForVehicle(vehicle, selectedStop);
            const fromTo = renderVehicleSegments(vehicle);
            const label = isLikelyLocomotive(vehicle) ? tr("swiss_loco", "Loco") : tr("swiss_vehicle", "Vehicle");
            return `
                <div class="swiss-vehicle-row${vehicle.closed || vehicle.vehicleWillBePutAway ? " swiss-vehicle-closed" : ""}">
                    <div class="swiss-vehicle-main">
                        <div class="swiss-vehicle-title">
                            <span class="swiss-vehicle-position">${esc(tr("swiss_position", "Pos."))} ${vehicle.position || "--"}</span>
                            <span>${esc(label)} ${esc(vehicle.number || vehicle.vehicleNumber || "--")}</span>
                            <span class="swiss-vehicle-type">${esc(vehicle.typeCodeName || vehicle.typeCode || "--")}</span>
                        </div>
                        ${fromTo ? `<div class="swiss-vehicle-route">${esc(tr("swiss_from_to", "From/To"))}: ${fromTo}</div>` : ""}
                    </div>
                    <div class="swiss-vehicle-chips">${renderVehicleChips(vehicle, selectedSector, index)}</div>
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
        const terminalName = stops.length ? (stops[stops.length - 1]?.name || "") : "";
        const vehicleCount = Number(data.vehicleCount || allVehicles(data.vehicles).length || 0);

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
                        <div class="swiss-coach-strip">${renderCoachStrip(selectedStop, asArray(data.vehicles))}</div>
                    </div>
                    <div class="swiss-section">
                        <div class="swiss-section-title">${esc(tr("swiss_vehicles", "Vehicles"))}</div>
                        <div class="swiss-vehicle-list">${renderVehicleDetails(data, selectedStop)}</div>
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
