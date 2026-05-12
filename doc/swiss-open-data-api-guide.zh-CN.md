# Swiss Open Data API 使用文档（中文实践版）

本文档整理了 trainmap 在接入 Swiss Open Data / opentransportdata.swiss 时用到的几个核心 API、数据结构、字段含义、实现经验和常见坑。目标不是复述官方文档，而是给另一个网站接入时可以直接参考的工程手册。

官方资料入口：

- API Manager / 获取 Token：<https://api-manager.opentransportdata.swiss/>
- OJP 2.0 概览：<https://opentransportdata.swiss/en/cookbook/open-journey-planner-ojp/>
- OJP LocationInformationRequest 2.0：<https://opentransportdata.swiss/en/cookbook/open-journey-planner-ojp/ojplocationinformationrequest-2-0/>
- OJP TripRequest 2.0：<https://opentransportdata.swiss/en/cookbook/open-journey-planner-ojp/ojptriprequest-2-0/>
- Train Formation Service：<https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/formationsdaten/>
- Formation OpenAPI：<https://raw.githubusercontent.com/openTdataCH/api-explorer/main/openapi/formation/openapi.template.yaml>
- GTFS Static：<https://opentransportdata.swiss/en/cookbook/timetable-cookbook/gtfs/>
- GTFS Realtime Trip Updates：<https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/gtfs-rt/>
- GTFS Realtime Service Alerts：<https://opentransportdata.swiss/en/cookbook/event-cookbook/gtfs-sa/>
- Limits and costs：<https://opentransportdata.swiss/en/limits-and-costs/>

## 1. 应该接哪些 API

Swiss Open Data 不是一个“全能路线 API”。不同 API 负责不同层级的数据，实际产品里需要分层使用。

| API / 数据产品 | 格式 | 主要用途 | 不适合做什么 |
| --- | --- | --- | --- |
| OJP 2.0 | XML 请求 / XML 响应 | 站点搜索、连接搜索、列车停站序列、腿段几何 | 车厢编组、实时占用、车厢座位 |
| Train Formation Service | JSON | 车厢顺序、站台扇区、无障碍、自行车位、餐车等 | 路线规划、站点搜索 |
| GTFS Static | ZIP + CSV | 本地时刻表缓存、站点/线路/班次基础数据、GTFS-RT 匹配基础 | 实时路线搜索 |
| GTFS-RT Trip Updates | Protobuf，调试时可 JSON | 延误、取消、实时到发时间 | 创建历史旅程、获取精确路线几何 |
| GTFS-RT Service Alerts | Protobuf，调试时可 JSON | 运行中断、线路/车站/车次告警 | 路线规划、站序生成 |
| Business Organisations / service point master data | CSV / CKAN 数据集 | operator ID、车站 ID、企业名称映射 | 实时查询 |

推荐架构：

1. 使用 OJP 2.0 做用户输入阶段的站点搜索和连接搜索。
2. 用户选择一个连接后，把 OJP 返回的停站、时间、运营商、车次、几何保存到自己的数据库。
3. 如果旅程日期是瑞士/欧洲“当天”，再用 Formation API 查询车厢编组，并把结果归档到自己的数据库。
4. 如果以后做实时面板，再用 GTFS Static + GTFS-RT 组合显示延误和告警。

## 2. Token、鉴权和环境变量

每个 API 产品通常需要单独申请访问权限。API Manager 页面会显示：

- `TOKEN`
- `TOKEN HASH`

实际调用接口时只用 `TOKEN`。`TOKEN HASH` 不放进代码，也不放进 HTTP header。

通用 HTTP header：

```http
Authorization: Bearer <TOKEN>
User-Agent: your-app-name/your-version
```

不同 API 的额外 header：

| API | Content-Type / Accept |
| --- | --- |
| OJP 2.0 | `Content-Type: application/xml` |
| Formation | `Accept: application/json` |
| GTFS-RT Protobuf | `Accept: application/x-protobuf` |
| GTFS-RT 调试 JSON | `Accept: application/json` |

推荐环境变量：

```bash
# OJP 2.0: station search, trip search, stop sequence, leg geometry
SWISS_OPEN_DATA_API_KEY=...
SWISS_OPEN_DATA_OJP_ENDPOINT=https://api.opentransportdata.swiss/ojp20
SWISS_OPEN_DATA_REQUESTOR_REF=your_app_prod
SWISS_OPEN_DATA_USER_AGENT=your-app/1.0

# Train Formation: coach order and platform sectors
SWISS_TRAIN_FORMATION_API_KEY=...
SWISS_TRAIN_FORMATION_API_BASE_URL=https://api.opentransportdata.swiss/formation
SWISS_TRAIN_FORMATION_FULL_PATH=/v2/formations_full
SWISS_TRAIN_FORMATION_USER_AGENT=your-app/1.0

# GTFS Realtime Trip Updates
SWISS_GTFS_RT_API_KEY=...
SWISS_GTFS_RT_API_URL=https://api.opentransportdata.swiss/la/gtfs-rt
SWISS_GTFS_RT_USER_AGENT=your-app/1.0

# GTFS Realtime Service Alerts
SWISS_GTFS_SA_API_KEY=...
SWISS_GTFS_SA_API_URL=https://api.opentransportdata.swiss/la/gtfs-sa
SWISS_GTFS_SA_USER_AGENT=your-app/1.0
```

