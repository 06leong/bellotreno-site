# AGENTS.md — BelloTreno

Personal learning project: real-time Italian railway timetable viewer, built with Astro + Tailwind CSS v4 + DaisyUI v5.

---

## Dev commands

```bash
npm run dev        # start Astro dev server
npm run build      # production build → dist/  (also generates sitemap-index.xml)
npm run preview    # serve built output
```

No lint, typecheck, or test scripts exist. TypeScript is checked implicitly by Astro (strict mode via `astro/tsconfigs/strict`).

---

## Architecture

- **Static site** (`output: 'static'` in `astro.config.mjs`). No SSR.
- **`site`** is set to `'https://real.bellotreno.org'` in `astro.config.mjs` — required for sitemap generation and canonical URLs.
- **Astro pages** live in `src/pages/`: `index.astro`, `station.astro`, `infomobilita.astro`, `about.astro`.
- **Layouts**: single `src/layouts/BaseLayout.astro` wraps all pages. Accepts `title`, `description`, and `pageScripts: string[]` props.
- **Components**: `src/components/` — `Navbar.astro`, `Footer.astro`, `BackToTop.astro`.
- **All application logic is vanilla JS** in `public/scripts/` (not bundled by Astro, served as static files):
  - `config.js` — global constants loaded first (`window.API_BASE`, `window.PROXY_BASE`, etc.) **plus shared helpers** (`window.getBadgeClass`, `window.CAT_MAP`, etc.)
  - `i18n.js` — translation strings (`zh`, `en`, `it`)
  - `common.js` — language & theme management, visitor counter (session-deduped), **`window.escapeHtml`** XSS utility; loaded on every page
  - `main.js` — train search, results rendering, SmartCaring card (index page)
  - `station.js` — station departure/arrival board utilities **+ full station page logic** (`_stLoadBoard`, `_stRenderBoard`, `_stFetchWeather`, `window.switchBoardType`)
  - `infomobilita.js` — RSS/news page
  - `theme-init.js` — inlined in `<head>` to prevent flash

**Script load order in BaseLayout matters**: `config.js → i18n.js → common.js → [page-specific scripts]`. Page scripts passed via `pageScripts` prop are appended last.

> **station.astro** is now a pure HTML template (no inline `<script>` or `<style is:global>` blocks). All page logic lives in `station.js` and is initialised inside an `astro:page-load` listener. `window.switchBoardType` is exposed globally for the `onclick` attributes in the HTML.

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

## i18n

- Three languages: `zh` (default static HTML lang), `en`, `it`.
- `BaseLayout.astro` sets `lang="it"` as the static default (primary audience); `theme-init.js` overwrites the attribute at runtime based on `localStorage('language')`.
- Elements use `data-i18n="key"` attributes; `common.js` applies translations on page load and language change.
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

## Shared helpers (window globals from config.js / common.js)

| Function | Source | Purpose |
|----------|--------|---------|
| `window.getBadgeClass(catCode)` | `config.js` | Maps a train category code to its CSS badge class (`badge-regional`, `badge-arrow`, etc.). Used by both `main.js` and `station.js` — **do not duplicate this logic**. |
| `window.escapeHtml(str)` | `common.js` | Escapes `&`, `<`, `>`, `"`, `'` for safe innerHTML injection. Apply to all API-sourced strings inserted into HTML. |

---

## ViaggiaTreno API quirks (critical for feature work)

See `blog-viaggiatreno-api.md` for full reference. Key facts:

- **Train identity is a triple**: `{numeroTreno}-{idStazOrigine}-{timestampMezzanotte}`. The same train number can belong to different trains (different origins or dates).
- **`categoria` field is unreliable for FR trains**: `categoria` is `""` for Frecciarossa; use `compNumeroTreno` as the authoritative category+number field.
- **`codiceCliente`** maps to operator: `1/2/4` = Trenitalia, `18` = TPER, `63` = Trenord, `64` = ÖBB, `910` = FSE, `77` = TTI. Defined in `public/scripts/config.js` as `window.CLIENT_MAP`.
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

Allowed origins: `https://real.bellotreno.org`, `https://bellotreno.pages.dev`, `http://localhost:4321`, `http://127.0.0.1:4321`.

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

### Category-gating logic (in `main.js`)

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
