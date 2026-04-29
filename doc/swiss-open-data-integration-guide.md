# Swiss Open Data integration guide

This document records the trainmap integration approach for Swiss Open Data APIs and the practical lessons learned while wiring schedule search, route geometry, train formation, and future realtime enrichment.

Official references:

- API key workflow: <https://api-manager.opentransportdata.swiss/>
- OJP LocationInformationRequest 2.0: <https://opentransportdata.swiss/en/cookbook/open-journey-planner-ojp/ojplocationinformationrequest-2-0/>
- OJP TripRequest 2.0: <https://opentransportdata.swiss/en/cookbook/open-journey-planner-ojp/ojptriprequest-2-0/>
- Train Formation Service: <https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/formationsdaten/>
- Formation OpenAPI: <https://raw.githubusercontent.com/openTdataCH/api-explorer/main/openapi/formation/openapi.template.yaml>
- GTFS Static: <https://opentransportdata.swiss/en/cookbook/timetable-cookbook/gtfs/>
- GTFS Realtime Trip Updates: <https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/gtfs-rt/>
- GTFS Realtime Service Alerts: <https://opentransportdata.swiss/en/cookbook/event-cookbook/gtfs-sa/>
- Limits and costs: <https://opentransportdata.swiss/en/limits-and-costs/>

## 1. API products and when to use each one

| Product | Format | Main endpoint | Best use | Do not use for |
| --- | --- | --- | --- | --- |
| OJP 2.0 | XML request/response | `https://api.opentransportdata.swiss/ojp20` | station search, journey search, stop sequence, leg geometry | train formation details |
| Train Formation Service | JSON | `https://api.opentransportdata.swiss/formation/v2/formations_full` | coach order, sectors, accessibility, bike hooks, seats | route planning or station search |
| GTFS Static | ZIP/CSV files | dataset download | local timetable cache, stable matching base for GTFS-RT | live routing by itself |
| GTFS-RT Trip Updates | protobuf; JSON only for diagnostics | `https://api.opentransportdata.swiss/la/gtfs-rt` | delay/cancellation/status overlay against matching GTFS Static | route planning or historical trips |
| GTFS-RT Service Alerts | protobuf; JSON only for diagnostics | `https://api.opentransportdata.swiss/la/gtfs-sa` | disruption and alert display | stop sequence or geometry |
| Business Organisations / service-point master data | CSV / generated lookup | CKAN datasets | map operator IDs and station references to display names | live journey planning |

The practical stack for a rail archive app is:

1. Use OJP 2.0 to find stations and trips.
2. Persist the selected OJP stop sequence and route geometry.
3. If the trip is for today's operating day, query Formation and archive the JSON.
4. Later, enrich live dashboards with GTFS-RT only when you also have the matching GTFS Static version.

## 2. Tokens, headers, limits, and security

Each API product has its own API Manager subscription and token. Use the API Manager `TOKEN` value. Do not use the `TOKEN HASH` in HTTP requests.

Common HTTP headers:

```http
Authorization: Bearer <TOKEN>
User-Agent: your-app-name/your-version
```

Additional headers:

- OJP: `Content-Type: application/xml`
- Formation: `Accept: application/json`
- GTFS-RT protobuf: `Accept: application/x-protobuf`
- GTFS-RT diagnostic JSON: `Accept: application/json`

Recommended environment variables:

```bash
SWISS_OPEN_DATA_API_KEY=...
SWISS_OPEN_DATA_OJP_ENDPOINT=https://api.opentransportdata.swiss/ojp20
SWISS_OPEN_DATA_REQUESTOR_REF=your_app_prod
SWISS_OPEN_DATA_USER_AGENT=your-app/1.0

SWISS_TRAIN_FORMATION_API_KEY=...
SWISS_TRAIN_FORMATION_API_BASE_URL=https://api.opentransportdata.swiss/formation
SWISS_TRAIN_FORMATION_FULL_PATH=/v2/formations_full
SWISS_TRAIN_FORMATION_USER_AGENT=your-app/1.0

SWISS_GTFS_RT_API_KEY=...
SWISS_GTFS_RT_API_URL=https://api.opentransportdata.swiss/la/gtfs-rt
SWISS_GTFS_RT_USER_AGENT=your-app/1.0

SWISS_GTFS_SA_API_KEY=...
SWISS_GTFS_SA_API_URL=https://api.opentransportdata.swiss/la/gtfs-sa
SWISS_GTFS_SA_USER_AGENT=your-app/1.0
```

Important distinction:

- `SWISS_OPEN_DATA_REQUESTOR_REF` is an OJP/SIRI XML payload field, not a generic HTTP header.
- Formation and GTFS-RT do not use `RequestorRef`; they only need bearer token and normal HTTP headers.

Limits to design around:

- OJP 1.0, OJP 2.0, OJPFare, Formation, CKAN: normally 50 requests/minute/key and 20,000 requests/day/key.
- GTFS-RT and GTFS-RT Service Alerts: normally 5 requests/minute/key.
- These limits can change; always check the official limits page before production launch.

