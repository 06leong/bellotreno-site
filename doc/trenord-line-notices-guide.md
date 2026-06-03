# Trenord Line Notices Integration Guide

This document describes the Trenord "Traffic info" / "Info linea" integration used by BelloTreno train detail pages. It covers what the feature does, how the data is fetched and normalized, the JSON contract exposed by the site, operational examples, and maintenance notes.

The decryption secret used by the Trenord train BFF is intentionally not included here. It must stay in Cloudflare Pages Secrets as `TRENORD_BFF_SECRET` and must never be committed, printed in documentation, or exposed to browser code.

## 1. Scope and Terminology

Trenord service notices differ from ViaggiaTreno SmartCaring notices.

- **ViaggiaTreno SmartCaring** is queried by train number and is used by BelloTreno for non-Trenord operators through `notify.bellotreno.workers.dev`.
- **Trenord Traffic info** is derived from Trenord's own website data. It is line-corridor level information, not necessarily a notice written only for one train.
- **Direttrice** is Trenord's internal corridor code, such as `D038` or `D014`.
- **Direttrice description** is the user-facing line name, such as `SARONNO-SEREGNO-MILANO-ALBAIRATE`.
- **Notice** means a normalized item from a Trenord direttrice `news[]` entry.

The frontend copy must treat these notices as line notices. Use wording such as:

- `Traffic info · SARONNO-SEREGNO-MILANO-ALBAIRATE`
- `Info linea · SARONNO-SEREGNO-MILANO-ALBAIRATE`

Avoid wording that implies the item is dedicated to the queried train unless the notice description explicitly says so.

## 2. Why BelloTreno Uses a Separate Provider

For FS Group and most Trenitalia-family trains, the existing SmartCaring worker can query:

```text
https://www.viaggiatreno.it/infomobilita/resteasy/news/smartcaring?commercialTrainNumber={trainNumber}
```

Trenord is operationally more independent. ViaggiaTreno can still provide live train details, station stops, platforms, delays, and cancellations for many Trenord services, but its SmartCaring endpoint normally does not return the same "Traffic information" content visible on the Trenord website.

The BelloTreno implementation therefore splits the providers:

- Trenord trains: `codiceCliente === 63` -> `/api/trenord/traffic`
- Other operators: existing SmartCaring worker -> `window.NOTIFY_BASE`

The two providers do not run at the same time for the same train detail page. They both render into `#smartCaringCard`, but the dispatch logic chooses one provider before fetching.

## 3. Implementation Files

The current implementation is spread across these files:

| Path | Responsibility |
| --- | --- |
| `functions/api/trenord/traffic.ts` | Same-origin Cloudflare Pages Function. Fetches Trenord upstreams, decrypts the train BFF payload server-side, caches direttrici, and returns normalized JSON. |
| `src/lib/normalizers/trenord.ts` | Pure normalizer utilities. Extracts train metadata, matches direttrice codes, filters notices, extracts URLs, assigns severity levels, and creates stable IDs. |
| `src/client/main.ts` | Frontend dispatch and rendering. Detects Trenord trains, calls `/api/trenord/traffic`, renders the collapsed Traffic info card, and inserts the Trenord line badge when available. |
| `src/client/config.ts` | Defines `window.TRENORD_TRAFFIC_BASE = "/api/trenord/traffic"`. |
| `src/client/i18n.ts` | Defines localized UI strings for `Traffic info`, `Info linea`, and empty notice states. |
| `src/styles/global.css` | Styles the Traffic info card, notice badges, notice links, and Trenord line badge. |
| `tests/js/normalizers.test.ts` | Unit tests for matching, fallback behavior, URL extraction, sorting, stable IDs, severity mapping, and empty notice handling. |
| `scripts/validate-trenord-traffic.ts` | Optional live validation script. Requires `TRENORD_BFF_SECRET` in the local environment. Run through `tsx`. |

## 4. Runtime Data Flow

