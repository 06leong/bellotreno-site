# BelloTreno

BelloTreno is a real-time Italian railway information dashboard. It combines a
static Astro frontend, Cloudflare edge services, a VPS-side realtime-data proxy,
Cloudflare Pages Functions, Italo in Viaggio data, Swiss train formation data,
Trenord line notices, and a separate statistics collector.

Live site: https://bellotreno.org/

`real.bellotreno.org` is kept as a legacy entry point and should redirect to the
main domain.

## 1. Current Feature Snapshot

BelloTreno currently has five main pages:

- `/`: train search, station search, live train details, timeline, SmartCaring
  operating history, Trenord traffic information, and Swiss formation enrichment
  when available. It also supports Italo train-number lookup for confirmed Italo
  services.
- `/station`: Italian station departure and arrival boards, with platform
  changes, weather, delays, cancellations, reroutes, and conservative Swiss
  cross-border endpoint completion. Confirmed Italo station boards are merged
  into matching ViaggiaTreno station pages.
- `/infomobilita`: Trenitalia NewsService infomobility notices by default, with a
  switch back to RFI public travel notices and regional filters.
- `/statistics`: daily observable railway operations, including running trains,
  status distribution, punctuality, categories, train search, station search,
  relation search, ranking, pagination, and CSV links.
- `/about`: project description, data sources, limits, and roadmap.

The main data paths are:

1. **ViaggiaTreno / RFI real-time data**: the browser calls
   `ah.bellotreno.workers.dev`, which forwards through the VPS `rfi-proxy`.
   The VPS uses `curl_cffi` to mimic a browser TLS fingerprint before calling
   the official APIs. This includes train/station data plus the homepage
   `infomobilitaTicker` and Trenitalia `/infomobilita` NewsService feed.
2. **Italo in Viaggio real-time data**: `/api/italo/*` Pages Functions resolve
   confirmed Italo station mappings and call Italo train/station endpoints
   through the VPS proxy when configured.
3. **Swiss OpenTransportData formation data**: a Cloudflare Pages Function reads
   the Train Formation token from Pages Secrets and calls the Swiss upstream
   server-side. The browser never sees the token.
4. **Statistics aggregate data**: `/api/statistics/*` proxies to the VPS
   `bellotreno-statistics` service, currently deployed at
   `https://stats-api.bellotreno.org/v1`. The collector scans station registry
   data, `partenze`/`arrivi` boards, and `andamentoTreno`, then stores SQLite
   and JSON aggregate output.
5. **Trenord line notices**: `/api/trenord/traffic` fetches Trenord train BFF
   data and the `direttrici` feed, maps a train to a line, and returns normalized
   line-level notice data for the collapsed Traffic info card.

Browser cache behavior is controlled by `public/_headers`. HTML entry points are
revalidated, while Astro/Vite bundles browser code into hashed `/_astro/*`
assets so new Cloudflare Pages deployments do not keep using stale scripts.

Optional Umami analytics are injected by `BaseLayout.astro` only when both
`PUBLIC_UMAMI_SCRIPT_URL` and `PUBLIC_UMAMI_WEBSITE_ID` are configured. For
preview validation, `PUBLIC_UMAMI_DOMAINS` should include:

```text
bellotreno.org,real.bellotreno.org,*.bellotreno-site.pages.dev
```

The script is configured with `data-do-not-track` and `data-exclude-search`.

## 2. Overall Architecture

```text
User browser
  |
  | HTTPS
  v
Cloudflare Worker: ah.bellotreno.workers.dev
  - Origin/Referer allowlist
  - Injects X-Bello-Token
  - Manages CORS headers
  |
  | HTTPS with token
  v
Linux VPS: api.bellotreno.org
  - rfi-docker-proxy, Flask + Gunicorn
  - Validates token
  - Allows only approved railway upstream domains
  - Uses curl_cffi browser fingerprint impersonation
  |
  v
ViaggiaTreno / RFI / Italo / Trenord official or passenger-facing APIs
```

```text
User browser
  |
  | SmartCaring lookup
  v
Cloudflare Worker: notify.bellotreno.workers.dev
  - Origin allowlist
  - Calls ViaggiaTreno SmartCaring through the VPS proxy
  - Returns today/recent/history/stats
  - Cache-Control: max-age=120
```