Security rules:

- Keep tokens server-side only.
- Never log tokens.
- If you log upstream errors, log only status, endpoint without credentials, request kind, and a short sanitized response snippet.
- Do not call OJP on every keystroke; debounce station search and only query trips after the user clicks "Find connections".

## 3. Time handling

OJP requires ISO 8601 timestamps. If you send `Z`, it is UTC. For Swiss and nearby European railway UX:

- User inputs should be interpreted in `Europe/Zurich`.
- Convert the local date/time to UTC before sending OJP.
- Show OJP response times back in the operating local timezone.

Example:

```ts
// Europe/Zurich, summer time.
// User enters 2026-04-28 13:00.
// Send to OJP as:
const depArrTime = "2026-04-28T11:00:00Z";
```

If you send `2026-04-28T13:00:00Z` for a Europe/Zurich 13:00 search in summer, the search will be two hours late.

## 4. OJP 2.0 LocationInformationRequest

Use LocationInformationRequest for station search/autocomplete.

### Request shape

The root namespace must be OJP 2.0. The easiest mistake is mixing OJP 1.0 namespaced elements into an OJP 2.0 request.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp"
     xmlns:siri="http://www.siri.org.uk/siri"
     version="2.0"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <OJPRequest>
    <siri:ServiceRequest>
      <siri:RequestTimestamp>2026-04-29T10:00:00Z</siri:RequestTimestamp>
      <siri:RequestorRef>your_app_prod</siri:RequestorRef>
      <OJPLocationInformationRequest>
        <siri:RequestTimestamp>2026-04-29T10:00:00Z</siri:RequestTimestamp>
        <siri:MessageIdentifier>lir-uuid</siri:MessageIdentifier>
        <InitialInput>
          <Name>Zürich HB</Name>
        </InitialInput>
        <Restrictions>
          <Type>stop</Type>
          <NumberOfResults>8</NumberOfResults>
          <IncludePtModes>true</IncludePtModes>
        </Restrictions>
      </OJPLocationInformationRequest>
    </siri:ServiceRequest>
  </OJPRequest>
</OJP>
```

Key fields:

| Field | Meaning | trainmap usage |
| --- | --- | --- |
| `siri:RequestTimestamp` | Request timestamp in UTC | Generate server-side for traceability |
| `siri:RequestorRef` | App/system identifier visible to OJP operators | Set from env, e.g. `trainmap_prod` |
| `siri:MessageIdentifier` | Unique request ID | Use UUID for debugging |
| `InitialInput/Name` | Search text | User station query |
| `Restrictions/Type` | Object type to return | Use `stop` for railway app station search |
| `Restrictions/NumberOfResults` | Result count | Clamp to a small number such as 8-12 |
| `Restrictions/IncludePtModes` | Include transport mode metadata | Useful for rail-first UI filtering |

Do not use the old OJP 1.0 path `InitialInput/LocationName` in an OJP 2.0 request.

### Response mapping

Typical useful response fields:

| Response field | Meaning | Internal normalized field |
| --- | --- | --- |
| `StopPlace/StopPlaceRef` | Physical stop/station reference; can be UIC/BPUIC or SLOID | `station.id` |
| `StopPoint/siri:StopPointRef` | Scheduled stop point/platform reference | use only when stop place is absent, or keep as platform ID |
| `StopPlaceName/Text` | Official stop name | `station.name` fallback |
| `Name/Text` or `LocationName/Text` | Display name from search result | preferred `station.name` |
| `GeoPosition/siri:Longitude` | WGS84 longitude | `station.coordinates[0]` |
| `GeoPosition/siri:Latitude` | WGS84 latitude | `station.coordinates[1]` |
| `Mode/PtMode` | Public transport mode | optional UI metadata |

Recommended station object:

```ts
type StationSearchResult = {
  id: string;              // StopPlaceRef or StopPointRef
  name: string;            // display name
  countryCode: string;     // infer from UIC/SLOID when possible
  coordinates: [number, number];
};
```

Country inference:

- `ch:*` SLOID -> `CH`
- 7-digit UIC/BPUIC prefix:
  - `85` Switzerland
  - `83` Italy
  - `80` Germany
  - `81` Austria
  - `87` France
  - `84` Netherlands
  - `88` Belgium
- Unknown formats -> `XX`, but keep the raw ID.

## 5. OJP 2.0 TripRequest

Use TripRequest for connection search, stop sequence, and route geometry.

### Request shape

```xml
<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp"
     xmlns:siri="http://www.siri.org.uk/siri"
     version="2.0"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <OJPRequest>
    <siri:ServiceRequest>
      <siri:RequestTimestamp>2026-04-29T10:00:00Z</siri:RequestTimestamp>
      <siri:RequestorRef>your_app_prod</siri:RequestorRef>
      <OJPTripRequest>
        <siri:RequestTimestamp>2026-04-29T10:00:00Z</siri:RequestTimestamp>
        <siri:MessageIdentifier>trip-uuid</siri:MessageIdentifier>
        <Origin>
          <PlaceRef>
            <StopPlaceRef>8503000</StopPlaceRef>
            <Name><Text>Zürich HB</Text></Name>
          </PlaceRef>
          <DepArrTime>2026-04-29T11:00:00Z</DepArrTime>
        </Origin>
        <Destination>
          <PlaceRef>
            <StopPlaceRef>8301700</StopPlaceRef>
            <Name><Text>Milano Centrale</Text></Name>
          </PlaceRef>
        </Destination>
        <Params>
          <NumberOfResults>4</NumberOfResults>
          <IgnoreRealtimeData>false</IgnoreRealtimeData>
          <IncludeTrackSections>true</IncludeTrackSections>
          <IncludeLegProjection>true</IncludeLegProjection>
          <IncludeIntermediateStops>true</IncludeIntermediateStops>
        </Params>
      </OJPTripRequest>
    </siri:ServiceRequest>
  </OJPRequest>
