# AGENTS.md — BelloTreno

Personal learning project: real-time Italian railway timetable viewer, built with Astro + Tailwind CSS v4 + DaisyUI v5.

---

## Dev commands

```bash
npm run dev        # start Astro dev server
npm run build      # production build → dist/  (also generates sitemap-index.xml)
npm run check      # syntax, i18n, normalizer fixtures, Python compile/unit checks
npm run check:types # TypeScript checks for normalizers, Functions, Node scripts/tests, and client modules
npm run test:js    # Node test runner through tsx for tests/js/*.test.ts
npm run preview    # serve built output
```

`npm run check` is the baseline quality gate and is also run in CI. TypeScript is split across scoped configs so the migration can remain reviewable: `tsconfig.normalizers.json`, `tsconfig.functions.json`, `tsconfig.node.json`, and `tsconfig.client.json`.

---

## Architecture

- **Static site** (`output: 'static'` in `astro.config.mjs`). No SSR.
- **`site`** is set to `'https://bellotreno.org'` in `astro.config.mjs` — required for sitemap generation and canonical URLs. `real.bellotreno.org` is kept only as the legacy alias/redirect domain.
- **Astro pages** live in `src/pages/`: `index.astro`, `station.astro`, `infomobilita.astro`, `statistics.astro`, `about.astro`.
- **Layouts**: single `src/layouts/BaseLayout.astro` wraps all pages. Accepts `title`, `description`, and compatibility `pageScripts` props, and imports shared browser modules directly through Astro/Vite.
- **Components**: `src/components/` — `Navbar.astro`, `Footer.astro`, `BackToTop.astro`.
- **Browser runtime modules** live in `src/client/` and are bundled by Astro/Vite:
  - `config.ts` — global constants loaded first (`window.API_BASE`, `window.PROXY_BASE`, etc.) plus shared helpers (`window.getBadgeClass`, `window.CAT_MAP`, etc.).
  - `i18n.ts` — translation strings (`zh`, `en`, `it`).
  - `common.ts` — language and theme management, visitor counter, `window.escapeHtml`, shared page behavior.
  - `main.ts` — train search, results rendering, SmartCaring/Trenord cards, and homepage interactions.
  - `station.ts` — station departure/arrival board utilities and full station page logic.
  - `station-navigation.ts` — canonical station board URL creation and navigation shared by search, recent station chips, train detail station links, and the station page.
  - `infomobilita.ts`, `statistics.ts`, `swiss.ts` — page-specific runtime modules.
  - `theme-init.ts` — imported as raw text and inlined in `<head>` to prevent theme flash.

Shared pure normalizer/helper code belongs under `src/lib/normalizers/`, with fixture coverage in `tests/js/`. Do not add new browser source under `public/scripts/`; that directory is no longer the source of truth for runtime code.

**Runtime import order in BaseLayout matters**: `config.ts → i18n.ts → common.ts → [page-specific slot scripts]`. Page-specific Astro files import their client modules through `<script slot="scripts">`.

> **station.astro** is now a pure HTML template (no inline business logic). All page logic lives in `src/client/station.ts` and is initialised inside an `astro:page-load` listener. `window.switchBoardType` remains exposed globally for current template compatibility.

---

## Styling

- Tailwind CSS v4 (Vite plugin, not PostCSS). Import in `src/styles/global.css` via `@import "tailwindcss"`.
- DaisyUI v5 loaded as a `@plugin`. Two custom themes defined inline: `light` and `dark`.
- Custom CSS variables: `--train-green`, `--train-grey`, `--train-red` for delay/status color coding.
- Train category badge colors are hardcoded in CSS (`.badge-regional`, `.badge-arrow`, etc.), not DaisyUI utilities.
- `.ripple` and `.platform-pulse` / `@keyframes platformPulse` are defined in `global.css` (not in component `<style>` blocks).

**Do not add a `tailwind.config.js`** — v4 has no separate config file; all configuration is in CSS.

---

## API proxy

All ViaggiaTreno API calls are routed through a Cloudflare Workers CORS proxy:

```
window.PROXY_BASE  = "https://ah.bellotreno.workers.dev"
window.API_BASE    = PROXY_BASE + "/?url=https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno"
window.NOTIFY_BASE = "https://notify.bellotreno.workers.dev"   // SmartCaring notifications
window.COUNTER_URL = "https://site-counter.bellotreno.workers.dev/"
```