```text
User browser
  |
  | Swiss formation / Statistics / Trenord traffic
  v
Cloudflare Pages Functions: bellotreno.org/api/*
  - /api/swiss/formation
  - /api/statistics/*
  - /api/italo/*
  - /api/trenord/traffic
  - Reads Pages Secrets
  - Does not expose API tokens to browser code
  |
  +--> OpenTransportData.swiss Train Formation API
  +--> VPS statistics API: stats-api.bellotreno.org/v1
  +--> Italo in Viaggio through rfi-proxy when configured
  +--> Trenord upstream BFF and direttrici feeds through rfi-proxy when configured
```

### Official API Constraints

ViaggiaTreno's REST endpoints under
`viaggiatreno.it/infomobilita/resteasy/viaggiatreno/` are public but protected by
WAF behavior that blocks many non-browser clients.

Direct browser `fetch()` calls fail because:

- the official API does not return browser CORS headers;
- common HTTP clients such as Python `requests` or Node `fetch` do not look like
  a real browser at the TLS fingerprint level.

Cloudflare Worker `fetch()` also does not mimic Chrome TLS behavior, so the
project uses a VPS-side `curl_cffi` proxy with browser impersonation.

## 3. Backend: VPS Docker Proxy

The main proxy service lives under `rfi-proxy/`.

| Item | Detail |
| --- | --- |
| Language/framework | Python 3.9 / Flask |
| WSGI server | Gunicorn |
| Core dependency | `curl_cffi` with Chrome impersonation |
| Containerization | Docker + docker compose |
| Internal port | 8080 |
| External domain | `api.bellotreno.org` |

Main request flow:

```text
request -> token validation -> URL extraction -> target host allowlist
        -> curl_cffi browser-like request -> filtered response
```

Important behavior:

- `X-Bello-Token` must match the VPS `SECURITY_TOKEN`.
- Target URLs are restricted to `viaggiatreno.it`, `rfi.it`, `italotreno.com`,
  `trenord.it`, and their subdomains to prevent open-proxy abuse.
- Hop-by-hop headers such as `content-encoding` and `transfer-encoding` are
  filtered before responding.
- The container uses `expose`, not public `ports`; a reverse proxy such as Nginx
  Proxy Manager or Caddy should provide HTTPS externally.

## 4. Backend: Statistics Service

`rfi-proxy/` also contains a separate statistics service. It deploys in the same
compose project but has a different role from the main proxy.

| Item | Detail |
| --- | --- |
| Language/framework | Python 3.11 / Flask |
| WSGI server | Gunicorn, 1 worker + 4 threads by default |
| Internal port | 8081 |
| External domain | `https://stats-api.bellotreno.org/v1` |
| Storage | SQLite + WAL |
| Data volume | `./statistics-data:/data` |
| Auth | `X-Bello-Stats-Token`, injected by Pages Functions |

Collector behavior:

1. Refreshes `elencoStazioni/1..22` to build a station registry.
2. Scans discovered station boards rather than a small seed list.
3. Fetches both `partenze` and `arrivi` when
   `STATISTICS_BOARD_TYPES=partenze,arrivi`.
4. Calls `andamentoTreno` for train details discovered from boards.
5. Stores train, stop, station, relation, ranking, and time-series aggregates.
6. Uses the scheduled collection slot date as the reporting date while keeping
   the original train `service_date`.

Scheduling is slot-based, not "collect then sleep":

- default slots are `HH:05` and `HH:35`;
- an additional Europe/Rome `23:55` end-of-day collection may run;
- all board requests in one collection run use the same logical sampling time;
- overlapping runs are skipped and recorded instead of started twice.

Main APIs:

- `GET /v1/days`
- `GET /v1/summary?date=YYYY-MM-DD`
- `GET /v1/timeseries?date=YYYY-MM-DD`
- `GET /v1/trains?date=&q=&category=&status=`
- `GET /v1/stations/search?q=`
- `GET /v1/stations/{stationCode}?date=YYYY-MM-DD`
- `GET /v1/relations?date=YYYY-MM-DD`
- `GET /v1/ranking?date=YYYY-MM-DD&metric=delay`
- `POST /v1/collect`
- `GET /health`

## 5. Cloudflare Layer

### External Workers

These Workers are not in this repository:

| Worker | Purpose |
| --- | --- |
| `ah.bellotreno.workers.dev` | Main CORS proxy for ViaggiaTreno calls through the VPS proxy |
| `notify.bellotreno.workers.dev` | SmartCaring notification aggregation and cache |
| `site-counter.bellotreno.workers.dev` | Session-deduplicated visitor counter |

The main proxy Worker validates `Origin` or `Referer`, injects `X-Bello-Token`,
forwards to the VPS proxy, and returns browser CORS headers.

### Pages Functions