</OJP>
```

Important request fields:

| Field | Meaning | Practical advice |
| --- | --- | --- |
| `Origin/PlaceRef/StopPlaceRef` | origin station/stop reference | Prefer selected station ID from LIR |
| `Destination/PlaceRef/StopPlaceRef` | destination station/stop reference | Prefer selected station ID from LIR |
| `PlaceRef/GeoPosition` | coordinate fallback | Use only if no reliable stop ID exists |
| `DepArrTime` | departure or arrival time | Send UTC ISO with seconds and `Z` |
| `NumberOfResults` | number of returned options | Clamp; 3-6 is usually enough |
| `IncludeIntermediateStops` | return intermediate stop sequence | Required for trip archive |
| `IncludeLegProjection` | return leg coordinates | Required for map geometry where available |
| `IncludeTrackSections` | return track section geometry | Useful additional geometry source |
| `UseRealtimeData` | realtime inclusion policy | Use `explanatory` or provider default if you need cancelled/delayed context |

For the first production search, avoid over-filtering by mode/operator. Filters can cause empty results across borders or in mixed-mode journeys. Apply rail-only filtering after you have a working baseline.

### Response mapping

The useful OJP response shape is:

```text
OJPResponse
  ServiceDelivery
    OJPTripDelivery
      TripResponseContext
        Places
          Location / Place ...
      TripResult[]
        ResultId
        Trip
          StartTime
          EndTime
          Transfers
          Leg[] or TripLeg[]
            TimedLeg
              LegBoard
              LegIntermediate(s)
              LegAlight
              Service
              LegProjection
              TrackSection
            TransferLeg
            ContinuousLeg