```text
Browser train detail page
  |
  | ViaggiaTreno train detail already loaded
  | data.codiceCliente === 63?
  |
  +-- no  -> fetchSmartCaring(trainNumber)
  |         -> notify.bellotreno.workers.dev
  |         -> ViaggiaTreno SmartCaring
  |
  +-- yes -> fetchTrenordTrafficInformation(data)
            -> GET /api/trenord/traffic?train={number}&date={YYYY-MM-DD}
            -> Cloudflare Pages Function
               |
               +-- fetch encrypted train BFF payload
               |   https://www.trenord.it/mia/bff/train/{trainNumber}?date={date}
               |
               +-- decrypt server-side with TRENORD_BFF_SECRET
               |
               +-- fetch and cache direttrici
               |   https://www.trenord.it/mgmt/store-management-api/mia/direttrici/
               |
               +-- normalize train + direttrice notices
            -> Browser renders collapsed Traffic info card
```

The train number alone is not used to decide whether to call the Trenord provider. The primary guard is `codiceCliente === 63` from the ViaggiaTreno train detail payload, with the local client map as a secondary check.

## 5. Pages Function API

### Request

```http
GET /api/trenord/traffic?train=24946&date=2026-05-25
Accept: application/json
```

### Query parameters

| Parameter | Required | Format | Notes |
| --- | --- | --- | --- |
| `train` | yes | digits only | Non-digit characters are stripped before use. |
| `date` | yes | `YYYY-MM-DD` | Operation date used for the Trenord BFF request and notice display window. |

### Response headers

Normal responses use:

```http
content-type: application/json; charset=utf-8
x-content-type-options: nosniff
cache-control: public, max-age=120
```

Provider errors and missing configuration responses use `cache-control: no-store` to avoid caching operational failures.

### Successful response shape

```json
{
  "available": true,
  "trainNumber": "24946",
  "date": "2026-05-25",
  "line": "S9",
  "trainCategory": "S9",
  "trainOperator": "Trenord",
  "direttrice": "D038",
  "direttriceDescription": "SARONNO-SEREGNO-MILANO-ALBAIRATE",
  "direttriceSecurity": "D002",
  "matchSource": "primary-direttrice",
  "notices": [
    {
      "id": "tn-8f9a31c2",
      "source": "trenord-direttrici",
      "direttriceCode": "D038",
      "direttriceDescription": "SARONNO-SEREGNO-MILANO-ALBAIRATE",
      "description": "Example line notice text with a PDF link https://www.trenord.it/example.pdf",
      "date": "2026-05-25T08:00:00.000Z",
      "severityCode": 1,
      "severityDescription": "info",
      "severityLevel": "info",
      "urls": [
        "https://www.trenord.it/example.pdf"
      ]
    }
  ]
}
```

The `id` above is illustrative. Real IDs are generated from a stable hash of:

```text
trainNumber + date + direttriceCode + notice.date + notice.description
```

### Matched line with no displayable recent notices

The provider can match a direttrice but still return an empty `notices` array. This means BelloTreno knows the line corridor, but there are no notices in the display window.

```json
{
  "available": true,
  "trainNumber": "24946",
  "date": "2026-05-25",
  "line": "S9",
  "trainCategory": "S9",
  "trainOperator": "Trenord",
  "direttrice": "D038",
  "direttriceDescription": "SARONNO-SEREGNO-MILANO-ALBAIRATE",
  "direttriceSecurity": "D002",
  "matchSource": "primary-direttrice",
  "notices": []
}
```

The frontend may still render the card title and the empty state: `No Trenord line notices`.

### Unavailable response examples

Missing Pages Secret:

```json
{
  "available": false,
  "reason": "not_configured"
}
```

No usable direttrice in the decrypted train payload:

```json
{
  "available": false,
  "trainNumber": "24946",
  "date": "2026-05-25",
  "line": null,
  "trainCategory": null,
  "trainOperator": null,
  "direttrice": null,
  "direttriceDescription": null,
  "direttriceSecurity": null,
  "matchSource": "none",
  "notices": [],
  "reason": "no_direttrice_in_train_payload"
}
```

Direttrice code present but not found in the direttrici feed:

```json
{
  "available": false,
  "trainNumber": "2237",
  "date": "2026-05-25",
  "line": "RE_6",
  "trainCategory": "RE",
  "trainOperator": "Trenord",
  "direttrice": "D999",
  "direttriceDescription": null,
  "direttriceSecurity": null,
  "matchSource": "none",
  "notices": [],
  "reason": "direttrice_not_found"
}
```

## 6. Upstream Data Sources

### 6.1 Trenord Train BFF

Endpoint pattern:

```text
https://www.trenord.it/mia/bff/train/{trainNumber}?date={YYYY-MM-DD}
```

Example:

```text
https://www.trenord.it/mia/bff/train/24946?date=2026-05-25
```

The response is a binary encrypted payload, not ordinary JSON. The Pages Function reads it as an `arrayBuffer`, decrypts it server-side, and then parses the decrypted JSON.

The implementation sends browser-like headers:

```js
{
  "accept": "application/json, text/plain, */*",
  "referer": "https://www.trenord.it/en/routes-and-timetables/journey/real-time/",
  "user-agent": "Mozilla/5.0"
}
```

The decryption setup is:

- AES-256-ECB
- PKCS7 padding
- Key derived as SHA-256 of `TRENORD_BFF_SECRET`

Only the environment variable name is documented. The value is not a public contract and can change when Trenord updates its frontend bundle or backend behavior.

The decrypted payload can contain more fields than BelloTreno currently needs. The normalizer does not assume a single fixed wrapper. It recursively searches for train-like records and prefers a train record with `direttrice` or `direttrice_security`.

Typical useful fields include:

```json
{
  "journey_list": [
    {
      "train": {
        "train_id": "24946",
        "train_category": "S9",
        "line": "S9",
        "train_operator": "Trenord",
        "direttrice": "D038",
        "direttrice_security": "D002",
        "direction": "Saronno",
        "delay": 1,
        "status": "A"
      },
      "pass_list": []
    }
  ]
}
```

Do not rely on this example as a complete schema. Real payloads may include journey metadata, products, services, stop-level actual data, platform information, cancellation flags, and other fields.

### 6.2 Trenord Direttrici Feed

Endpoint:

```text
https://www.trenord.it/mgmt/store-management-api/mia/direttrici/
```

The response is ordinary JSON and is cacheable. BelloTreno keeps a simple in-memory cache for 2 hours:

```js
const DIRETTRICI_TTL_MS = 2 * 60 * 60 * 1000;
```

Typical object:

```json
{
  "api_src": "centricity",
  "nome": "D014",
  "descrizione": "VERONA-BRESCIA-TREVIGLIO-MILANO",
  "alert": true,
  "severity_code": 1,
  "news": [
    {
      "description": "Example notice text. More information: https://www.trenord.it/example.pdf",
      "date": "2026-05-23T12:00:00.000Z",
      "severity_code": 1,
      "severity_description": "info"
    }
  ]
}
```

The `updatedAt` or `createdAt` fields sometimes found in management payloads should not be interpreted as the notice publication time. Use each `news[].date` instead.

## 7. Matching Rules

The matcher is implemented in `normalizeTrenordTrafficInformation()`.

1. Extract the train information from the decrypted train payload.
2. Read `train.direttrice` as the primary corridor code.
3. Match it against `direttrici[].nome`.
4. Normalize and filter that direttrice's `news[]`.
5. Use `train.direttrice_security` only if:
   - the primary direttrice is missing, or
   - the primary direttrice exists but has no raw `news[]` descriptions, and
   - `direttrice_security` is different from `direttrice`.

This means `direttrice_security` is a fallback, not the primary display source.

Expected match sources:

| `matchSource` | Meaning |
| --- | --- |
| `primary-direttrice` | The result came from `train.direttrice`. |
| `security-direttrice-fallback` | The result came from `train.direttrice_security` because the primary source was unusable. |
| `none` | No matching direttrice could be found. |

## 8. Notice Normalization

Each notice returned to the frontend has this shape:

```json
{
  "id": "tn-8f9a31c2",
  "source": "trenord-direttrici",
  "direttriceCode": "D014",
  "direttriceDescription": "VERONA-BRESCIA-TREVIGLIO-MILANO",
  "description": "Original notice text, not translated by BelloTreno.",
  "date": "2026-05-25T09:00:00.000Z",
  "severityCode": 2,
  "severityDescription": "warning",
  "severityLevel": "warning",
  "urls": []
}
```

Normalization details:

- `description` is kept in the original language from Trenord.
- URLs are extracted from `description`, including PDF URLs and short links.
- Duplicate URLs are removed while preserving order.
- Trailing punctuation after a URL is trimmed.
- Notices are sorted by `date` descending.
- Stable IDs use a deterministic FNV-1a hash and do not require Node's `crypto` module.

Severity mapping:

| Upstream `severity_description` | BelloTreno `severityLevel` |
| --- | --- |
| `critical`, `high`, `disruption` | `disruption` |
| `warning`, `warn` | `warning` |
| anything else, including `info` | `info` |

## 9. Display Window

The line notice feed is broader than one train and can include old notices. BelloTreno applies a compact display rule that mirrors the SmartCaring behavior requested for the train detail page:

1. If any notice has a Europe/Rome date equal to the requested operation date, show only those same-day notices.
2. Otherwise, show notices in the 14-day window ending on the requested operation date.
3. Notices outside that window are not displayed.

Example:

```json
[
  { "id": "old", "date": "2026-04-10T12:00:00.000Z" },
  { "id": "recent", "date": "2026-05-23T12:00:00.000Z" },
  { "id": "today", "date": "2026-05-25T12:00:00.000Z" }
]
```

For operation date `2026-05-25`, only `today` is displayed. If `today` is absent, `recent` is displayed and `old` is filtered out.

## 10. Frontend Behavior

The relevant frontend dispatch is:

```js
function fetchTrafficInformation(data) {
  if (isTrenordTrain(data)) {
    fetchTrenordTrafficInformation(data);
    return;
  }
  fetchSmartCaring(data.numeroTreno);
}
```

`isTrenordTrain(data)` checks:

```js
Number(data?.codiceCliente) === 63
```

and then falls back to the local `CLIENT_MAP` label.

When the provider returns data:

- `currentSmartCaringData` is stored with `provider: "trenord-traffic"`.
- `renderTrenordTrafficInformation()` renders a collapsed card by default.
- The card uses the same `#smartCaringCard` container as SmartCaring, but only one provider writes to it for the current train.
- The title is localized through `trenord_traffic_title`.
- The notice body shows severity, date, original description, and extracted links.
- Empty notices render the localized empty state.

The provider response also supplies `line`, such as `S9`, `RE_80`, `MXP1`, or `MXP2`. When available, the frontend stores it in `currentTrenordLineInfo` and inserts a Trenord line badge next to the train number badge.

## 11. Configuration

Cloudflare Pages needs this secret:

| Variable | Type | Used by | Notes |
| --- | --- | --- | --- |
| `TRENORD_BFF_SECRET` | Secret | `/api/trenord/traffic` | Required to decrypt the Trenord train BFF payload. Do not use a `PUBLIC_` prefix. Do not expose the value to browser code. |

Recommended Pages setup:

1. Add `TRENORD_BFF_SECRET` under Workers and Pages -> the Pages project -> Settings -> Variables and Secrets.
2. Use type **Secret**, not plain text.
3. Add it to both Production and Preview environments if preview deployments need live Trenord validation.
4. Redeploy after adding the secret.

Local live validation can use a temporary shell environment variable. Do not put the value in tracked files.

PowerShell example:

```powershell
$env:TRENORD_BFF_SECRET = "<secret value from your private environment>"
TRENORD_BFF_SECRET="<private secret>" npx tsx scripts/validate-trenord-traffic.ts 24946 2026-05-25
Remove-Item Env:TRENORD_BFF_SECRET
```

The placeholder above is intentional. Do not replace it in committed documentation.

## 12. Error Handling and Troubleshooting

### `available: false`, `reason: "not_configured"`

The Pages Secret is missing in the current Cloudflare Pages environment. This often happens in Preview deployments when the secret was configured only for Production.

Action:

- Add `TRENORD_BFF_SECRET` to the relevant Pages environment.
- Redeploy the preview or production deployment.

### `reason: "bad_request"`

The request is missing a train number or the date is not `YYYY-MM-DD`.

Action:

- Check the generated frontend URL.
- Confirm `getTrainOperationDate()` produced a valid date.

### `reason: "decrypt_failed"` or `reason: "json_parse_failed"`

The encrypted payload could not be decoded with the configured secret and expected algorithm.

Possible causes:

- The secret is wrong in the target environment.
- Trenord changed its frontend bundle secret.
- Trenord changed the encryption algorithm or response format.
- The BFF returned an unexpected body.

Action:

- Validate with `npx tsx scripts/validate-trenord-traffic.ts`.
- Inspect whether Trenord's public website still loads the same train detail.
- Keep the actual secret out of logs and comments.

### `reason: "no_direttrice_in_train_payload"`