These Workers are **not in this repo**. Direct calls to `viaggiatreno.it` fail in browser due to CORS.

---

## Current feature notes

### Quality gates

- `scripts/check-js-syntax.ts` checks any remaining raw JavaScript syntax. A fully migrated source tree should report `0 file(s)`.
- `npm run check:types` runs TypeScript over normalizers, Cloudflare Pages Functions, Node scripts/tests, and client runtime modules.
- `scripts/check-i18n.ts` requires `zh`, `en`, and `it` translation keys to stay identical.
- `scripts/audit-innerhtml.ts` lists current `innerHTML` use sites for manual review; it is intentionally non-blocking for now.
- `tests/js/` covers high-risk normalizer behavior for statistics categories, Swiss formation gatekeeping, partial cancellation, Trenord notices, and station navigation.
- `tests/python/` covers pure statistics helpers such as service-date filtering.
- `doc/innerhtml-audit.md` tracks the current `innerHTML` risk areas and migration priority.
- `doc/priority-2-maintenance-map.md` tracks the remaining maintainability work, suggested PR sequence, and Cloudflare Pages preview checklist.

### Swiss formation

- Pages Functions live under `functions/api/swiss/`. They read `SWISS_TRAIN_FORMATION_API_KEY` from Cloudflare Pages Secrets and must never expose the token to the browser.
- `src/client/swiss.ts` owns Swiss fetch/cache, timeline merge, TILO image override, coach strip rendering, and vehicle detail rendering.
- Vehicle identity is based primarily on EVN. Same EVN records from different route segments are merged into one display vehicle with `segments`.
- Closed state is segment-specific. Do not OR `closed` / `trolleyStatus` globally across all segments; the UI must resolve the active segment for the selected stop.
- Coach display must keep a stable vehicle sequence while using the selected stop only for track/sector/no-passage display. Sector labels should be normalized and displayed from A onward in station-facing order.
- Known EMU groups need conservative handling: ETR 610 usually groups in 7-car units, RABe 501/Giruno in 11-car units. Preserve unit order and avoid duplicate `position` values causing interleaved coach sequences.
- Station board Swiss enrichment is protective: only replace a visible origin/destination when ViaggiaTreno is blank or clearly truncated at a border station such as Chiasso, Domodossola, Luino, Tirano, or Stabio. Never downgrade a correct Italian terminal to a Swiss border station, and do not treat Porto Ceresio, Ponte Tresa, or Gaggiolo as automatic Swiss continuation anchors.

### Statistics

- The frontend statistics page uses `src/client/statistics.ts` and calls only `/api/statistics/*`.
- `functions/api/statistics/[[path]].ts` proxies requests to `STATISTICS_API_BASE_URL` and injects `STATISTICS_API_TOKEN`. The browser must not know the VPS token.
- The VPS statistics service lives in `rfi-proxy/statistics/` but deploys as a separate Docker service in the same compose project. It stores SQLite data in the mounted `statistics-data` volume.
- `/statistiche/0` from ViaggiaTreno is only a global counter. Category, route, station, delay, cancellation, and relation statistics come from station registry + station boards + `andamentoTreno` sampling.
- The collector uses fixed Europe/Rome slots (`HH:05`, `HH:35`, plus `23:55` by default). Keep every board request in one run pinned to that slot time; do not change it back to "collect, then sleep interval" scheduling.
- Statistics rows use the scheduled slot date as the reporting date and preserve the original train departure date as `service_date`; keep previous-service-date trains when they are still visible on the current day's boards, but do not count next-service-date trains into the previous day.
- `STATISTICS_BOARD_TYPES=partenze,arrivi` means both board types are fetched. Each station board type is a separate concurrent task, so do not reintroduce station-internal sequential board fetching.
- Keep UI labels concrete. Avoid showing ratios such as "coverage" unless the numerator and denominator are clear to users.

### Cache and deployment

- Browser runtime files are bundled by Astro/Vite under hashed `/_astro/*` assets.
- `public/_headers` keeps HTML and scripts revalidated while allowing hashed Astro assets under `/_astro/*` to be immutable.
- Do not add a service worker unless the update lifecycle is explicitly designed; stale SW caches are harder to debug than normal browser cache.