注意：

- `SWISS_OPEN_DATA_REQUESTOR_REF` 是 OJP/SIRI XML 里的字段，不是 HTTP header。
- Formation 和 GTFS-RT 不需要 `RequestorRef`。
- 不要把 token 暴露到浏览器端。所有 API 调用都应该由自己的服务器代理。
- 发生错误时可以记录 endpoint、HTTP status、请求类型和响应片段，但不能记录 token。

## 3. 时间处理：一定要区分本地时间和 UTC

OJP 的 `DepArrTime` 可以带 `Z`。一旦带 `Z`，它就是 UTC 时间，不是瑞士当地时间。

用户界面里推荐这样处理：

1. 用户输入的日期和时间按 `Europe/Zurich` 理解。
2. 服务端把 `Europe/Zurich` 本地时间转换成 UTC ISO。
3. 发给 OJP 的 `DepArrTime` 用 UTC 且带 `Z`。
4. 展示 OJP 返回时间时再转回列车运行地的当地时间，通常也是 `Europe/Zurich` / 欧洲时间。

例子：

```ts
// 用户在欧洲夏令时日期输入：
// 2026-04-28 13:00 Europe/Zurich

// 发给 OJP 时应该是：
const depArrTime = "2026-04-28T11:00:00Z";
```

如果错误地发送 `2026-04-28T13:00:00Z`，实际查询会晚两个小时。

## 4. OJP 2.0 LocationInformationRequest：站点搜索

LocationInformationRequest 用于搜索站点、地址、POI 等。铁路应用里通常只搜索 `stop`。

### 4.1 请求结构

OJP 2.0 的 XML namespace 很重要。不要混用 OJP 1.0 的元素。

正确请求示例：

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

关键字段：

| 字段 | 含义 | 建议用法 |
| --- | --- | --- |
| `siri:RequestTimestamp` | 请求时间，UTC | 服务端生成，用于排查 |
| `siri:RequestorRef` | 应用标识 | 用环境变量配置 |
| `siri:MessageIdentifier` | 单次请求 ID | 用 UUID |
| `InitialInput/Name` | 用户输入的站名 | 自动补全搜索词 |
| `Restrictions/Type` | 搜索对象类型 | 铁路站点用 `stop` |
| `Restrictions/NumberOfResults` | 返回数量 | 8-12 通常足够 |
| `Restrictions/IncludePtModes` | 是否返回交通模式 | 可用于 rail-first 筛选 |

错误示例：

```xml
<ojp:InitialInput>
  <ojp:LocationName>Zürich HB</ojp:LocationName>
</ojp:InitialInput>
```

这是 OJP 1.0 / 旧结构风格，在 OJP 2.0 下容易导致 HTTP 400。

### 4.2 响应字段如何使用

典型响应里每个结果是一个 `PlaceResult`。

建议映射：

| OJP 字段 | 含义 | 内部字段 |
| --- | --- | --- |
| `PlaceResult/Probability` | 匹配概率 | `confidence` |
| `PlaceResult/Complete` | 匹配是否完整 | `complete` |
| `Place/Name/Text` | 展示名称 | `station.name` 首选 |
| `Place/StopPlace/StopPlaceRef` | 车站/站点引用，可能是 UIC/BPUIC 或 SLOID | `station.id` |
| `Place/StopPlace/StopPlaceName/Text` | 官方站名 | `station.officialName` |
| `Place/GeoPosition/siri:Longitude` | WGS84 经度 | `station.lng` |
| `Place/GeoPosition/siri:Latitude` | WGS84 纬度 | `station.lat` |
| `Place/Mode/PtMode` | 交通模式 | `station.modes[]` |

推荐内部 JSON：

```ts
type StationSearchResult = {
  provider: "swiss_open_data_ojp";
  id: string;              // StopPlaceRef 优先
  name: string;            // UI 显示名
  officialName?: string;
  countryCode?: string;
  longitude?: number;
  latitude?: number;
  modes?: string[];
  probability?: number;
  complete?: boolean;
  rawPlace?: unknown;      // 可选：保存原始结果片段用于排查
};
```

国家代码可以从 ID 粗略推断：

| ID 特征 | 国家 |
| --- | --- |
| `ch:*` SLOID | CH |
| UIC/BPUIC `85...` | Switzerland |
| UIC/BPUIC `83...` | Italy |
| UIC/BPUIC `80...` | Germany |
| UIC/BPUIC `81...` | Austria |
| UIC/BPUIC `87...` | France |
| UIC/BPUIC `84...` | Netherlands |
| UIC/BPUIC `88...` | Belgium |

这个推断只适合 UI 辅助，不应该作为权威地理边界。

### 4.3 站点搜索实现建议

- 前端输入框 debounce，但不要每个字符都打 API。
- 搜索按钮或输入停顿后再请求自己的后端。
- 后端请求 OJP，并把结果标准化成自己的 JSON。
- UI 里让用户选择一个明确站点，不要只保存文本。
- 创建 Trip 时使用 `StopPlaceRef`；如果没有 ref，才 fallback 到坐标。