```

Normalize each `TripResult` into a route option:

```ts
type RouteOption = {
  id: string;
  providerId: "swiss_open_data";
  rawResultId: string;
  trainCode: string;          // "EC 317" or "IC 61 + EC 317"
  operatorName: string;       // resolved name(s)
  departureAt: string;        // UTC ISO from StartTime or first stop
  arrivalAt: string;          // UTC ISO from EndTime or last stop
  origin: string;
  destination: string;
  stopCount: number;
  transferCount: number;
  legCount: number;
  serviceSummary: string;
  services: ServiceSummary[];
  routeSegments: RouteSegment[];
  stops: TripStop[];
  geometry?: GeoJSON.LineString;
};
```

`TripResult` fields:

| Field | Meaning | Usage |
| --- | --- | --- |
| `ResultId` / `TripId` | provider result identifier | store as `rawResultId` |
| `Trip/StartTime` | trip start time in UTC | display in local timezone |
| `Trip/EndTime` | trip end time in UTC | display in local timezone |
| `Trip/Transfers` | transfer count, if present | otherwise `TimedLeg count - 1` |
| `TimedLeg` | one operated public transport leg | create one `routeSegment` per leg |
| `TransferLeg` | walking/transfer section | normally not stored as train geometry |
| `ContinuousLeg` | non-timetable travel such as walking/sharing | optional future multimodal support |

`TimedLeg` stop fields:

| Field | Meaning | Usage |
| --- | --- | --- |
| `LegBoard/StopPointRef` | boarding stop point/platform | station/platform ID |
| `LegBoard/StopPointName/Text` | boarding name | stop display name |
| `LegBoard/ServiceDeparture/TimetabledTime` | scheduled departure | stop departure time |
| `LegIntermediate(s)` | intermediate calls | build stop sequence |
| `LegAlight/ServiceArrival/TimetabledTime` | alighting time | stop arrival time |
| `Order` | leg-local stop order | sort then renumber after merge |

`Service` fields:

| Field | Meaning | Usage |
| --- | --- | --- |
| `PublishedServiceName` / `PublishedLineName` | product/line such as `IC`, `EC`, `IR70` | train code prefix |
| `TrainNumber` / `PublishedJourneyNumber` | train/public journey number | train code number |
| `OperatorName` | operator name if provided | display directly |
| `siri:OperatorRef` | operator reference if name missing | resolve with Business Organisations |
| `JourneyRef` | provider journey ID | useful for debugging or later TripInfo lookup |
| `LineRef` | line reference | future filtering/analytics |
| `OriginText` / `DestinationText` | service direction text | UI label if available |

Operator refs:

- OJP can return numeric refs such as `11` or SLOID-like refs ending in a number.
- Resolve those through the official Business Organisations mapping.
- Example mappings used in trainmap:
  - `11` -> Swiss Federal Railways SBB
  - `955` -> Trasporti Pubblici Luganesi SA
  - `1183` -> Trenitalia S.p.A.

Geometry fields:

| Field | Meaning | Usage |
| --- | --- | --- |
| `LegProjection/Point/Longitude+Latitude` | projected line for one leg | preferred route segment geometry |
| `TrackSection` | track-related geometry section | fallback/additional segment geometry |
| stop coordinates | coordinates from `Places` or stop blocks | fallback when no projection exists |

Route geometry strategy:

1. For each `TimedLeg`, extract `LegProjection` coordinates.
2. If missing, extract `TrackSection` coordinates.
3. If still missing, connect the leg's stop coordinates.
4. Store each leg as a separate `routeSegment`.
5. Also build a combined `geometry` by concatenating segment coordinates.

Transfer stop deduplication:

- OJP may return one stop point for arrival and another for departure at the same physical station.
- Merge consecutive stops when they share a physical station:
  - same UIC/BPUIC, or
  - same SLOID base such as `ch:1:sloid:218`, or
  - normalized same name and very close coordinates.
- Preserve both arrival and departure times on the merged stop.

## 6. Train Formation Service

Use Formation only after you know the operating company, train number, and operating date from a timetable source such as OJP.

### Endpoints

Base URL:

```text
https://api.opentransportdata.swiss/formation
```

Preferred endpoint for an app UI:

```text
GET /v2/formations_full?evu=SBBP&operationDate=2026-04-29&trainNumber=33
```

Other endpoints:

| Endpoint | Perspective | Best use |
| --- | --- | --- |
| `/v2/formations_stop_based` | stop -> compact formation string | fast platform-sector display at one stop |
| `/v2/formations_vehicle_based` | vehicle -> details and stop sectors | tracking one coach and attributes |
| `/v2/formations_full` | both stop and vehicle perspectives | best for app UI and archiving |
| `/v2/health` | service health | monitoring |

Query parameters:

| Parameter | Meaning | Example |
| --- | --- | --- |
| `evu` | railway undertaking, case-sensitive | `SBBP` |
| `operationDate` | train operating date | `2026-04-29` |
| `trainNumber` | train number without product prefix | `33` |

Supported EVUs listed by the public docs include:

```text
BLSP, SBBP, MBC, OeBB, RhB, SOB, THURBO, TPF, TRN, VDBB, ZB
```

Example:

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_TRAIN_FORMATION_API_KEY" \
  -H "Accept: application/json" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/formation/v2/formations_full?evu=SBBP&operationDate=2026-04-29&trainNumber=33"
```

Do not test this in a normal browser address bar unless you can attach the bearer header.

### Availability and persistence

Formation data combines FOS formation details with CUS realtime stop/sector data.

Practical rules:

- Stop/sector data is most reliable on the current operating day.
- Vehicle-based data may exist for limited future dates, but some CUS-derived fields can be empty.
- Past dates should not be queried live; archive successful responses in your own database.
- A failed Formation lookup should not block trip creation.

trainmap policy:

- Query Formation automatically only for trips whose `operationDate` equals today's `Europe/Zurich` date.
- Store successful Formation summaries in `trips.raw_import_row.trainFormation`.
- Re-render old saved JSON through the current normalizer so UI improvements apply to old trips.

### Top-level JSON structure

A `formations_full` response is conceptually:

```json
{
  "lastUpdate": "2026-04-29T10:30:00Z",
  "journeyMetaInformation": {
    "SJYID": "ch:1:sjyid:...",
    "operationDate": "2026-04-29"
  },
  "trainMetaInformation": {
    "trainNumber": 33,
    "toCode": "11",
    "runs": "J"
  },
  "formationsAtScheduledStops": [],
  "formations": [],
  "relationships": []
}
```

Important top-level fields:

| Field | Meaning | App usage |
| --- | --- | --- |
| `lastUpdate` | upstream last update timestamp | diagnostics |
| `journeyMetaInformation.SJYID` | Swiss Journey ID if realtime data exists | optional cross-reference |
| `journeyMetaInformation.operationDate` | operating date | archive metadata |
| `trainMetaInformation.trainNumber` | numeric train number | display and sanity check |
| `trainMetaInformation.toCode` | transport undertaking code | diagnostics |
| `trainMetaInformation.runs` | operation status | display warnings if not `J` |
| `formationsAtScheduledStops` | stop-based compact view | passenger coach strip at selected stop |
| `formations` | vehicle-based detailed view | seats, accessibility, EVN, sectors |
| `relationships` | previous/next/fork/merge relationships | advanced diagnostics |

`trainMetaInformation.runs` values:

| Value | Meaning |
| --- | --- |
| `J` | runs |
| `N` | does not run |
| `T` | partially operated; inspect per stop |
| `L` | no / delete; documentation error upstream |

