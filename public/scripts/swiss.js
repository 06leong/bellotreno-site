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
        if (!hasMatch) return sourceStops;

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

        const hiddenType = main.toUpperCase().replace(/:.*$/, "");
        if (["F", "X", "LK"].includes(hiddenType)) return null;

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

    function findVehicleForCoach(coach, vehicles, fallbackIndex) {
        if (coach.number) {
            const byNumber = vehicles.find((vehicle) => vehicle.number === coach.number);
            if (byNumber) return byNumber;
        }
        return vehicles[fallbackIndex] || null;
    }

    function sectorForVehicle(vehicle, selectedStop) {
        const sectors = asArray(vehicle?.stopSectors);
        if (!sectors.length) return null;
        if (selectedStop?.uic) {
            const exact = sectors.find((item) => item.uic === selectedStop.uic);
            if (exact) return exact;
        }
        return sectors[0];
    }

    function renderServiceIcons(coach, vehicle) {
        const services = new Set(asArray(coach?.services));
        const icons = [];
        if (vehicle?.bikeHooks || services.has("VH") || services.has("VR")) icons.push(["directions_bike", tr("swiss_bike", "Bike")]);
        if (vehicle?.lowFloor || services.has("NF")) icons.push(["accessible_forward", tr("swiss_low_floor", "Low floor")]);
        if (vehicle?.wheelchairSpaces || services.has("BHP")) icons.push(["accessible", tr("swiss_wheelchair", "Wheelchair")]);
        if (services.has("KW")) icons.push(["child_friendly", "Stroller"]);
        if (String(coach?.classCode || "").startsWith("W")) icons.push(["restaurant", "Restaurant"]);

        return icons.map(([icon, label]) => `<span class="material-symbols-outlined" title="${esc(label)}">${icon}</span>`).join("");
    }

    function passengerVehicles(vehicles) {
        return asArray(vehicles).filter((vehicle) => (
            vehicle?.number
            || vehicle?.firstClassSeats
            || vehicle?.secondClassSeats
            || vehicle?.bikeHooks
            || vehicle?.wheelchairSpaces
        ));
    }

    function vehicleClassLabel(vehicle) {
        const first = Number(vehicle?.firstClassSeats || 0);
        const second = Number(vehicle?.secondClassSeats || 0);
        if (first > 0 && second > 0) return "1/2";
        if (first > 0) return "1";
        if (second > 0) return "2";
        return "?";
    }

    function renderCoachFeatureIcons(coach, vehicle) {
        const services = new Set(asArray(coach?.services));
        const icons = [];
        if (vehicle?.lowFloor || services.has("NF")) icons.push(["accessible_forward", tr("swiss_low_floor", "Low floor")]);
        if (vehicle?.wheelchairSpaces || services.has("BHP")) icons.push(["accessible", tr("swiss_wheelchair", "Wheelchair")]);
        if (vehicle?.bikeHooks || services.has("VH") || services.has("VR")) icons.push(["directions_bike", tr("swiss_bike", "Bike")]);
        if (services.has("KW")) icons.push(["child_friendly", "Stroller"]);
        if (String(coach?.classCode || vehicle?.typeCodeName || "").toUpperCase().includes("WR")) icons.push(["restaurant", "Restaurant"]);
        return icons.map(([icon, label]) => `<span class="material-symbols-outlined" title="${esc(label)}">${icon}</span>`).join("");
    }

    function renderCoachCard({ coach, vehicle, selectedStop }) {
        const selectedSector = sectorForVehicle(vehicle, selectedStop);
        const number = coach?.number || vehicle?.number || "--";
        const classLabel = coach?.classLabel || vehicleClassLabel(vehicle);
        const type = vehicle?.typeCodeName || vehicle?.typeCode || coach?.classCode || "";
        const sector = coach?.sector || selectedSector?.sectors || "";
        const closed = coach?.closed || vehicle?.closed;

        return `
            <div class="swiss-coach${closed ? " swiss-coach-closed" : ""}">
                <div class="swiss-coach-head">
                    <span class="swiss-coach-caption">${esc(tr("swiss_coach", "Coach"))}</span>
                    <span class="swiss-coach-class">${esc(classLabel)}</span>
                </div>
                <div class="swiss-coach-number">${esc(number)}</div>
                ${type ? `<div class="swiss-coach-type">${esc(type)}</div>` : ""}
                ${sector ? `<div class="swiss-coach-sector">${esc(tr("swiss_sector", "Sector"))} ${esc(sector)}</div>` : ""}
                <div class="swiss-coach-icons">${renderCoachFeatureIcons(coach, vehicle)}</div>
            </div>
        `;
    }

    function renderVehicleCoachStrip(stop, vehicles) {
        const grouped = new Map();
        passengerVehicles(vehicles).forEach((vehicle) => {
            const selectedSector = sectorForVehicle(vehicle, stop);
            const sector = selectedSector?.sectors || "TRAIN";
            if (!grouped.has(sector)) grouped.set(sector, []);
            grouped.get(sector).push({ coach: { sector }, vehicle, selectedStop: stop });
        });

        if (!grouped.size) {
            return `<div class="swiss-empty">${esc(tr("swiss_no_coaches", "No coach layout available"))}</div>`;
        }

        return Array.from(grouped.entries()).map(([sector, items]) => `
            <div class="swiss-sector-group">
                <div class="swiss-sector-label">${sector === "TRAIN" ? esc(tr("swiss_coach", "Coach")) : `${esc(tr("swiss_sector", "Sector"))} ${esc(sector)}`}</div>
                <div class="swiss-coaches">
                    ${items.map(renderCoachCard).join("")}
                </div>
            </div>
        `).join("");
    }

    function renderCoachStrip(stop, vehicles) {
        const coaches = parseFormationShortString(stop?.formationShortString);
        if (!coaches.length) {
            return renderVehicleCoachStrip(stop, vehicles);
        }

        const visibleVehicles = passengerVehicles(vehicles);
        const grouped = new Map();
        coaches.forEach((coach, index) => {
            const vehicle = findVehicleForCoach(coach, visibleVehicles, index);
            if (!grouped.has(coach.sector)) grouped.set(coach.sector, []);
            grouped.get(coach.sector).push({ coach, vehicle, selectedStop: stop, index });
        });

        return Array.from(grouped.entries()).map(([sector, items]) => `
            <div class="swiss-sector-group">
                <div class="swiss-sector-label">${esc(tr("swiss_sector", "Sector"))} ${esc(sector)}</div>
                <div class="swiss-coaches">
                    ${items.map(renderCoachCard).join("")}
                </div>
            </div>
        `).join("");
    }

    function renderVehicleChips(vehicle, selectedSector) {
        const chips = [];
        chips.push(`${esc(tr("swiss_first_class", "1st"))}: ${vehicle.firstClassSeats || 0}`);
        chips.push(`${esc(tr("swiss_second_class", "2nd"))}: ${vehicle.secondClassSeats || 0}`);
        if (vehicle.bikeHooks) chips.push(`${esc(tr("swiss_bike", "Bike"))}: ${vehicle.bikeHooks}`);
        if (vehicle.lowFloor) chips.push(esc(tr("swiss_low_floor", "Low floor")));
        if (vehicle.wheelchairSpaces) chips.push(`${esc(tr("swiss_wheelchair", "Wheelchair"))}: ${vehicle.wheelchairSpaces}`);
        if (vehicle.wheelchairToilet) chips.push(`${esc(tr("swiss_wheelchair", "Wheelchair"))} WC`);
        if (vehicle.closed) chips.push(esc(tr("swiss_closed", "Closed")));
        if (selectedSector?.sectors) chips.push(`${esc(tr("swiss_sector", "Sector"))}: ${esc(selectedSector.sectors)}`);
        if (selectedSector?.track) chips.push(`${esc(tr("swiss_track", "Track"))}: ${esc(selectedSector.track)}`);
        return chips.map((chip) => `<span class="swiss-vehicle-chip">${chip}</span>`).join("");
    }

    function renderVehicleDetails(data, selectedStop) {
        const vehicles = asArray(data?.vehicles).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
        if (!vehicles.length) {
            return `<div class="swiss-empty">${esc(tr("swiss_unavailable", "Swiss data unavailable"))}</div>`;
        }

        return vehicles.map((vehicle) => {
            const selectedSector = sectorForVehicle(vehicle, selectedStop);
            const fromTo = vehicle.fromStop || vehicle.toStop
                ? `${esc(vehicle.fromStop || "--")} -> ${esc(vehicle.toStop || "--")}`
                : "";
            return `
                <div class="swiss-vehicle-row${vehicle.closed ? " swiss-vehicle-closed" : ""}">
                    <div class="swiss-vehicle-main">
                        <div class="swiss-vehicle-title">
                            <span class="swiss-vehicle-position">${esc(tr("swiss_position", "Pos."))} ${vehicle.position || "--"}</span>
                            <span>${esc(tr("swiss_coach", "Coach"))} ${vehicle.number || "--"}</span>
                            <span class="swiss-vehicle-type">${esc(vehicle.typeCodeName || vehicle.typeCode || "--")}</span>
                        </div>
                        ${fromTo ? `<div class="swiss-vehicle-route">${esc(tr("swiss_from_to", "From/To"))}: ${fromTo}</div>` : ""}
                    </div>
                    <div class="swiss-vehicle-chips">${renderVehicleChips(vehicle, selectedSector)}</div>
                    <details class="swiss-vehicle-diag">
                        <summary>${esc(tr("swiss_evn", "EVN"))}</summary>
                        <div>${esc(vehicle.evn || "--")}${vehicle.trolleyStatus ? ` - ${esc(vehicle.trolleyStatus)}` : ""}</div>
                    </details>
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
                    <div class="swiss-provider">${esc(tr("swiss_source", "Open Data"))}</div>
                    <button type="button" class="swiss-toggle" aria-label="Toggle formation">
                        <span class="material-symbols-outlined${wasCollapsed ? "" : " swiss-rotated"}">expand_more</span>
                    </button>
                </div>
            </div>
            <div class="swiss-body-wrap${wasCollapsed ? " swiss-collapsed" : ""}">
                <div class="swiss-body">
                    <div class="swiss-meta">
                        <span><span class="material-symbols-outlined">update</span>${esc(tr("swiss_updated", "Updated"))}: ${esc(formatZurichDateTime(data.lastUpdate))}</span>
                        <span><span class="material-symbols-outlined">route</span>${esc(tr("swiss_run_status", "Run status"))}: ${esc(runStatusLabel(data.runs))}</span>
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
            body?.classList.toggle("swiss-collapsed");
            icon?.classList.toggle("swiss-rotated");
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