## 5. OJP 2.0 TripRequest：连接搜索、停站和线路几何

TripRequest 是 Add Trip 的核心。它可以返回：

- 多个连接方案。
- 每个方案的开始/结束时间。
- 换乘次数。
- 每个 TimedLeg 的车次、运营商、停靠站。
- 每个 TimedLeg 的投影几何或 track sections。

### 5.1 请求结构

示例：从 Zürich HB 到 Milano Centrale，按出发时间搜索。

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
            <Name>
              <Text>Zürich HB</Text>
            </Name>
          </PlaceRef>
          <DepArrTime>2026-04-29T08:00:00Z</DepArrTime>
        </Origin>
        <Destination>
          <PlaceRef>
            <StopPlaceRef>8301700</StopPlaceRef>
            <Name>
              <Text>Milano Centrale</Text>
            </Name>
          </PlaceRef>
        </Destination>
        <Params>
          <NumberOfResults>6</NumberOfResults>
          <IncludeIntermediateStops>true</IncludeIntermediateStops>
          <IncludeLegProjection>true</IncludeLegProjection>
          <IncludeTrackSections>true</IncludeTrackSections>
        </Params>
      </OJPTripRequest>
    </siri:ServiceRequest>
  </OJPRequest>
</OJP>
```

关键字段：

| 字段 | 含义 | 建议 |
| --- | --- | --- |
| `Origin/PlaceRef/StopPlaceRef` | 起点站 ref | 优先使用站点搜索拿到的 ID |
| `Origin/DepArrTime` | 出发或到达时间 | 出发搜索时放在 Origin |
| `Destination/PlaceRef/StopPlaceRef` | 终点站 ref | 同上 |
| `Params/NumberOfResults` | 返回方案数量 | 4-8 |
| `Params/IncludeIntermediateStops` | 返回中间停站 | 必须开 |
| `Params/IncludeLegProjection` | 返回 leg 几何投影 | 必须开 |
| `Params/IncludeTrackSections` | 返回 track sections | 推荐开 |

### 5.2 PlaceRef 选择

如果有站点 ID：

```xml
<PlaceRef>
  <StopPlaceRef>8503000</StopPlaceRef>
  <Name>
    <Text>Zürich HB</Text>
  </Name>
</PlaceRef>
```

如果没有站点 ID，但有坐标：

```xml
<PlaceRef>
  <GeoPosition>
    <siri:Longitude>8.5402</siri:Longitude>
    <siri:Latitude>47.3782</siri:Latitude>
  </GeoPosition>
  <Name>
    <Text>Zürich HB</Text>
  </Name>
</PlaceRef>
```

不要在 OJP 2.0 TripRequest 里使用旧的 `LocationName`。

### 5.3 响应中的连接方案

OJP 返回的每个 `TripResult` 可以标准化为一个 connection option。

推荐内部 JSON：

```ts
type OjpConnectionOption = {
  provider: "swiss_open_data_ojp";
  id: string;
  departureAt: string;        // ISO
  arrivalAt: string;          // ISO
  durationMinutes: number;
  transferCount: number;
  isDirect: boolean;
  operatorName?: string;
  operatorRefs: string[];
  trainCode?: string;         // e.g. EC 33, IC3 577
  productCategory?: string;   // EC, IC, IR, S, RE...
  stops: OjpStop[];
  routeSegments: OjpRouteSegment[];
  rawTripResult?: unknown;
};
```

推荐 UI 展示：

- `10:38 - 15:17`
- `4 h 39 min`
- `direct` 或 `1 transfer`
- `6 stops`
- `EC 33`
- `Swiss Federal Railways SBB`

### 5.4 TimedLeg：每段列车

换乘路线不是一条连续的“单车次路线”。OJP 里通常是多个 `TimedLeg`：

```ts
type OjpRouteSegment = {
  sequence: number;
  mode: "rail" | "bus" | "tram" | "walk" | "unknown";
  trainCode?: string;
  operatorName?: string;
  operatorRef?: string;
  originName: string;
  destinationName: string;
  departureAt?: string;
  arrivalAt?: string;
  stops: OjpStop[];
  geometry?: GeoJSON.LineString;
};
```

字段使用：

| OJP 字段 | 含义 | 内部字段 |
| --- | --- | --- |
| `Trip/TripLeg/TimedLeg` | 一段有时刻表的公共交通 leg | `routeSegments[]` |
| `LegBoard/StopPointRef` 或 `StopPlaceRef` | 上车点 | segment 起点 |
| `LegAlight/...` | 下车点 | segment 终点 |
| `Service/ProductCategory` | 车种，如 IC/EC/IR | `productCategory` |
| `Service/PublishedLineName/Text` | 线路/车次显示名 | `trainCode` 候选 |
| `Service/TrainNumber` | 车号数字 | Formation 查询需要 |
| `Service/OperatorRef` | 运营商引用 | operator 映射 |
| `Service/OperatorName/Text` | 运营商名称 | UI 显示首选 |
| `LegTrack/TrackSection` | 线路几何或轨道片段 | geometry |
| `LegProjection` | 投影几何 | geometry |
| `ServiceDeparture/TimetabledTime` | 计划发车 | stop departure |
| `ServiceArrival/TimetabledTime` | 计划到达 | stop arrival |

### 5.5 停站去重：同站换乘不要算两站

换乘时，同一个车站可能出现两次：

- 第一段到达 Olten。
- 第二段从 Olten 出发。

产品展示时应该显示为一个 canonical stop，但仍然保留 segment 边界。

推荐策略：

```ts
function canonicalStopKey(stop: OjpStop): string {
  return stop.stationId || `${stop.name}:${stop.longitude}:${stop.latitude}`;
}
```

当相邻 stop 的 key 相同：

- 合并成一个展示 stop。
- arrivalAt 用前一个 leg 的到达时间。
- departureAt 用后一个 leg 的出发时间。
- 保留 `transfer: true` 和 `transferDurationMinutes`。

### 5.6 路线几何处理

OJP 的几何可能来自：

1. `LegProjection`
2. `TrackSection`
3. 停站坐标 fallback

推荐优先级：

```text
LegProjection / TrackSection geometry
  -> leg stop coordinates
  -> origin/destination straight fallback, marked as inferred
