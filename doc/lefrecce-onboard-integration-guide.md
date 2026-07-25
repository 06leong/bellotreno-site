# LeFrecce Rolling Stock and Onboard Services Integration

## Purpose

BelloTreno enriches supported Trenitalia long-distance train details with the
scheduled rolling stock and onboard services published by the LeFrecce booking
website. ViaggiaTreno remains the source for the operational timeline and
real-time status.

The browser uses only the same-origin endpoint:

```text
GET /api/trenitalia/onboard
```

It never calls LeFrecce directly. The Pages Function owns the upstream session,
strict train matching, normalization, and caching. Production requests use the
authenticated BelloTreno VPS proxy because the LeFrecce edge can reject
Cloudflare Pages egress with HTTP 403.

## Public request

| Parameter | Required | Meaning |
| --- | --- | --- |
| `number` | yes | Numeric train number, for example `9303` |
| `date` | yes | Operation date as `YYYY-MM-DD` |
| `departureAt` | yes | Planned departure as an ISO 8601 instant |
| `arrivalAt` | no | Planned arrival; additional match constraint |
| `originId` | conditional | ViaggiaTreno station ID such as `S01820` |
| `originName` | conditional | Origin name for station lookup fallback |
| `destinationId` | conditional | ViaggiaTreno station ID such as `S08409` |
| `destinationName` | conditional | Destination name for station lookup fallback |

Each endpoint must have either an ID or a name. The homepage sends both when
available.

```text
/api/trenitalia/onboard?number=9303&date=2026-07-26&departureAt=2026-07-26T04%3A00%3A00.000Z&arrivalAt=2026-07-26T08%3A35%3A00.000Z&originId=S01820&originName=Milano%20Rogoredo&destinationId=S08409&destinationName=Roma%20Termini
```

## Public response

Successful responses are normalized JSON:

```json
{
  "available": true,
  "provider": "trenitalia-lefrecce",
  "trainNumber": "9303",
  "operationDate": "2026-07-26",
  "fetchedAt": "2026-07-25T12:00:00.000Z",
  "rollingStock": {
    "code": "etr-1000",
    "label": "ETR 1000",
    "series": "1000",
    "informationType": "scheduled",
    "evidence": "explicit",
    "rawDescription": "Treno effettuato con ETR 1000"
  },
  "serviceLevels": ["executive", "business", "premium", "standard"],
  "amenities": [
    {
      "code": "wheelchair-accessible",
      "rawDescription": "Treno con carrozza dotata di posto attrezzato e bagno accessibile..."
    },
    {
      "code": "bar",
      "rawDescription": "Treno con servizio bar."
    }
  ],
  "classServices": [
    {
      "code": "executive-meal",
      "rawDescription": "Servizio di ristorazione incluso nel livello Executive"
    },
    {
      "code": "business-welcome",
      "rawDescription": "Servizio di benvenuto nel livello Business"
    },
    {
      "code": "premium-catering",
      "rawDescription": "Ristorazione Premium"
    }
  ],
  "notes": [
    "Per viaggiare con i treni ALTA VELOCITA' FRECCIAROSSA..."
  ]
}
```

`rollingStock` is `null` when LeFrecce does not explicitly publish a model. The
normalizer does not infer ETR 610 or any other model from the train number,
route, operator, or past operation. Known descriptions become stable codes for
the Chinese, English, and Italian UI. Unclassified official descriptions remain
in Italian in `notes` and are displayed inside a collapsed section.

Unavailable enrichment is also a small JSON response:

```json
{
  "available": false,
  "provider": "trenitalia-lefrecce",
  "reason": "solution_not_found"
}
```

The card is fail-open: an unavailable response or network error hides only this
enrichment and never prevents the ViaggiaTreno detail or Swiss formation from
rendering.

The browser response deliberately excludes:

- `WSESSIONID` and every other cookie;
- `cartId`, `solutionId`, and search identifiers;
- fares, inventory, passenger or shopping-cart data;
- upstream base64 service icons;
- solution lists and duplicate stop timelines.

## LeFrecce upstream flow

The implementation lives in:

- `functions/api/trenitalia/onboard.ts`;
- `functions/api/trenitalia/_shared.ts`;
- `src/lib/normalizers/lefrecce.ts`.

The Pages Function performs this sequence:

1. Convert a ViaggiaTreno `Sxxxxx` station code into `83` plus the seven-digit
   zero-padded numeric part. For example, `S01820` becomes `830001820`.
2. If conversion is unavailable, call
   `GET /website/locations/search?name=...&limit=20`. Only one normalized exact
   station-name match is accepted.