---

## i18n

- Three languages: `zh` (default static HTML lang), `en`, `it`.
- `BaseLayout.astro` sets `lang="it"` as the static default (primary audience); `theme-init.ts` overwrites the attribute at runtime based on `localStorage('language')`.
- Elements use `data-i18n="key"` attributes; `common.ts` applies translations on page load and language change.
- `html[data-lang-loading]` hides `[data-i18n]` and `[data-i18n-section]` elements until translations are applied (prevents Chinese text flash on non-zh load).
- Language persisted to `localStorage('language')`.

---

## SEO

`BaseLayout.astro` automatically generates all SEO tags from its props:

| Prop | Default |
|------|---------|
| `title` | _(required)_ |
| `description` | Italian fallback description |

Tags injected per page: `<title>`, `<meta name="description">`, `<link rel="canonical">`, four `hreflang` alternates (`it`, `en`, `zh-Hans`, `x-default`), full Open Graph set (9 tags), Twitter Card (4 tags), JSON-LD `WebApplication` structured data.

Each page passes its own `description` in Italian (primary language). Sitemap is generated at build time by `@astrojs/sitemap`.

### PWA

`public/site.webmanifest` enables "Add to Home Screen" on iOS 16.4+ and Android Chrome. Required assets:

| File | Size | Purpose |
|------|------|---------|
| `public/apple-touch-icon.png` | 180×180 px | iOS home screen icon |
| `public/og-image.png` | 1200×630 px | OG/Twitter preview + manifest icon |
| `public/site.webmanifest` | — | PWA manifest (`display: standalone`) |

---

## Shared helpers (window globals from config.ts / common.ts)

| Function | Source | Purpose |
|----------|--------|---------|
| `window.getBadgeClass(catCode)` | `config.ts` | Maps a train category code to its CSS badge class (`badge-regional`, `badge-arrow`, etc.). Used by both `main.ts` and `station.ts` — **do not duplicate this logic**. |
| `window.escapeHtml(str)` | `common.ts` | Escapes `&`, `<`, `>`, `"`, `'` for safe innerHTML injection. Apply to all API-sourced strings inserted into HTML. |

---

## ViaggiaTreno API quirks (critical for feature work)

See `blog-viaggiatreno-api.md` for full reference. Key facts:

- **Train identity is a triple**: `{numeroTreno}-{idStazOrigine}-{timestampMezzanotte}`. The same train number can belong to different trains (different origins or dates).
- **`categoria` field is unreliable for FR trains**: `categoria` is `""` for Frecciarossa; use `compNumeroTreno` as the authoritative category+number field.
- **`codiceCliente`** maps to operator: `1/2/4` = Trenitalia, `18` = TPER, `63` = Trenord, `64` = ÖBB, `910` = FSE, `77` = TTI. Defined in `src/client/config.ts` as `window.CLIENT_MAP`.
- **`partenze`/`arrivi` `dateTime` parameter** must be JavaScript `Date.toString()` format (e.g. `Thu Mar 12 2026 13:31:00 GMT+0100`), URL-encoded. Italy observes CET (`+0100`) / CEST (`+0200`) — daylight saving switches last Sunday of March/October.
- **SmartCaring** (`window.NOTIFY_BASE`) — `notify.bellotreno.workers.dev` is a **dedicated CF Worker** (not the main CORS proxy). It calls `viaggiatreno.it/infomobilita/resteasy/news/smartcaring?commercialTrainNumber={n}`, aggregates the raw array into `{ today, recent, history, stats }`, and caches the response for 120 s. The raw API returns *all* historical notifications; the Worker filters to the past 14 days and marks entries matching Italy's current date as `today`. See **SmartCaring feature** section below for details.
- **`tipoTreno` + `provvedimento` combination** determines cancellation status: `ST`+`1` = full cancel, `PP`/`SI`/`SF` = partial cancel, `DV`+`3` = rerouted.
- Station codes are prefixed with `S` (e.g. `S01700` = Milano Centrale, `S08409` = Roma Termini).

---

## SmartCaring feature (运行报告 card)