```

不要把 OJP 缺少精确轨迹时的 fallback 误认为真实铁路轨迹。数据库里应该保存 confidence：

```ts
type GeometryConfidence = "exact" | "inferred" | "manual";
```

地图渲染：

- 直达：一条主色路线。
- 换乘：每个 TimedLeg 一个 segment，可使用不同色调。
- 起点/终点：大点 + label。
- 中间站：小点，默认不显示全部 label。
- 保存原始 OJP geometry 和自己生成的 normalized geometry。

## 6. Train Formation Service：车厢编组

Formation API 用于知道“这班车有哪些车厢、车厢顺序、站台扇区、餐车/自行车/无障碍信息”。

### 6.1 什么时候调用

只有当你已经知道以下信息时才调用：

- EVU：铁路运营企业代码，例如 `SBBP`
- operationDate：运行日期，例如 `2026-04-29`
- trainNumber：纯数字车号，例如 `33`，不要带 `EC`

Formation 不负责搜索路线。

### 6.2 Endpoint

Base URL：

```text
https://api.opentransportdata.swiss/formation
```

推荐用于 UI 和归档的 endpoint：

```text
GET /v2/formations_full?evu=SBBP&operationDate=2026-04-29&trainNumber=33
```

完整 curl：

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_TRAIN_FORMATION_API_KEY" \
  -H "Accept: application/json" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/formation/v2/formations_full?evu=SBBP&operationDate=2026-04-29&trainNumber=33"
```

浏览器地址栏不能直接测试，因为地址栏不会自动带 `Authorization: Bearer ...`。

主要 endpoint：

| Endpoint | 返回视角 | 用途 |
| --- | --- | --- |
| `/v2/formations_stop_based` | 每个停靠站 -> compact formation string | 快速画站台扇区 |
| `/v2/formations_vehicle_based` | 每辆车 -> 车辆属性和各站位置 | 车辆明细、座位、无障碍 |
| `/v2/formations_full` | 两者都有 | 最适合 UI 和归档 |
| `/v2/health` | 健康检查 | 监控 |

官方公开支持的 EVU 可能包括：

```text
BLSP, SBBP, MBC, OeBB, RhB, SOB, THURBO, TPF, TRN, VDBB, ZB
```

这不是所有欧洲运营商。跨国列车通常仍可能用 `SBBP` 返回瑞士境内编组数据，但国外站台扇区信息可能为空。

### 6.3 可用性和持久化策略

Formation 数据尤其依赖 CUS 实时系统：

- 当天数据最可靠。
- 部分未来日期可能有车辆数据，但站台扇区可能不完整。
- 历史日期通常不应该再请求官方 API。
- 成功拿到后应该保存到自己的数据库。

推荐策略：

1. 创建当天旅程时自动请求 Formation。
2. 请求成功就把原始 JSON 和 normalized summary 一起保存。
3. 非当天旅程不自动请求 Formation，只显示“live formation only available on operating day”。
4. 已保存的历史 Formation 永久显示，不依赖官方 API 是否还保留历史数据。
5. 页面渲染时动态 normalize 旧数据，让旧旅程能获得新版 UI。

### 6.4 formations_full 顶层 JSON

概念结构：

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

字段说明：

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `lastUpdate` | 上游最后更新时间 | 诊断、显示“数据更新时间” |
| `journeyMetaInformation.SJYID` | Swiss Journey ID | 高级关联，可选 |
| `journeyMetaInformation.operationDate` | 运行日期 | 归档元数据 |
| `trainMetaInformation.trainNumber` | 车号数字 | 与 OJP trainNumber 对齐 |
| `trainMetaInformation.toCode` | 运输企业/技术代码 | 诊断 |
| `trainMetaInformation.runs` | 运行状态 | 不是 `J` 时提示 |
| `formationsAtScheduledStops` | 按停靠站组织的编组 | 站台扇区车厢图 |
| `formations` | 按车辆组织的明细 | 座位、EVN、功能图标 |
| `relationships` | 前后续、合并、分离关系 | 高级诊断 |

`runs` 常见值：

| 值 | 含义 |
| --- | --- |
| `J` | 运行 |
| `N` | 不运行 |
| `T` | 部分运行 |
| `L` | 删除/无运行记录，需诊断 |