The train BFF response decrypted and parsed, but the normalizer could not find `direttrice` or `direttrice_security` in any train-like record.

Possible causes:

- The selected operation date does not expose full Trenord BFF train details.
- The train exists in ViaggiaTreno but Trenord's BFF returns a partial payload.
- Trenord changed the payload structure beyond the current recursive search assumptions.

Action:

- Test the same train and date on Trenord's real-time page.
- Try a known baseline such as `24946` on `2026-05-25` in a private environment.
- If the field moved, update `getTrenordTrainRecord()` / `getTrenordTrainInfo()` in `src/lib/normalizers/trenord.ts`.

### `reason: "direttrice_not_found"`

The train payload included a direttrice code, but the current direttrici feed did not contain a matching `nome`.

Possible causes:

- Trenord renamed, removed, or temporarily omitted a corridor.
- The train BFF and direttrici feed are out of sync.

Action:

- Check the current direttrici feed.
- Avoid falling back to unrelated line names.

### CORS concerns

The browser does not call Trenord directly. It calls the same-origin Pages Function:

```text
/api/trenord/traffic
```

The Pages Function performs upstream fetches server-side. Therefore the common browser CORS problem with direct Trenord calls should not apply to normal site usage.

## 13. Testing

Run the full project checks:

```bash
npm run check
```

The Trenord normalizer tests cover:

- `24946 / 2026-05-25` -> `D038` -> `SARONNO-SEREGNO-MILANO-ALBAIRATE`
- `2634 / 2026-05-25` -> `D014` -> `VERONA-BRESCIA-TREVIGLIO-MILANO`
- Primary `direttrice` priority.
- `direttrice_security` fallback only when the primary source is unusable.
- URL extraction.
- Stable notice IDs.
- Severity mapping.
- Date sorting and 14-day display filtering.
- Empty notices with a matched line.
- Reasons for unavailable results.

Optional live validation:

```bash
TRENORD_BFF_SECRET="<private secret>" npx tsx scripts/validate-trenord-traffic.ts 24946 2026-05-25
TRENORD_BFF_SECRET="<private secret>" npx tsx scripts/validate-trenord-traffic.ts 2634 2026-05-25
```

Do not paste real live validation commands containing the secret into GitHub comments, issue descriptions, documentation, screenshots, or logs.

## 14. Example Use Cases

### S9 service

Request:

```http
GET /api/trenord/traffic?train=24946&date=2026-05-25
```

Expected normalized line identity:

```json
{
  "trainNumber": "24946",
  "date": "2026-05-25",
  "line": "S9",
  "direttrice": "D038",
  "direttriceDescription": "SARONNO-SEREGNO-MILANO-ALBAIRATE",
  "matchSource": "primary-direttrice"
}
```

Frontend title:

```text
Traffic info · SARONNO-SEREGNO-MILANO-ALBAIRATE
```

### Verona - Milano regional service

Request:

```http
GET /api/trenord/traffic?train=2634&date=2026-05-25
```

Expected normalized line identity:

```json
{
  "trainNumber": "2634",
  "date": "2026-05-25",
  "line": "RE",
  "direttrice": "D014",
  "direttriceDescription": "VERONA-BRESCIA-TREVIGLIO-MILANO",
  "matchSource": "primary-direttrice"
}
```

Frontend title:

```text
Traffic info · VERONA-BRESCIA-TREVIGLIO-MILANO
```

### Line badge usage

If the provider returns:

```json
{
  "line": "RE_80"
}
```

the frontend normalizes it to `RE80` for the badge label and color mapping. The Traffic info card still uses the direttrice description for the title because the line badge and line notice title serve different purposes.

## 15. Operational Rules

- Do not call the Trenord provider for non-Trenord trains.
- Do not exclude Trenord inside the SmartCaring worker; the frontend provider split is based on the already-loaded train detail payload.
- Do not expose `TRENORD_BFF_SECRET` to the frontend or commit it to the repository.
- Do not return raw decrypted train payloads by default.
- Do not translate Trenord notice descriptions automatically.
- Do not treat `direttrice_security` as the primary source.
- Do not describe direttrici notices as train-specific unless the text explicitly names that train.
- Keep the provider isolated so it can later be replaced by a documented Trenord API, E015 source, or GTFS-RT ServiceAlerts source.