### Stop-based view: `formationsAtScheduledStops`

Each item tells you how the train looks when departing or arriving at one scheduled stop.

```json
{
  "scheduledStop": {
    "stopPoint": {
      "uic": 8503000,
      "name": "Zürich HB"
    },
    "stopTime": {
      "arrivalTime": "2026-04-29T10:00:00Z",
      "departureTime": "2026-04-29T10:02:00Z"
    },
    "track": "7",
    "stopModifications": 0,
    "stopType": "H"
  },
  "formationShort": {
    "formationShortString": "@A,[(LK,2:18,2#BHP;KW;NF,W2:14,1:13,LK)]",
    "vehicleGoals": [
      {
        "fromVehicleAtPosition": 1,
        "toVehicleAtPosition": 5,
        "destinationStopPoint": {
          "uic": 8301700,
          "name": "Milano Centrale"
        }
      }
    ]
  }
}
```

Field meanings:

| Field | Meaning | UI/use |
| --- | --- | --- |
| `scheduledStop.stopPoint.uic` | station reference | match with OJP stop by UIC |
| `scheduledStop.stopPoint.name` | station name | stop selector |
| `scheduledStop.stopTime.arrivalTime` | arrival time; may be scheduled/expected/predicted | display local |
| `scheduledStop.stopTime.departureTime` | departure time; may be scheduled/expected/predicted | display local |
| `scheduledStop.track` | platform/track, can be `N/A` | display if known |
| `scheduledStop.stopModifications` | bitset of stop/track/formation changes | diagnostics; advanced warning UI |
| `scheduledStop.stopType` | stop behavior | hide pass-through stops if needed |
| `formationShort.formationShortString` | CUS compact formation | parse into passenger coach strip |
| `formationShort.vehicleGoals` | position ranges that stay together to a destination | show train splitting/direct coach info |

Common `stopType` values:

| Value | Meaning |
| --- | --- |
| `H` | normal stop |
| `D` | non-stopping pass |
| `A` | alighting only |
| `E` | boarding only |
| `B` | stop on request |
| `-H` | operational stop |
| `+H`, `+A`, `+D`, etc. | unscheduled variants |

### Vehicle-based view: `formations[].formationVehicles`

This is the detailed per-vehicle data.

```json
{
  "position": 4,
  "number": 18,
  "vehicleIdentifier": {
    "typeCode": 6000,
    "typeCodeName": "Apm",
    "buildTypeCode": "94",
    "countryCode": "85",
    "vehicleNumber": "7515005",
    "checkNumber": "7",
    "evn": "93857515005-7",
    "parentEvn": ""
  },
  "formationVehicleAtScheduledStops": [
    {
      "stopPoint": { "uic": 8503000, "name": "Zürich HB" },
      "stopTime": { "departureTime": "2026-04-29T10:02:00Z" },
      "track": "7",
      "sectors": "B",
      "accessToPreviousVehicle": true
    }
  ],
  "vehicleProperties": {
    "length": 26.4,
    "fromStop": { "uic": 8503000, "name": "Zürich HB" },
    "toStop": { "uic": 8301700, "name": "Milano Centrale" },
    "number1class": 0,
    "number2class": 80,
    "numberBikeHooks": 2,
    "lowFloorTrolley": true,
    "closed": false,
    "trolleyStatus": "Normal",
    "accessibilityProperties": {
      "numberWheelchairSpaces": 2,
      "wheelchairToilet": true
    },
    "pictoProperties": {
      "wheelchairPicto": true,
      "bikePicto": true,
      "strollerPicto": false,
      "familyZonePicto": false,
      "businessZonePicto": false
    }
  }
}
```

Field meanings:

| Field | Meaning | UI/use |
| --- | --- | --- |
| `position` | physical order in train, starts at 1 and can include locomotive | sorting |
| `number` | passenger-visible coach/reservation number; 0 means likely not displayed | coach label |
| `vehicleIdentifier.typeCode` | official vehicle type code | diagnostics |
| `vehicleIdentifier.typeCodeName` | readable vehicle type label | coach subtype |
| `vehicleIdentifier.evn` | European Vehicle Number or pseudo EVN | technical details |
| `vehicleIdentifier.parentEvn` | parent EVN for articulated/multiple-unit children | group related vehicles |
| `formationVehicleAtScheduledStops[].sectors` | sector(s) the vehicle spans at that stop | platform-sector UI |
| `accessToPreviousVehicle` | can pass through to previous vehicle | no-passage marker |
| `vehicleProperties.fromStop/toStop` | where this vehicle is attached in this formation | direct coach / split train context |
| `number1class`, `number2class` | seat counts by class | capacity summary |
| `numberBikeHooks` | bike hooks/places | bicycle icon |
| `lowFloorTrolley` | low-floor access | low-floor icon |
| `closed` | vehicle closed | hide or mark unavailable |
| `trolleyStatus` | technical/operational/restaurant/declassified status | warnings |
| `accessibilityProperties.numberWheelchairSpaces` | wheelchair spaces | wheelchair icon and count |
| `pictoProperties.*` | whether a pictogram should be shown | user-facing icons |