### 6.5 stop-based：formationsAtScheduledStops

stop-based 数据告诉你“这班车在某个停靠站的站台扇区如何排列”。

示例：

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

字段说明：

| 字段 | 含义 | UI 用法 |
| --- | --- | --- |
| `scheduledStop.stopPoint.uic` | 车站 UIC | 与 OJP 停站匹配 |
| `scheduledStop.stopPoint.name` | 车站名 | stop selector |
| `scheduledStop.stopTime.arrivalTime` | 到达时间 | 转本地时间显示 |
| `scheduledStop.stopTime.departureTime` | 发车时间 | 转本地时间显示 |
| `scheduledStop.track` | 站台/股道 | `track 7` |
| `scheduledStop.stopModifications` | 停靠/站台/编组变化位 | 诊断或提醒 |
| `scheduledStop.stopType` | 停靠类型 | 是否正常停车 |
| `formationShort.formationShortString` | CUS 编组短字符串 | 解析成车厢图 |
| `formationShort.vehicleGoals` | 车辆组目的地 | 分段车厢/直通车厢提示 |

`stopType` 常见值：

| 值 | 含义 |
| --- | --- |
| `H` | 正常停靠 |
| `D` | 通过不停 |
| `A` | 只下不上 |
| `E` | 只上不下 |
| `B` | request stop |
| `-H` | operational stop |
| `+H`, `+A`, `+D` | 非计划变体 |

### 6.6 vehicle-based：formations[].formationVehicles

vehicle-based 数据告诉你“每辆车厢的属性是什么、在哪些站对应哪些扇区”。

示例：

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

字段说明：

| 字段 | 含义 | UI 用法 |
| --- | --- | --- |
| `position` | 编组中的物理顺序 | 排序 |
| `number` | 乘客看到的车厢号/订座号 | 车厢卡片主编号 |
| `vehicleIdentifier.typeCode` | 车辆类型代码 | 技术诊断 |
| `vehicleIdentifier.typeCodeName` | 车辆类型名，如 Apm/Bpm | 车厢副标题 |
| `vehicleIdentifier.evn` | European Vehicle Number | 技术细节折叠显示 |
| `vehicleIdentifier.parentEvn` | 组合列车父车辆编号 | 组合单元关联 |
| `formationVehicleAtScheduledStops[].track` | 该车在某站的站台 | stop selector |
| `formationVehicleAtScheduledStops[].sectors` | 该车在某站的扇区 | 站台扇区展示 |
| `formationVehicleAtScheduledStops[].accessToPreviousVehicle` | 是否能通往前一节车 | no-passage 标记 |
| `vehicleProperties.fromStop/toStop` | 该车辆运行区间 | 分离/合并/直通车厢 |
| `number1class`, `number2class` | 一等/二等座数量 | capacity summary |
| `numberBikeHooks` | 自行车位 | bicycle icon |
| `lowFloorTrolley` | 低地板 | low-floor icon |
| `closed` | 车辆关闭 | 不可用样式 |
| `trolleyStatus` | 车辆状态 | 餐车/降级/关闭提示 |
| `accessibilityProperties.numberWheelchairSpaces` | 轮椅位 | wheelchair icon |
| `accessibilityProperties.wheelchairToilet` | 无障碍厕所 | accessibility tooltip |
| `pictoProperties.*` | 官方建议展示的图标 | UI icon |

`trolleyStatus` 常见值：

| 值 | 含义 |
| --- | --- |
| `Normal` | 正常 |
| `GeschlossenTechnisch` | 技术原因关闭 |
| `GeschlossenBetrieblich` | 运营原因关闭 |
| `RestaurantUnbedient` | 餐车未服务 |
| `RestaurantUnbedientDeklassiert` | 餐车未服务且降级/开放等级变化 |
| `Deklassiert` | 降级，等级限制变化 |

### 6.7 formationShortString：CUS 短字符串

`formationShortString` 是 Formation 最难读但最适合画站台车厢图的字段。

例子：

```text
@A,F,F@B,[(LK,2:18,2#BHP;KW;NF,W2:14,1:13,:12,LK)]@C,X
```

解析规则：

| Token | 含义 | UI 建议 |
| --- | --- | --- |
| `@A` 到 `@Z` | 站台扇区 | 后续车辆归入该 sector |
| `[` 和 `]` | 当前运行列车车辆组边界 | 主车厢图只显示组内车辆 |
| `(` 和 `)` | 与相邻车辆不可贯通 | 显示 no passage |
| `-` | 车辆关闭 | 标记 closed |
| `>` | 车辆组从此开始 | 诊断信息 |
| `=` | reserved partly for through groups | 诊断信息 |
| `%` | 餐车开放但未服务 | restaurant unavailable |
| `1` | 一等座车厢 | `1 Class` |
| `2` | 二等座车厢 | `2 Class` |
| `12` | 一/二等混合车厢 | `1/2 Class` |
| `CC` | couchette car | 卧铺/夜车 |
| `FA` | family coach | family icon |
| `WL` | sleeping car | sleeper |
| `WR` | restaurant car | dining |
| `W1` | 餐车 + 一等座 | dining + 1st class |
| `W2` | 餐车 + 二等座 | dining + 2nd class |
| `LK` | 机车/牵引单元 | 默认不进乘客车厢图 |
| `D` | baggage car | baggage |
| `F` | fictitious filler / 站台占位 | 主 UI 隐藏 |
| `K` | classless vehicle | 特殊车厢 |
| `X` | 停放/非运行车辆 | 主 UI 隐藏 |
| `2:18` | 二等车厢，显示车厢号 18 | 卡片显示 Coach 18 / 2 Class |
| `:12` | 继承前一个真实车辆类型，显示号 12 | 避免当 unknown |
| `2#BHP;KW;NF` | 二等车厢，带服务代码 | 解析服务图标 |