Pages Functions are in this repo and are written in TypeScript:

| Function | Upstream | Secret/config |
| --- | --- | --- |
| `/api/italo/*` | Italo in Viaggio via VPS proxy | `ITALO_PROXY_BASE_URL`, `ITALO_PROXY_TOKEN` |
| `/api/swiss/formation` | OpenTransportData.swiss `formations_full` | `SWISS_TRAIN_FORMATION_API_KEY` |
| `/api/statistics/*` | VPS statistics API | `STATISTICS_API_BASE_URL`, `STATISTICS_API_TOKEN` |
| `/api/trenord/traffic` | Trenord BFF + direttrici feeds via VPS proxy when configured | `TRENORD_BFF_SECRET`, optional `TRENORD_PROXY_BASE_URL`, `TRENORD_PROXY_TOKEN` |

These functions validate request origin/referer where appropriate and avoid
exposing upstream tokens to browser code.

## 6. Frontend: Astro Static Site

| Item | Detail |
| --- | --- |
| Framework | Astro 6 |
| Language | TypeScript |
| Styling | Tailwind CSS 4 + DaisyUI 5 |
| Build runtime | Node.js 24.11.1+ and npm 11.6.2+ |
| Fonts/icons | Astro Fonts API, including Material Symbols glyph subsetting |
| Deployment | Cloudflare Pages static output + Pages Functions |

### Routes

| Route | Purpose |
| --- | --- |
| `/` | Train search, station search, train detail timeline |
| `/station?id=&name=&type=` | Departure/arrival station boards |
| `/infomobilita` | Trenitalia NewsService infomobility notices and RFI RSS travel notices |
| `/statistics` | Daily railway operating statistics |
| `/about` | Project description |

### Frontend Code Organization

Browser runtime source has moved from uncompiled `public/scripts/*.js` to
Astro/Vite-managed TypeScript modules. `src/client/**/*.ts` is checked with
`strict: true` through `tsconfig.client.json`.

| Module | Responsibility |
| --- | --- |
| `src/client/config.ts` | API base URLs, operator/category maps, badge helper |
| `src/client/i18n.ts` | `zh`, `en`, and `it` translation dictionaries |
| `src/client/common.ts` | language, theme, visitor counter, `escapeHtml`, shared behavior |
| `src/client/main.ts` | homepage search, homepage infomobilita ticker, train details, SmartCaring and Trenord cards |
| `src/client/station.ts` | station departure/arrival boards |
| `src/client/station-navigation.ts` | canonical station-board URL building |
| `src/client/infomobilita.ts` | Trenitalia NewsService and RFI RSS notice page |
| `src/client/statistics.ts` | statistics dashboard, charts, table, pagination, CSV links |
| `src/client/swiss.ts` | Swiss formation fetch/cache, timeline merge, coach strip |
| `src/client/about.ts` | localized About-page static content |
| `src/client/not-found.ts` | 404 terminal theme and device effect |
| `src/client/theme-init-source.ts` | inline-safe theme/language bootstrap source |

`BaseLayout.astro` imports `config.ts`, `i18n.ts`, and `common.ts` first. Page
modules are imported by their owning Astro pages through the `scripts` slot.

Do not put new browser runtime code back under `public/scripts/`.
`npm run check:no-raw-js` enforces that `.js`, `.mjs`, and `.cjs` source files
are not reintroduced outside generated or dependency directories.
Use `npm run smoke:pages` against a local server or a Cloudflare Pages Preview
URL through `SMOKE_BASE_URL` for a fast page availability check.

`theme-init-source.ts` is a TypeScript module, but the exported string must be
plain JavaScript because it is inlined directly into the document head. Do not
use `?raw` to inline TypeScript source that contains type annotations.

### Example Train Lookup Flow

```ts
// 1. User enters a train number, for example "9505".
// 2. Autocomplete resolves train identity candidates.
fetch("https://ah.bellotreno.workers.dev/?url=https://www.viaggiatreno.it/.../cercaNumeroTrenoTrenoAutocomplete/9505")

// 3. If multiple candidates exist, the user chooses one.
// 4. Details are loaded using train number + origin station id + midnight timestamp.
fetch("https://ah.bellotreno.workers.dev/?url=https://www.viaggiatreno.it/.../andamentoTreno/{originStationId}/{trainNumber}/{timestamp}")

// 5. The client renders the timeline, status, notices, and eligible enrichments.
// If ViaggiaTreno returns no train identity, supported Italo train numbers fall
// back to /api/italo/train.
```