`trolleyStatus` values:

| Value | Meaning |
| --- | --- |
| `Normal` | no special status |
| `GeschlossenTechnisch` | technically closed |
| `GeschlossenBetrieblich` | operationally closed |
| `RestaurantUnbedient` | restaurant not staffed |
| `RestaurantUnbedientDeklassiert` | restaurant not staffed and class limitation removed |
| `Deklassiert` | class limitation removed / declassified |

### Formation short string

The stop-based `formationShortString` is compact and CUS-specific. It is the best source for drawing a platform-sector coach strip.

Example:

```text
@A,F,F@B,[(LK,2:18,2#BHP;KW;NF,W2:14,1:13,:12,LK)]@C,X
```

Tokens:

| Token | Meaning | UI guidance |
| --- | --- | --- |
| `@A` ... `@Z` | platform sector | group following vehicles by sector |
| `[` and `]` | start/end of vehicle group belonging to the running train | exclude outside parked/stabled vehicles from main passenger strip |
| `(` and `)` | no passage to neighbouring vehicle on that side | show "no passage" marker |
| `-` | vehicle closed | mark as closed; may hide if no passenger number |
| `>` | groups start at this boarding point | diagnostics / group travel info |
| `=` | reserved partly for through groups | diagnostics |
| `%` | open but restaurant not served | show restaurant unavailable |
| `1` | 1st class passenger coach | `1 Class` |
| `2` | 2nd class passenger coach | `2 Class` |
| `12` | mixed 1st and 2nd class coach | `1/2 Class` |
| `CC` | couchette car | sleeper/night UI |
| `FA` | family coach | family icon |
| `WL` | sleeping car | sleeper UI |
| `WR` | restaurant car | dining icon |
| `W1` | restaurant + 1st class | dining + 1st class |
| `W2` | restaurant + 2nd class | dining + 2nd class |
| `LK` | traction unit / locomotive | usually hidden from passenger coach strip |
| `D` | baggage car | baggage icon if needed |
| `F` | fictitious sector filler | hide from passenger strip |
| `K` | classless vehicle | show as special/unknown coach if passenger-visible |
| `X` | parked/stabled coach | hide from running train strip |
| `2:18` | 2nd class coach, displayed coach number 18 | coach card number 18, class 2 |
| `:12` | same vehicle type as previous real coach, displayed number 12 | inherit previous type |
| `2#BHP;KW;NF` | 2nd class coach with services | parse service codes |

Service codes:

| Code | Meaning | UI icon |
| --- | --- | --- |
| `BHP` | wheelchair spaces | wheelchair |
| `BZ` | business zone | briefcase/business |
| `FZ` | family zone | family |
| `KW` | pram/stroller platform | stroller |
| `NF` | low-floor access | low-floor/step-free |
| `VH` | bicycle hooks/platform | bicycle |
| `VR` | bicycle hooks/platform with reservation | bicycle + reservation hint |

Recommended UI algorithm:

1. Pick selected stop's `formationShortString`.
2. Parse sectors and vehicle tokens.
3. Drop `F`, `X`, and `LK` from the main passenger coach strip.
4. Merge parsed coach display numbers with detailed `formationVehicles` by `number` first, then by `position`.
5. Use short string for sector layout; use `vehicleProperties` for seats, accessibility, low-floor, bike, business/family icons.
6. Keep raw string and EVN details in a collapsed diagnostics section.

## 7. GTFS Static

GTFS Static is the stable timetable/reference layer used to understand GTFS-RT.

Important files:

| File | Main fields | Use |
| --- | --- | --- |
| `agency.txt` | `agency_id`, `agency_name`, `agency_url`, `agency_timezone` | operator display |
| `stops.txt` | `stop_id`, `stop_name`, `stop_lat`, `stop_lon`, `parent_station`, `platform_code` | station search/cache |
| `routes.txt` | `route_id`, `agency_id`, `route_short_name`, `route_long_name`, `route_type` | line metadata |
| `trips.txt` | `trip_id`, `route_id`, `service_id`, `trip_headsign`, `direction_id`, `shape_id` | trip identity |
| `stop_times.txt` | `trip_id`, `arrival_time`, `departure_time`, `stop_id`, `stop_sequence` | stop sequence |
| `calendar.txt` | weekly service pattern | operating days |
| `calendar_dates.txt` | exceptions/additions/removals | exact date validity |
| `shapes.txt` | `shape_id`, `shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence` | planned route geometry if available |
| `transfers.txt` | transfer rules | connection planning hints |
| `feed_info.txt` | feed metadata/version | match with GTFS-RT feed version |

Important implementation rule:

- GTFS Static IDs can change between feed versions.
- GTFS-RT must be interpreted against the matching static feed version.
- The Swiss GTFS-RT feed exposes a feed version in the header when viewed as JSON; store that version and load the matching GTFS Static package.

Use GTFS Static for another site when you need:

- local station autocomplete without calling OJP on every search,
- offline stop and route metadata,
- mapping GTFS-RT `trip_id`, `stop_id`, and `route_id` to names,
- planned route geometry from `shapes.txt`.

Do not use GTFS Static alone when you need:

- real-time route planning,
- cross-border journey alternatives,
- fresh cancellations/delays,
- exact OJP leg projection from a user-selected timetable result.

## 8. GTFS-RT Trip Updates

GTFS-RT is a protobuf feed. The JSON endpoint exists for diagnostics and development, but production should consume protobuf.

Diagnostic JSON request:

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_GTFS_RT_API_KEY" \
  -H "Accept: application/json" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON"
```

Production protobuf request:

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_GTFS_RT_API_KEY" \
  -H "Accept: application/x-protobuf" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/la/gtfs-rt"
```

Important transport behavior:

- Follow redirects (`curl -L`, `fetch` follows by default unless configured otherwise).
- The feed is cached for short intervals; do not poll too aggressively.
- JSON may be large and its serialization changed in 2025; use protobuf for production.

Conceptual JSON shape:

```json
{
  "header": {
    "gtfsRealtimeVersion": "1.0",
    "incrementality": "FULL_DATASET",
    "timestamp": 1727429583,
    "feedVersion": "20240926"
  },
  "entity": [
    {
      "id": "entity-id",
      "tripUpdate": {
        "trip": {
          "tripId": "...",
          "routeId": "...",
          "startDate": "20260429",
          "startTime": "10:30:00",
          "scheduleRelationship": "SCHEDULED"
        },
        "stopTimeUpdate": [
          {
            "stopSequence": 12,
            "stopId": "...",
            "arrival": { "time": 1777455000, "delay": 120 },
            "departure": { "time": 1777455120, "delay": 120 },
            "scheduleRelationship": "SCHEDULED"
          }
        ],
        "timestamp": 1777454500
      }
    }
  ]
}
```

Field meanings:

| Field | Meaning | Usage |
| --- | --- | --- |
| `header.gtfsRealtimeVersion` | GTFS-RT schema version | diagnostics |
| `header.incrementality` | full dataset or differential | assume full unless documented otherwise |
| `header.timestamp` | feed generation Unix timestamp | staleness check |
| `header.feedVersion` | matching GTFS Static version | load correct static feed |
| `entity.id` | feed entity ID | dedupe |
| `entity.isDeleted` | deleted entity flag, if present | remove old state |
| `tripUpdate.trip.tripId` | GTFS Static trip ID | match to `trips.txt` |
| `tripUpdate.trip.routeId` | GTFS route ID | match to `routes.txt` |
| `tripUpdate.trip.startDate` | service date `YYYYMMDD` | match calendar date |
| `tripUpdate.trip.startTime` | scheduled start time | match trip instance |
| `tripUpdate.trip.scheduleRelationship` | scheduled/added/cancelled/etc. | status badge |
| `stopTimeUpdate[].stopSequence` | planned stop order | match `stop_times.txt` |
| `stopTimeUpdate[].stopId` | GTFS stop ID | match `stops.txt` |
| `arrival.time` / `departure.time` | Unix timestamp | predicted local time |
| `arrival.delay` / `departure.delay` | delay in seconds in GTFS standard | delay display |
| `stopTimeUpdate[].scheduleRelationship` | per-stop status | skipped/no-data status |

Recommended use:

1. Download and version GTFS Static.
2. Poll GTFS-RT at a safe interval.
3. Parse protobuf.
4. Match `feedVersion` to your static feed.
5. Attach updates to known trips by `trip_id` and service date.
6. Show delays/cancellations as an overlay; do not overwrite archived trip data.

## 9. GTFS-RT Service Alerts

Service Alerts are also GTFS-RT protobuf. Use them to show disruptions, not to create trips.

Diagnostic JSON:

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_GTFS_SA_API_KEY" \
  -H "Accept: application/json" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/la/gtfs-sa?format=JSON"
```

Conceptual alert shape:

```json
{
  "entity": [
    {
      "id": "alert-id",
      "alert": {
        "activePeriod": [
          { "start": 1777450000, "end": 1777460000 }
        ],
        "informedEntity": [
          { "routeId": "...", "stopId": "...", "trip": { "tripId": "..." } }
        ],
        "cause": "TECHNICAL_PROBLEM",
        "effect": "DELAY",
        "url": { "translation": [{ "text": "https://..." }] },
        "headerText": { "translation": [{ "language": "de", "text": "..." }] },
        "descriptionText": { "translation": [{ "language": "de", "text": "..." }] }
      }
    }
  ]
}
```

Field meanings:

| Field | Meaning | Usage |
| --- | --- | --- |
| `activePeriod.start/end` | Unix time validity | show only active/relevant alerts |
| `informedEntity.routeId` | affected GTFS route | route-level alert |
| `informedEntity.stopId` | affected GTFS stop | station alert |
| `informedEntity.trip.tripId` | affected trip | trip alert |
| `cause` | reason category | icon/category |
| `effect` | disruption effect | severity/status |
| `headerText.translation[]` | short localized title | UI title |
| `descriptionText.translation[]` | long localized message | details panel |
| `url.translation[]` | external detail link | "More information" link |

Use language fallback:

1. preferred UI language,
2. German,
3. French,
4. Italian,
5. first available translation.

## 10. Recommended persistence model

For another website, keep provider payloads separate from normalized app records.

Suggested tables/collections:

```ts
type Station = {
  id: string;
  provider: "ojp" | "gtfs" | "manual";
  name: string;
  countryCode?: string;
  coordinates?: [number, number];
  rawRef?: string;
};