服务代码：

| Code | 含义 | UI 图标 |
| --- | --- | --- |
| `BHP` | wheelchair spaces | 轮椅 |
| `BZ` | business zone | 商务区 |
| `FZ` | family zone | 家庭区 |
| `KW` | pram/stroller platform | 婴儿车 |
| `NF` | low-floor access | 低地板 |
| `VH` | bicycle hooks/platform | 自行车 |
| `VR` | bicycle hooks/platform with reservation | 自行车 + 需预约 |

推荐 UI 算法：

1. 选择用户当前关注的停靠站。
2. 读取该 stop 的 `formationShortString`。
3. 解析 sector、车辆 token、服务代码。
4. 默认隐藏 `F`、`X`、`LK`，除非用户打开技术诊断。
5. 用 short string 决定车辆顺序和站台扇区。
6. 用 vehicle-based 数据补充座位数、低地板、自行车、轮椅、EVN。
7. 原始 CUS string 放到折叠诊断区，不直接给普通用户看。

## 7. GTFS Static：本地基础数据

GTFS Static 是 ZIP 包，内部是一组 CSV 文件。它不适合直接做实时路线搜索，但很适合作为本地数据底座。

重要文件：

| 文件 | 关键字段 | 用途 |
| --- | --- | --- |
| `agency.txt` | `agency_id`, `agency_name`, `agency_url`, `agency_timezone` | 运营商名称 |
| `stops.txt` | `stop_id`, `stop_name`, `stop_lat`, `stop_lon`, `parent_station`, `platform_code` | 站点数据库 |
| `routes.txt` | `route_id`, `agency_id`, `route_short_name`, `route_long_name`, `route_type` | 线路信息 |
| `trips.txt` | `trip_id`, `route_id`, `service_id`, `trip_headsign`, `direction_id`, `shape_id` | 班次实体 |
| `stop_times.txt` | `trip_id`, `arrival_time`, `departure_time`, `stop_id`, `stop_sequence` | 停站顺序 |
| `calendar.txt` | 周一到周日运行规则 | 基础运行日 |
| `calendar_dates.txt` | 增开/停运例外 | 精确日期有效性 |
| `shapes.txt` | `shape_id`, `shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence` | 计划线路几何 |
| `transfers.txt` | 换乘规则 | 换乘提示 |
| `feed_info.txt` | feed 版本和元信息 | 匹配 GTFS-RT |

使用场景：

- 本地站点搜索缓存。
- operator / route / stop ID 映射。
- GTFS-RT 的 `trip_id`、`route_id`、`stop_id` 解释。
- 使用 `shapes.txt` 补充线路几何。

重要规则：

- GTFS Static ID 可能随 feed 版本变化。
- GTFS-RT 必须和对应版本的 GTFS Static 一起解释。
- 不要拿旧版 static 强行匹配新版 realtime。

## 8. GTFS-RT Trip Updates：延误和取消

GTFS-RT 是 Protobuf feed。JSON 更多用于调试。

调试 JSON 请求：

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_GTFS_RT_API_KEY" \
  -H "Accept: application/json" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON"
```

生产 Protobuf 请求：

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_GTFS_RT_API_KEY" \
  -H "Accept: application/x-protobuf" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/la/gtfs-rt"
```

概念 JSON：

