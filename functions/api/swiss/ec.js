const DEFAULT_BASE_URL = "https://api.opentransportdata.swiss/formation";
const DEFAULT_FULL_PATH = "/v2/formations_full";
const DEFAULT_EVU = "SBBP";
const ALLOWED_HOSTS = new Set([
    "real.bellotreno.org",
    "bellotreno.pages.dev",
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]"
]);

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            ...extraHeaders
        }
    });
}

function isLocalHost(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isAllowedHost(hostname, requestHost) {
    return hostname === requestHost || ALLOWED_HOSTS.has(hostname);
}

function getUrlHostname(value) {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}

function requestIsAllowed(request) {
    const requestUrl = new URL(request.url);
    const requestHost = requestUrl.hostname;
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    if (origin) {
        return isAllowedHost(getUrlHostname(origin), requestHost);
    }

    if (referer) {
        return isAllowedHost(getUrlHostname(referer), requestHost);
    }

    return isLocalHost(requestHost);
}

function corsHeaders(request) {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    const requestHost = new URL(request.url).hostname;
    const originHost = getUrlHostname(origin);
    if (!isAllowedHost(originHost, requestHost)) return {};
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        "vary": "origin"
    };
}

function todayInZurich() {
    return new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Zurich",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

function asString(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function asInt(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function asFloat(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function asBool(value) {
    return value === true || value === "true" || value === 1 || value === "1";
}

function asOptionalBool(value) {
    if (value === null || value === undefined || value === "") return null;
    return asBool(value);
}

function normalizeStopPoint(stopPoint) {
    return {
        uic: asString(stopPoint?.uic),
        name: asString(stopPoint?.name)
    };
}

function normalizeStop(rawStop) {
    const scheduledStop = rawStop?.scheduledStop || {};
    const stopPoint = normalizeStopPoint(scheduledStop.stopPoint || {});
    const stopTime = scheduledStop.stopTime || {};
    const formationShort = rawStop?.formationShort || {};

    return {
        uic: stopPoint.uic,
        name: stopPoint.name,
        arrivalTime: asString(stopTime.arrivalTime),
        departureTime: asString(stopTime.departureTime),
        track: asString(scheduledStop.track),
        stopType: asString(scheduledStop.stopType),
        stopModifications: asInt(scheduledStop.stopModifications),
        formationShortString: asString(formationShort.formationShortString),
        vehicleGoals: Array.isArray(formationShort.vehicleGoals)
            ? formationShort.vehicleGoals.map((goal) => ({
                fromVehicleAtPosition: asInt(goal.fromVehicleAtPosition),
                toVehicleAtPosition: asInt(goal.toVehicleAtPosition),
                destinationStopPoint: normalizeStopPoint(goal.destinationStopPoint || {})
            }))
            : []
    };
}

function extractVehicles(raw) {
    const vehicles = [];
    if (!Array.isArray(raw?.formations)) return vehicles;

    for (const formation of raw.formations) {
        if (Array.isArray(formation?.formationVehicles)) {
            vehicles.push(...formation.formationVehicles);
        } else if (formation && (formation.vehicleIdentifier || formation.vehicleProperties || formation.position !== undefined)) {
            vehicles.push(formation);
        }
    }

    return vehicles;
}

function normalizeVehicleStop(rawStop) {
    const stopPoint = normalizeStopPoint(rawStop?.stopPoint || {});
    const stopTime = rawStop?.stopTime || {};

    return {
        uic: stopPoint.uic,
        name: stopPoint.name,
        arrivalTime: asString(stopTime.arrivalTime),
        departureTime: asString(stopTime.departureTime),
        track: asString(rawStop?.track),
        sectors: asString(rawStop?.sectors),
        accessToPreviousVehicle: asOptionalBool(rawStop?.accessToPreviousVehicle)
    };
}

function normalizeVehicle(rawVehicle) {
    const identifier = rawVehicle?.vehicleIdentifier || {};
    const props = rawVehicle?.vehicleProperties || {};
    const accessibility = props.accessibilityProperties || {};
    const wheelchairSymbol = accessibility.wheelchairSymbolProperties || {};
    const picto = props.pictoProperties || {};

    const trolleyStatus = asString(props.trolleyStatus);
    const vehicleWillBePutAway = asBool(props.vehicleWillBePutAway);

    return {
        position: asInt(rawVehicle?.position),
        number: asInt(rawVehicle?.number),
        typeCode: asString(identifier.typeCode),
        typeCodeName: asString(identifier.typeCodeName),
        buildTypeCode: asString(identifier.buildTypeCode),
        countryCode: asString(identifier.countryCode),
        vehicleNumber: asString(identifier.vehicleNumber),
        checkNumber: asString(identifier.checkNumber),
        evn: asString(identifier.evn),
        parentEvn: asString(identifier.parentEvn),
        length: asFloat(props.length),
        numberRestaurantSpace: asInt(props.numberRestaurantSpace),
        numberBeds: asInt(props.numberBeds),
        firstClassSeats: asInt(props.number1class),
        secondClassSeats: asInt(props.number2class),
        bikeHooks: asInt(props.numberBikeHooks),
        bikePlatform: asBool(props.bikePlatform),
        emergencyCallSystem: asBool(props.emergencyCallSystem),
        lowFloor: asBool(props.lowFloorTrolley) || asBool(picto.lowFloorPicto),
        climated: asBool(props.climated),
        wheelchairSpaces: asInt(accessibility.numberWheelchairSpaces),
        wheelchairSpacesFirstClass: asInt(accessibility.numberWheelchairSpaces1class),
        wheelchairSpacesSecondClass: asInt(accessibility.numberWheelchairSpaces2class),
        wheelchairToilet: asBool(accessibility.wheelchairToilet),
        wheelchairAccessibleRestaurant: asBool(accessibility.wheelchairAccessibleRestaurant),
        disabledCompartment: asBool(accessibility.disabledCompartment),
        wheelchairFoldingRamp: asBool(wheelchairSymbol.foldingRamp),
        wheelchairGapBridging: asBool(wheelchairSymbol.gapBridging),
        wheelchairBoardingPlatformHeight: asFloat(wheelchairSymbol.heightBoardingPlatform),
        wheelchairPicto: asBool(picto.wheelchairPicto),
        bikePicto: asBool(picto.bikePicto),
        strollerPicto: asBool(picto.strollerPicto),
        familyZonePicto: asBool(picto.familyZonePicto),
        businessZonePicto: asBool(picto.businessZonePicto),
        closed: asBool(props.closed) || /geschlossen/i.test(trolleyStatus || ""),
        vehicleWillBePutAway,
        trolleyStatus,
        fromStop: asString(props.fromStop?.name),
        toStop: asString(props.toStop?.name),
        segments: buildVehicleSegments(props),
        stopSectors: Array.isArray(rawVehicle?.formationVehicleAtScheduledStops)
            ? rawVehicle.formationVehicleAtScheduledStops.map(normalizeVehicleStop)
            : []
    };
}

function buildVehicleSegments(props) {
    const fromStop = asString(props?.fromStop?.name);
    const toStop = asString(props?.toStop?.name);
    if (!fromStop && !toStop) return [];
    return [{ fromStop, toStop }];
}

function vehicleKey(vehicle) {
    if (vehicle.evn && vehicle.position) return `evn:${vehicle.evn}:pos:${vehicle.position}`;
    if (vehicle.evn) return `evn:${vehicle.evn}`;

    const completeVehicleNumber = [
        vehicle.buildTypeCode,
        vehicle.countryCode,
        vehicle.vehicleNumber,
        vehicle.checkNumber
    ].filter(Boolean).join(":");
    if (completeVehicleNumber && vehicle.position) return `vehicle:${completeVehicleNumber}:pos:${vehicle.position}`;
    if (completeVehicleNumber) return `vehicle:${completeVehicleNumber}`;

    return `fallback:${vehicle.position || ""}:${vehicle.number || ""}:${vehicle.typeCodeName || ""}:${vehicle.typeCode || ""}`;
}

function mergeUniqueObjects(left, right, keyFn) {
    const map = new Map();
    for (const item of [...left, ...right]) {
        const key = keyFn(item);
        if (!key || !map.has(key)) map.set(key || `item:${map.size}`, item);
    }
    return Array.from(map.values());
}

function preferValue(currentValue, nextValue) {
    if (currentValue === null || currentValue === undefined || currentValue === "" || currentValue === 0) {
        return nextValue;
    }
    return currentValue;
}

function mergeVehicles(existing, incoming) {
    return {
        ...existing,
        position: Math.min(existing.position || incoming.position || 9999, incoming.position || existing.position || 9999),
        number: preferValue(existing.number, incoming.number),
        typeCode: preferValue(existing.typeCode, incoming.typeCode),
        typeCodeName: preferValue(existing.typeCodeName, incoming.typeCodeName),
        buildTypeCode: preferValue(existing.buildTypeCode, incoming.buildTypeCode),
        countryCode: preferValue(existing.countryCode, incoming.countryCode),
        vehicleNumber: preferValue(existing.vehicleNumber, incoming.vehicleNumber),
        checkNumber: preferValue(existing.checkNumber, incoming.checkNumber),
        evn: preferValue(existing.evn, incoming.evn),
        parentEvn: preferValue(existing.parentEvn, incoming.parentEvn),
        length: Math.max(existing.length || 0, incoming.length || 0),
        numberRestaurantSpace: Math.max(existing.numberRestaurantSpace || 0, incoming.numberRestaurantSpace || 0),
        numberBeds: Math.max(existing.numberBeds || 0, incoming.numberBeds || 0),
        firstClassSeats: Math.max(existing.firstClassSeats || 0, incoming.firstClassSeats || 0),
        secondClassSeats: Math.max(existing.secondClassSeats || 0, incoming.secondClassSeats || 0),
        bikeHooks: Math.max(existing.bikeHooks || 0, incoming.bikeHooks || 0),
        bikePlatform: existing.bikePlatform || incoming.bikePlatform,
        emergencyCallSystem: existing.emergencyCallSystem || incoming.emergencyCallSystem,
        lowFloor: existing.lowFloor || incoming.lowFloor,
        climated: existing.climated || incoming.climated,
        wheelchairSpaces: Math.max(existing.wheelchairSpaces || 0, incoming.wheelchairSpaces || 0),
        wheelchairSpacesFirstClass: Math.max(existing.wheelchairSpacesFirstClass || 0, incoming.wheelchairSpacesFirstClass || 0),
        wheelchairSpacesSecondClass: Math.max(existing.wheelchairSpacesSecondClass || 0, incoming.wheelchairSpacesSecondClass || 0),
        wheelchairToilet: existing.wheelchairToilet || incoming.wheelchairToilet,
        wheelchairAccessibleRestaurant: existing.wheelchairAccessibleRestaurant || incoming.wheelchairAccessibleRestaurant,
        disabledCompartment: existing.disabledCompartment || incoming.disabledCompartment,
        wheelchairFoldingRamp: existing.wheelchairFoldingRamp || incoming.wheelchairFoldingRamp,
        wheelchairGapBridging: existing.wheelchairGapBridging || incoming.wheelchairGapBridging,
        wheelchairBoardingPlatformHeight: Math.max(existing.wheelchairBoardingPlatformHeight || 0, incoming.wheelchairBoardingPlatformHeight || 0),
        wheelchairPicto: existing.wheelchairPicto || incoming.wheelchairPicto,
        bikePicto: existing.bikePicto || incoming.bikePicto,
        strollerPicto: existing.strollerPicto || incoming.strollerPicto,
        familyZonePicto: existing.familyZonePicto || incoming.familyZonePicto,
        businessZonePicto: existing.businessZonePicto || incoming.businessZonePicto,
        closed: existing.closed || incoming.closed,
        vehicleWillBePutAway: existing.vehicleWillBePutAway || incoming.vehicleWillBePutAway,
        trolleyStatus: preferValue(existing.trolleyStatus, incoming.trolleyStatus),
        fromStop: preferValue(existing.fromStop, incoming.fromStop),
        toStop: preferValue(existing.toStop, incoming.toStop),
        segments: mergeUniqueObjects(existing.segments || [], incoming.segments || [], (segment) => [
            segment.fromStop || "",
            segment.toStop || ""
        ].join("|")),
        stopSectors: mergeUniqueObjects(existing.stopSectors || [], incoming.stopSectors || [], (stop) => [
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

function normalizeVehicles(rawVehicles) {
    const map = new Map();
    for (const rawVehicle of rawVehicles) {
        const vehicle = normalizeVehicle(rawVehicle);
        const key = vehicleKey(vehicle);
        if (map.has(key)) {
            map.set(key, mergeVehicles(map.get(key), vehicle));
        } else {
            map.set(key, vehicle);
        }
    }

    return Array.from(map.values()).sort((a, b) => (a.position || 9999) - (b.position || 9999));
}

function reportedVehicleCount(raw) {
    const counts = Array.isArray(raw?.formations)
        ? raw.formations.map((formation) => asInt(formation?.metaInformation?.numberVehicles)).filter(Boolean)
        : [];
    return counts.length ? Math.max(...counts) : 0;
}

function normalizeFormation(raw, requestedTrainNumber, requestedDate, evu) {
    const trainMeta = raw?.trainMetaInformation || {};
    const journeyMeta = raw?.journeyMetaInformation || {};
    const stops = Array.isArray(raw?.formationsAtScheduledStops)
        ? raw.formationsAtScheduledStops.map(normalizeStop).filter((stop) => stop.name)
        : [];
    const rawVehicles = extractVehicles(raw);
    const vehicles = normalizeVehicles(rawVehicles);

    if (!stops.length && !vehicles.length) {
        return null;
    }

    return {
        available: true,
        provider: "swiss_train_formation",
        evu,
        trainNumber: asString(trainMeta.trainNumber) || requestedTrainNumber,
        operationDate: asString(journeyMeta.operationDate) || requestedDate,
        lastUpdate: asString(raw?.lastUpdate),
        runs: asString(trainMeta.runs),
        stops,
        vehicles,
        vehicleCount: vehicles.length,
        rawVehicleCount: rawVehicles.length,
        reportedVehicleCount: reportedVehicleCount(raw)
    };
}

function buildFormationUrl(baseUrl, fullPath, evu, operationDate, trainNumber) {
    const normalizedBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const normalizedPath = String(fullPath || DEFAULT_FULL_PATH).replace(/^\/+/, "");
    const upstreamUrl = new URL(`${normalizedBase}/${normalizedPath}`);
    upstreamUrl.searchParams.set("evu", evu);
    upstreamUrl.searchParams.set("operationDate", operationDate);
    upstreamUrl.searchParams.set("trainNumber", trainNumber);
    return upstreamUrl;
}

export async function onRequestOptions(context) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(context.request)
    });
}

export async function onRequestGet(context) {
    const request = context.request;
    const headers = corsHeaders(request);

    if (!requestIsAllowed(request)) {
        return json({ available: false, reason: "forbidden" }, 403, headers);
    }

    const url = new URL(request.url);
    const trainNumber = (url.searchParams.get("train") || "").replace(/\D+/g, "");
    const operationDate = (url.searchParams.get("date") || "").trim();

    if (!trainNumber || !/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) {
        return json({ available: false, reason: "bad_request" }, 400, headers);
    }

    if (operationDate !== todayInZurich()) {
        return json(
            { available: false, reason: "not_same_day" },
            200,
            headers
        );
    }

    const token = context.env.SWISS_TRAIN_FORMATION_API_KEY;
    if (!token) {
        return json(
            { available: false, reason: "not_configured" },
            200,
            { ...headers, "cache-control": "no-store" }
        );
    }

    const baseUrl = context.env.SWISS_TRAIN_FORMATION_API_BASE_URL || DEFAULT_BASE_URL;
    const fullPath = context.env.SWISS_TRAIN_FORMATION_FULL_PATH || DEFAULT_FULL_PATH;
    const evu = context.env.SWISS_TRAIN_FORMATION_EVU || DEFAULT_EVU;
    const upstreamUrl = buildFormationUrl(baseUrl, fullPath, evu, operationDate, trainNumber);

    try {
        const upstream = await fetch(upstreamUrl.toString(), {
            headers: {
                "accept": "application/json",
                "authorization": `Bearer ${token}`,
                "user-agent": context.env.SWISS_TRAIN_FORMATION_USER_AGENT || "BelloTreno/1.0"
            }
        });

        if (upstream.status === 404) {
            return json({ available: false, reason: "not_found" }, 200, headers);
        }

        if (upstream.status === 401 || upstream.status === 403) {
            return json({ available: false, reason: "forbidden" }, 200, {
                ...headers,
                "cache-control": "no-store"
            });
        }

        if (!upstream.ok) {
            return json({ available: false, reason: "upstream_error" }, 200, {
                ...headers,
                "cache-control": "no-store"
            });
        }

        const raw = await upstream.json();
        const normalized = normalizeFormation(raw, trainNumber, operationDate, evu);

        if (!normalized) {
            return json({ available: false, reason: "not_found" }, 200, headers);
        }

        return json(normalized, 200, headers);
    } catch (error) {
        return json({ available: false, reason: "upstream_error" }, 200, {
            ...headers,
            "cache-control": "no-store"
        });
    }
}

export async function onRequest(context) {
    if (context.request.method === "OPTIONS") {
        return onRequestOptions(context);
    }
    if (context.request.method === "GET") {
        return onRequestGet(context);
    }
    return json({ available: false, reason: "method_not_allowed" }, 405, {
        "allow": "GET, OPTIONS"
    });
}