type PlannedTrip = {
  id: string;
  provider: "swiss_open_data_ojp";
  rawResultId: string;
  title: string;
  departureAt: string;
  arrivalAt: string;
  operatorName?: string;
  trainCode?: string;
  transferCount: number;
  stops: TripStop[];
  routeSegments: RouteSegment[];
  geometry?: GeoJSON.LineString;
  rawProviderSummary?: unknown;
};

type TripStop = {
  stationId: string;
  stationName: string;
  countryCode?: string;
  coordinates?: [number, number];
  sequence: number;
  arrivalAt?: string;
  departureAt?: string;
  platform?: string;
};

type RouteSegment = {
  sequence: number;
  trainCode?: string;
  operatorName?: string;
  departureAt?: string;
  arrivalAt?: string;
  stops: TripStop[];
  geometry?: GeoJSON.LineString;
};

type ArchivedFormation = {
  provider: "swiss_train_formation";
  requestedAt: string;
  operationDate: string;
  evu: string;
  trainNumber: string;
  status: "available" | "unavailable" | "failed";
  summaries: unknown[];
  raw?: unknown;
};
```

Key principles:

- Store normalized stops and route segments for stable app behavior.
- Preserve enough raw provider fields for future re-parsing.
- Do not make the basemap responsible for route geometry.
- Do not overwrite archived trips with realtime updates; attach realtime as a volatile overlay.
- Store Formation responses because upstream history is limited.

## 11. End-to-end flows

### Schedule-assisted trip creation

1. User searches origin station.
2. Server posts OJP LocationInformationRequest.
3. User selects exact station.
4. User searches destination station.
5. User selects exact station.
6. User enters local date/time.
7. Server converts local date/time to UTC ISO.
8. Server posts OJP TripRequest with geometry and stop flags.
9. UI shows options:
   - local departure/arrival time,
   - duration,
   - direct/transfer count,
   - train code(s),
   - operator(s),
   - route preview.
10. User selects one option.
11. Persist trip, stops, route segments, geometry version.
12. If same-day and supported EVU, query Formation and archive it.

### Formation refresh

1. Trip detail page checks if trip operation date is today's `Europe/Zurich` date.
2. It checks whether Formation token is configured.
3. It infers supported EVU and train number from saved OJP service metadata.
4. It queries `formations_full`.
5. It patches only the archived Formation JSON.
6. UI normalizes and displays the current passenger-facing view.

### Realtime dashboard enrichment

1. Maintain GTFS Static versions.
2. Poll GTFS-RT protobuf within rate limits.
3. Verify `feedVersion`.
4. Match `trip_id`, `route_id`, `stop_id`.
5. Attach delays/cancellations/alerts to UI.
6. Keep realtime data ephemeral unless your product explicitly archives it.

## 12. Error handling checklist

OJP 400:

- Check OJP 2.0 namespace.
- Check `InitialInput/Name`, not old `LocationName`.
- Check `DepArrTime` is UTC ISO with seconds and `Z`.
- Check XML escaping for station names with `&`, `<`, `>`, quotes.
- Log sanitized response snippet.

OJP no useful geometry:

- Keep stop sequence.
- Generate provisional geometry from stop coordinates.
- Let the user manually repair route geometry later.

Formation 401/403:

- Token missing or wrong product subscription.
- Wrong endpoint path.
- Bearer header absent.
- EVU/date/train not allowed for that token/product.

Formation 404/unavailable:

- Date too old.
- CUS realtime data missing.
- EVU not supported.
- Train number mismatch; strip product prefix and send only the numeric train number.

GTFS-RT mismatch:

- Wrong GTFS Static version.
- Missing redirect handling.
- Polling above rate limits.
- JSON serialization changed; use protobuf.

## 13. What trainmap learned

- OJP and Formation are separate systems. OJP plans routes; Formation describes vehicles.
- OJP gives good cross-border route geometry when `IncludeLegProjection` and `IncludeTrackSections` are requested, but it can still be missing for some legs.
- Same-station transfers often appear as separate arrival/departure stop points; merge them for user-facing stop counts.
- OJP times are UTC; display in local operating timezone.
- Formation stop-sector data is tied to CUS and should be treated as same-day live data.
- Formation JSON should be archived when available, otherwise historical trip detail will lose the coach diagram later.
- Formation short strings are not a user interface. Parse them, merge with vehicle details, and hide raw CUS strings in diagnostics.
- GTFS-RT is best used after GTFS Static ingestion, not as a shortcut for route creation.