```json
{
  "header": {
    "gtfsRealtimeVersion": "1.0",
    "incrementality": "FULL_DATASET",
    "timestamp": 1777454500,
    "feedVersion": "20260429"
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

字段说明：

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `header.gtfsRealtimeVersion` | GTFS-RT schema 版本 | 诊断 |
| `header.incrementality` | 全量或增量 | 通常按 full dataset 处理 |
| `header.timestamp` | feed 生成 Unix 时间 | 判断数据是否过期 |
| `header.feedVersion` | 对应 GTFS Static 版本 | 加载正确 static |
| `entity.id` | feed entity ID | 去重 |
| `entity.isDeleted` | 是否删除 | 从缓存移除 |
| `tripUpdate.trip.tripId` | GTFS trip ID | 匹配 `trips.txt` |
| `tripUpdate.trip.routeId` | GTFS route ID | 匹配 `routes.txt` |
| `tripUpdate.trip.startDate` | 服务日期 `YYYYMMDD` | 匹配运行日 |
| `tripUpdate.trip.startTime` | 计划起始时间 | 匹配具体班次 |
| `tripUpdate.trip.scheduleRelationship` | SCHEDULED/ADDED/CANCELED 等 | 状态 badge |
| `stopTimeUpdate[].stopSequence` | 停站序号 | 匹配 stop_times |
| `stopTimeUpdate[].stopId` | GTFS stop ID | 匹配 stops |
| `arrival.time` / `departure.time` | Unix timestamp | 预计到发 |
| `arrival.delay` / `departure.delay` | 延误秒数 | 延误显示 |
| `stopTimeUpdate[].scheduleRelationship` | 单站状态 | skipped/no-data |

推荐使用：

1. 下载并保存 GTFS Static feed。
2. 按安全频率轮询 GTFS-RT。
3. 解析 Protobuf。
4. 检查 feed version 是否匹配本地 GTFS Static。
5. 根据 trip_id + service date + stop_sequence 关联。
6. 只作为实时 overlay，不覆盖用户已归档的历史旅程。

## 9. GTFS-RT Service Alerts：运行告警

Service Alerts 也是 GTFS-RT Protobuf。它回答的是“哪里受到影响”，不是“如何规划路线”。

调试 JSON：

```bash
curl -L \
  -H "Authorization: Bearer $SWISS_GTFS_SA_API_KEY" \
  -H "Accept: application/json" \
  -H "User-Agent: your-app/1.0" \
  "https://api.opentransportdata.swiss/la/gtfs-sa?format=JSON"
```

概念 JSON：

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
        "url": { "translation": [{ "language": "de", "text": "https://..." }] },
        "headerText": { "translation": [{ "language": "de", "text": "..." }] },
        "descriptionText": { "translation": [{ "language": "de", "text": "..." }] }
      }
    }
  ]
}
```

字段说明：

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `activePeriod.start/end` | 告警有效期 | 只显示相关时间范围 |
| `informedEntity.routeId` | 受影响线路 | 线路级 alert |
| `informedEntity.stopId` | 受影响站点 | 车站级 alert |
| `informedEntity.trip.tripId` | 受影响班次 | 车次级 alert |
| `cause` | 原因类别 | icon / 分类 |
| `effect` | 影响类型 | severity |
| `headerText.translation[]` | 多语言标题 | UI 标题 |
| `descriptionText.translation[]` | 多语言详情 | 详情页 |
| `url.translation[]` | 更多信息链接 | 外链 |

语言 fallback：

1. 用户界面语言。
2. 德语。
3. 法语。
4. 意大利语。
5. 第一条可用 translation。

## 10. Operator / EVU / 企业名称映射

OJP 和 Formation 里可能出现几类运营商标识：

- `OperatorName/Text`：最适合直接显示。
- `OperatorRef`：需要映射到名称。
- Formation 的 `evu`：例如 `SBBP`。
- GTFS Static 的 `agency_id`。

推荐策略：

1. OJP 连接结果里如果有 `OperatorName/Text`，直接保存。
2. 如果只有 `OperatorRef`，用本地 operator dictionary 映射。
3. Formation 查询使用 EVU，不直接用展示名称。
4. 保存 trip 时同时保存：
   - `operatorRef`
   - `operatorName`
   - `evu`
   - `raw service/operator payload`

示例内部结构：

```ts
type OperatorRecord = {
  id: string;
  provider: "ojp" | "formation" | "gtfs" | "manual";
  ref: string;
  name: string;
  shortName?: string;
  countryCode?: string;
  raw?: unknown;
};
```

## 11. 推荐数据库 / 数据结构

给另一个网站接入时，不要只存官方原始响应，也不要只存 UI 字符串。推荐同时保存 normalized 数据和 raw provider data。

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
  operatorRef?: string;
  trainCode?: string;
  trainNumber?: string;
  transferCount: number;
  stops: TripStop[];
  routeSegments: RouteSegment[];
  geometry?: GeoJSON.LineString;
  geometryConfidence: "exact" | "inferred" | "manual";
  rawProviderSummary?: unknown;
};

type TripStop = {
  stationId?: string;
  stationName: string;
  countryCode?: string;
  coordinates?: [number, number];
  sequence: number;
  arrivalAt?: string;
  departureAt?: string;
  platform?: string;
  transfer?: boolean;
};

type RouteSegment = {
  sequence: number;
  mode: "rail" | "walk" | "bus" | "tram" | "unknown";
  trainCode?: string;
  trainNumber?: string;
  operatorName?: string;
  operatorRef?: string;
  departureAt?: string;
  arrivalAt?: string;
  stops: TripStop[];
  geometry?: GeoJSON.LineString;
};