Displayed as a collapsible card (`#smartCaringCard`) below the train detail card on the index page. Powered by a **separate** Cloudflare Worker at `window.NOTIFY_BASE`.

### Worker endpoint

```
GET https://notify.bellotreno.workers.dev?train={numeroTreno}
```

Allowed origins: `https://bellotreno.org`, `https://real.bellotreno.org`, `https://bellotreno.pages.dev`, `http://localhost:4321`, `http://127.0.0.1:4321`.

### Response shape

```jsonc
{
  "train": "9505",
  "today": [ // notifications with Italy date == today, newest first
    { "date": "2026-04-17", "infoNote": "…", "infoNoteEn": "…",
      "delayMinutes": 25, "reason": "guasto al materiale rotabile",
      "insertTimestamp": 1744900000000 }
  ],
  "recent": [ /* 5 most-recent entries across 14 days, newest first */ ],
  "history": [ /* one entry per disrupted day, newest first */
    { "date": "2026-04-17", "maxDelay": 25, "notifications": 3, "reasons": ["…"] }
  ],
  "stats": {
    "totalDays": 14,
    "disruptedDays": 3,
    "onTimeDays": 11,
    "onTimeRate": 79,   // percent
    "avgDelay": 18,     // minutes, disrupted days only
    "maxDelay": 45
  }
}
```

If no entries fall within the 14-day window the Worker still returns the same shape with empty arrays and zeroed stats (it does **not** set a `noData` flag — the client checks `!today.length && !recent.length && !history.length`).

### Category-gating logic (in `main.ts`)

| Constant | Categories | Behaviour |
|----------|------------|-----------|
| `SC_SKIP_CATS` | `IC`, `ICN`, `EC`, `EN` | Card hidden — SmartCaring data not fetched |
| `SC_FULL_CATS` | `FR`, `FA`, `FB` | Full mode: shows notifications **+ 14-day bar chart + stats**. Card hidden only if `today`, `recent`, and `history` are all empty |
| _(all others)_ | `REG`, `RV`, `MET`, `EXP`, `TS`, … | Compact mode: shows notifications only. Card hidden if no `today` or `recent` entries |

`resolveTrainCategory(data)` derives the category code from `data.categoria` → `compNumeroTreno` prefix → `categoriaDescrizione` lookup (`DESC_TO_CAT` map), in that order.

### Rendering (`renderSmartCaring`)

- **Notification list**: `today` entries shown with HH:MM time; `recent` entries shown with short month + day.
- **Bar chart** (full mode only): 14 columns, one per day, bar height proportional to `maxDelay`. Colour classes: `sc-level-0` (on time) → `sc-level-3` (>30 min). Click a bar to show a floating tooltip (`#scTooltip`) with delay and reason.
- **Stats row**: on-time rate coloured green/amber/red by threshold (≥70 % / ≥40 % / <40 %).
- Card re-uses collapse state across re-renders (detects `.sc-collapsed` class before overwriting innerHTML).
- Language changes trigger `renderSmartCaring(currentSmartCaringData)` via `window.onLanguageChanged`.
- All API-sourced strings (`n.infoNote`, `tipReason`) are passed through `escapeHtml()` before innerHTML injection.

---

## Public assets

- `public/pic/` — operator/category logo PNGs. Mapping from `{codiceCliente}-{categoria}` key to image path is in `window.CAT_IMAGE_MAP` (`config.js`). Key format: `"63-REG"` → `"pic/regn.png"`.
- `public/_redirects` — Netlify/Cloudflare Pages redirect rules mapping legacy `.html` URLs to clean paths.
- `public/robots.txt` — allows all crawlers, points to sitemap.
- `public/site.webmanifest` — PWA manifest (`display: standalone`, `theme_color: #6a8a9f`).
- `public/apple-touch-icon.png` — 180×180 px, for iOS home screen.
- `public/og-image.png` — 1200×630 px, for OG/Twitter card previews.

---

## Deployment

Static site, deployable to Netlify or Cloudflare Pages. `public/_redirects` handles legacy URL redirects. No environment variables required in the repo (all API endpoints are hardcoded in `config.js`).

`npm run build` also generates `dist/sitemap-index.xml` and `dist/sitemap-0.xml` via `@astrojs/sitemap`.