### UI And UX Features

- Three languages: Chinese, English, Italian.
- Light, dark, and system theme preferences.
- Train category badges and operator logos. Train detail header links use the
  Trenitalia, Italo, Trenitalia TPER, and Trenord SVG logos where applicable.
- Italo suppresses the duplicate category logo and shows the `Alta Velocità`
  category as text beside its operator logo.
- Trenitalia TPER regional categories use `regn.png` for `REG` and the standard
  regional SVG for `RV`/`RE`.
- Train detail category logos prefer SVG assets for FR, FA, FB, IC, ICN, RV,
  Trenitalia TPER, and FS Treni Turistici Italiani.
- Platform-change highlighting.
- Recent searches in localStorage.
- Recent searches support per-item removal and a one-click clear-all action.
- Recent searches use a compact full-width header above smaller wrapping chips;
  the label and clear action stay aligned on desktop and mobile.
- Homepage train and station searches expose a shared loading state across
  autocomplete, provider fallback, disambiguation, and detail loading.
- Homepage Trenitalia ticker below the daily running-train statistics. The
  ticker is an unframed text row; desktop keeps the left-side label in a small
  badge, while mobile hides the label and icon. Short notices are centered
  independently of the label, and overflowing notices use a slower marquee.
- The homepage ticker, search control, loading state, and recent-search area
  use the same `950px` maximum width as train detail cards. Search loading is
  shown below recent searches.
- Trenitalia infomobility notices from NewsService, with category badges,
  highlighted/line/generic-notice filters, title-derived region matching, and
  separate Alto Adige/Trentino regional filters.
- Title-derived Trenitalia regions are rendered as region chips even when
  NewsService returns empty `regionTags`.
- Trenitalia notice cards intentionally omit the external source button because
  NewsService links resolve to the generic Trenitalia infomobility page; RFI
  notice cards keep per-item source links.
- RFI notice filtering by Italian region.
- The session-deduplicated visitor counter caches the returned count in
  sessionStorage so Astro page transitions can recreate the footer text without
  incrementing the Cloudflare Worker counter again.
- SmartCaring 14-day operating history for supported categories.
- Trenord line-level Traffic info for Trenord trains.
- Partial-cancellation display in train timelines, including subtitle-derived
  actual origins/destinations from `Parte da ...` and `Arriva a ...` notices.
  Sentence parsing must not treat station abbreviation dots such as
  `ROMA S.PIETRO` as the end of the notice.
- Swiss formation card with coach order, sectors, vehicle facilities, EVN, route
  segments, and active-stop closed/no-passage status.
- Interactive statistics charts, tables, ranking, pagination, and CSV links.

### Why Astro

- Static output keeps deployment and SEO simple.
- Client-side JavaScript is loaded only where needed.
- Astro Islands can later host Vue or other component islands without turning
  the whole app into an SPA.
- Astro Fonts API downloads and generates local hashed font assets at build
  time, avoiding page-runtime Google Fonts requests.

## 7. SEO, PWA, And Caching

`BaseLayout.astro` centralizes:

- `<title>` and meta description;
- canonical URL;
- `hreflang` alternates for `it`, `en`, `zh-Hans`, and `x-default`;
- Open Graph and Twitter Card tags;
- JSON-LD `WebApplication` data;
- optional Umami script injection.

Static HTML uses `lang="it"` for primary indexing. `theme-init-source.ts`
updates the runtime language from `localStorage("language")` before paint.

PWA assets:

- `public/site.webmanifest`;
- `public/apple-touch-icon.png`;
- `public/og-image.png`;
- `public/robots.txt`;
- sitemap generated by `@astrojs/sitemap` during `npm run build`.

Cache strategy:

- HTML and manifest-like entry resources are revalidated through
  `public/_headers`.
- Hashed Astro assets under `/_astro/*`, including generated font files, can use
  long immutable caching.
- Do not add a service worker unless update behavior is explicitly designed.

## 8. TypeScript And Code Quality

The active JavaScript surfaces are now TypeScript:

- browser runtime: `src/client/**/*.ts`;
- Pages Functions: `functions/api/**/*.ts`;
- normalizers: `src/lib/normalizers/**/*.ts`;
- scripts and Node tests: `scripts/**/*.ts`, `tests/js/**/*.test.ts`;
- Astro config: `astro.config.ts`.

Quality improvements already in place:

| Problem | Current approach |
| --- | --- |
| Repeated badge mapping logic | `window.getBadgeClass(catCode)` in `config.ts` |
| Unsafe HTML injection risk | shared `window.escapeHtml`, DOM builders for new high-risk UI |
| Station page inline business logic | moved to `src/client/station.ts` |
| Fragmented station navigation | `station-navigation.ts` builds canonical station URLs |
| Old browser caches after Pages deployment | hashed Astro assets plus `_headers` |
| Weak browser runtime typing | `tsconfig.client.json` uses `strict: true` |
| Swiss same-number false positives | Swiss querying is gated by category, date, and border hints |
| Swiss vehicle closed-state pollution | EVN-based merge and active segment-specific status |
| Inline 404 JavaScript and dynamic `innerHTML` | moved to `src/client/not-found.ts` with DOM builders |

Remaining hardening:

- replace broad `Record<string, unknown>` payload edges with named interfaces;
- reduce remaining controlled `innerHTML` surfaces in Swiss and statistics;
- extend smoke coverage from page availability checks to browser interaction
  tests for homepage search, station navigation, statistics, language, and
  theme.

## 9. Security Model

| Layer | Control | Purpose |
| --- | --- | --- |
| Cloudflare Worker | Origin/Referer allowlist | Blocks unrelated sites from using the public proxy |
| Worker to VPS | `X-Bello-Token` | Prevents bypassing the Worker and calling the VPS directly |
| VPS proxy | target host allowlist | Prevents open-proxy abuse |
| Pages Function to Italo proxy | `ITALO_PROXY_TOKEN` | Keeps the VPS proxy token out of browser code |
| Pages Function to Swiss API | Cloudflare Pages Secret | Keeps formation token out of browser code |
| Pages Function to statistics API | `STATISTICS_API_TOKEN` | Keeps statistics API protected |
| Pages Function to Trenord BFF | `TRENORD_BFF_SECRET` | Keeps Trenord secret out of the browser and repository |
| Frontend rendering | escaping and DOM builders | Reduces XSS risk from upstream or stored text |

Cloudflare Pages variables:

| Variable | Type | Purpose |
| --- | --- | --- |
| `ITALO_PROXY_BASE_URL` | Plain text | Italo proxy endpoint, e.g. `https://api.bellotreno.org/` |
| `ITALO_PROXY_TOKEN` | Secret | token injected as `X-Bello-Token` when calling the VPS proxy directly |
| `ITALO_PROXY_CALLER_ORIGIN` | Plain text | optional referer origin when `ITALO_PROXY_BASE_URL` points to the public Worker |
| `TRENORD_PROXY_BASE_URL` | Plain text | optional Trenord proxy endpoint; falls back to `ITALO_PROXY_BASE_URL` when unset |
| `TRENORD_PROXY_TOKEN` | Secret | optional Trenord proxy token; falls back to `ITALO_PROXY_TOKEN` when unset |
| `SWISS_TRAIN_FORMATION_API_KEY` | Secret | OpenTransportData.swiss Train Formation token |
| `STATISTICS_API_BASE_URL` | Plain text | statistics upstream, e.g. `https://stats-api.bellotreno.org/v1` |
| `STATISTICS_API_TOKEN` | Secret | token injected into statistics API requests |
| `TRENORD_BFF_SECRET` | Secret | decrypts Trenord train BFF payload server-side |
| `PUBLIC_UMAMI_SCRIPT_URL` | Plain text | optional public Umami script URL |
| `PUBLIC_UMAMI_WEBSITE_ID` | Plain text | optional public Umami site id |
| `PUBLIC_UMAMI_DOMAINS` | Plain text | analytics domain allowlist, including Pages preview domains when needed |

Only public configuration may use the `PUBLIC_` prefix. API tokens and upstream
secrets must never use `PUBLIC_`.

## 10. Technology Stack

```text
Frontend
  Astro 6
  TypeScript
  Tailwind CSS 4
  DaisyUI 5
  Astro Fonts API
  @astrojs/sitemap
  Cloudflare Pages
  Cloudflare Pages Functions

Edge services
  Cloudflare Workers
  Service Worker API runtime

Backend
  Python 3.9 / Flask / Gunicorn for the main proxy
  curl_cffi for browser fingerprint impersonation
  Python 3.11 / Flask / SQLite for statistics
  Docker and docker compose
  Linux VPS

Data sources
  ViaggiaTreno REST API
  Italo in Viaggio public realtime endpoints
  RFI RSS feeds
  Trenitalia / ViaggiaTreno infomobility ticker and NewsService feed
  OpenTransportData.swiss Train Formation API
  Trenord upstream feeds
  VPS statistics SQLite / JSON cache
```