type TrainFormationArchive = {
  schemaVersion: number;
  provider: "swiss_train_formation";
  requestedAt: string;
  operationDate: string;
  operationDatePolicy: "same-day-live";
  archived: boolean;
  evu: string;
  trainNumber: string;
  status: "available" | "unavailable" | "failed";
  summary?: unknown;
  rawPayload?: unknown;
  errorMessage?: string;
};
```

## 12. 端到端流程：Add Trip

推荐流程：

1. 用户打开 Add Trip。
2. 默认日期和时间取 `Europe/Zurich` 当前时间。
3. 用户搜索起点站。
4. 后端调用 OJP LocationInformationRequest。
5. UI 展示站点候选，用户选择具体站点。
6. 用户搜索终点站，同样选择具体站点。
7. 用户点击 Find connections。
8. 后端把本地时间转 UTC，调用 OJP TripRequest。
9. 后端标准化 TripResult：
   - departureAt / arrivalAt
   - duration
   - transferCount
   - trainCode
   - operatorName
   - stop sequence
   - routeSegments
   - geometry
10. UI 显示连接列表和地图预览。
11. 用户选择连接。
12. 用户点击 Create trip。
13. 后端写入 trips、trip_stops、trip_geometries。
14. 如果是当天且可以推断 EVU/trainNumber，调用 Formation。
15. Formation 成功则写入 trip 的 raw JSON archive。
16. Trip detail 页面使用保存的数据渲染，不再依赖临时 API 响应。

## 13. 常见错误和排查

### OJP HTTP 400

常见原因：

- XML namespace 错。
- 使用了 OJP 1.0 的 `LocationName`。
- `DepArrTime` 格式不正确。
- `StopPlaceRef` 放错位置。
- XML 未 escape 用户输入。

排查建议：

- 日志记录 request kind：`station_search` / `trip_search`。
- 日志记录 HTTP status。
- 日志记录响应 body 的短片段。
- 不记录 token。
- 用官方示例 XML 对比结构。

### OJP 搜索时间差两个小时

原因：

- 把 Europe/Zurich 本地时间当 UTC 发给 OJP。

修复：

- 本地日期时间先按 `Europe/Zurich` 解析。
- 转成 UTC `YYYY-MM-DDTHH:mm:ssZ`。

### 换乘时同一站出现两次

原因：

- 到达 leg 和出发 leg 都包含同一个 transfer station。

修复：

- 相邻 stop 用 station ref / 坐标 / 名称做 canonical key。
- 合并展示 stop，但保留 segment 边界。

### Formation 403

常见原因：

- token 没有申请 Train Formation Service 权限。
- endpoint 写成旧路径或不带 `/v2`。
- 直接用浏览器地址栏测试，没有 Bearer header。

正确 endpoint：

```text
https://api.opentransportdata.swiss/formation/v2/formations_full
```

### Formation 没有国外站名或站台

原因：

- Formation 的站台扇区主要来自 CUS/瑞士实时系统。
- 跨境列车国外站点可能没有完整 CUS sector 数据。

处理：

- 用 OJP stop sequence 补站名。
- track / sector 显示 unavailable。
- 不要伪造国外站台信息。

### GTFS-RT 匹配不上

原因：

- 缺少对应版本 GTFS Static。
- `trip_id` / `stop_id` 随 feed 版本变化。

修复：

- 存 `feedVersion`。
- 下载匹配的 GTFS Static。
- 以 static feed 为基础解释 realtime。

## 14. trainmap 的经验结论

1. OJP 是路线和时刻表 API，不是车厢编组 API。
2. Formation 是车厢 API，不是路线 API。
3. GTFS-RT 是实时 overlay，不应该覆盖个人历史档案。
4. 所有 provider 数据都要先标准化，再进入 UI。
5. raw payload 要保存，用于以后升级 normalizer。
6. Formation 数据要当天查询并自己归档。
7. 地图路线、站点、标签要作为业务图层管理，不要依赖 basemap。
8. 时间必须明确 timezone，尤其是夏令时。
9. Token hash 不用于 API 调用。
10. 跨境数据要接受“部分字段缺失”，但不能丢掉可用的 stop sequence 和 geometry。

## 15. BelloTreno 当前实现补充（2026-05）

BelloTreno 当前上线版本只把 Swiss OpenTransportData 用作实时编组和跨境补全，不把它做成完整瑞士路线规划器：

- 车次详情使用 Train Formation Service；OJP 仍保留为未来行程规划或更完整路线几何的候选方案。
- Cloudflare Pages Function 从 `SWISS_TRAIN_FORMATION_API_KEY` 读取 token，并在服务端请求 `formation/v2/formations_full`，前端不会接触 token。
- 只对当天 `Europe/Zurich` operation date 自动查询；查询失败、无数据或不支持时，页面必须完全回退 ViaggiaTreno。
- 车辆去重以 EVN 为第一优先级。同一个 EVN 在不同运行区间出现多次时，应合并为同一辆车，并保留多个 `segments`。
- `closed`、`vehicleWillBePutAway`、`trolleyStatus` 是分段状态，不能跨所有区间做全局 OR 合并；UI 应按当前选中停站解析有效区间。
- `accessToPreviousVehicle=false` 只表示与前一辆车不可贯通，不等于车辆关闭，也不应触发置灰。
- Coach 区域以标准化后的车辆列表保证稳定身份和车辆详情，当前选中停站只负责提供 track、sector 和 no-passage 展示。
- 扇区标签需要标准化，并以站台视角从 A 开始显示。ETR 610 通常按 7 节一组、RABe 501/Giruno 通常按 11 节一组处理，避免 provider 重复 position 造成重联车辆交错。
- `formationShortString` 可作为停站层面的补充提示，但不能替代 EVN 车辆身份。
- 车站页跨境补全必须保守：只有 ViaggiaTreno 终点/始发为空或明显截断在 Chiasso、Domodossola 等边境站时才替换；不能把正确的意大利终点降级为瑞士边境站。