3. Call `POST /website/ticket/solutions` with the endpoints, planned departure,
   one adult, a bounded result limit, and no fare optimization.
4. Read `cartId` from JSON and `WSESSIONID` from `Set-Cookie`.
5. Require one solution matching train number, operation date, endpoints, and
   planned timestamps. The departure and arrival tolerance is five minutes, so
   a similarly timed connection containing the requested train does not compete
   with the requested direct service. Multiple exact matches are rejected.
6. Call `GET /website/stops?cartId=...&solutionId=...` with
   `Cookie: WSESSIONID=...`.
7. For multi-train solutions, require one detail segment whose
   `summary.trainInfo.description` matches the requested train number.
8. Parse only explicit rolling-stock and service descriptions and return the
   public normalized contract.

All upstream targets use this base:

```text
https://www.lefrecce.it/Channels.Website.BFF.WEB/website
```

Italian is requested upstream so phrase classification is stable. Calls have an
eight-second timeout and are not retried inside one request. When proxy
configuration is present, the Pages Function wraps each target URL with the
VPS proxy URL. The first `Set-Cookie` response stays server-side; only the
validated `WSESSIONID` value is forwarded to the proxy for the matching stops
request. `WSESSIONID` is treated as an opaque cookie value: punctuation such as
the colon used by some sessions is preserved while every unrelated cookie is
discarded.

## Caching and operations

The Function keeps a bounded in-isolate cache and also uses Cloudflare's
per-data-center Cache API:

- successful enrichment: until the next midnight in `Europe/Rome`;
- unavailable enrichment: approximately 5 minutes.

The cache key includes train number, operation date, planned departure and
arrival, and both endpoints. Concurrent identical misses inside one isolate are
coalesced into one upstream request. A first request routed to another
Cloudflare data center can still perform one upstream lookup because Cache API
entries are edge-local, but repeated same-region queries do not create a new
LeFrecce session for the rest of the Italian calendar day.

Cloudflare Pages should configure the dedicated proxy variables:

```text
TRENITALIA_LEFRECCE_PROXY_BASE_URL=https://api.bellotreno.org/
TRENITALIA_LEFRECCE_PROXY_TOKEN=<same secret as RFI_PROXY_SECURITY_TOKEN>
```

For compatibility, the Function falls back to `RFI_PROXY_BASE_URL` /
`RFI_PROXY_TOKEN`, then `ITALO_PROXY_BASE_URL` / `ITALO_PROXY_TOKEN`. Existing
deployments that already configured the Italo VPS proxy therefore do not need a
second secret.

The integration is enabled by default. This optional Cloudflare Pages variable
is an emergency switch:

```text
TRENITALIA_LEFRECCE_ENABLED=false
```

Only the case-insensitive string `false` disables it. The proxy token is read
only by the Pages Function and must never use a `PUBLIC_*` variable.

## Frontend behavior and photos

`src/client/lefrecce-onboard.ts` queries only `FR`, `FA`, `FB`, `IC`, `ICN`,
`EC`, and `EN`. Italo, Trenord, and regional categories do not call the
endpoint. The card is placed after SmartCaring and before Swiss formation, and
can be collapsed independently. Its header does not repeat the provider name,
and the UI does not add a source footnote beneath the service details.

The onboard icons use the Material Symbols glyph subset declared in
`astro.config.ts`; every emitted icon name must be included there. Swiss
formation remains an independent real-time source.

The typed image manifest expects compressed WebP files at:

```text
public/images/rolling-stock/etr-1000.webp
public/images/rolling-stock/etr-500.webp
public/images/rolling-stock/etr-700.webp
public/images/rolling-stock/etr-600.webp
public/images/rolling-stock/giruno-rabe-501.webp
```

Until a file exists, the local train icon remains visible. Images have explicit
intrinsic dimensions, `object-fit: cover`, lazy loading, and async decoding.
Adding a file at the documented path requires no code change.

## Validation

`tests/js/lefrecce.test.ts` covers FR 9303, FR 9607, FR 9703, FR 9757, EC 301,
EC 141 without an inferred model, station-ID conversion, cookie extraction,
authenticated VPS proxy routing, strict direct-versus-connection matching,
ambiguous matching, unknown notes, and upstream failure.
`tests/python/test_rfi_proxy.py` verifies the restricted LeFrecce allowlist,
POST forwarding, and sanitized session-cookie forwarding, including opaque
values containing a colon.

Before publishing:

```bash
npm run check
npm run build
git status --short
```

After Cloudflare creates the preview deployment, verify the example trains in
all three languages and at desktop/mobile widths.
