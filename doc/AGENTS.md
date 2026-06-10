# AGENTS.md - BelloTreno

Developer and agent notes for the BelloTreno repository.

BelloTreno is a real-time Italian railway information site built with Astro 6,
TypeScript, Tailwind CSS v4, DaisyUI v5, Cloudflare Pages, and Cloudflare Pages
Functions.

## Dev Commands

```bash
npm run dev         # start Astro dev server
npm run build       # production build to dist/
npm run check       # full local quality gate, same baseline as CI
npm run check:no-raw-js # fail if raw .js/.mjs/.cjs source files are added
npm run check:types # TypeScript checks for every scoped project
npm run test:js     # Node test runner through tsx for tests/js/*.test.ts
npm run smoke:pages # fetch smoke test against local/preview pages
npm run preview     # serve built output locally
```

`npm run check` is the minimum gate before pushing. It runs:

- raw JavaScript source guard for `.js`, `.mjs`, and `.cjs` files outside
  generated/dependency directories;
- TypeScript checks for normalizers, Cloudflare Pages Functions, Node
  scripts/tests, and browser runtime modules;
- Node tests under `tests/js/`;
- i18n key parity checks for `zh`, `en`, and `it`;
- Python compile/unit checks for the VPS services.

The source tree is TypeScript-first. `tsconfig.base.json` is strict, and
`tsconfig.client.json` also runs the browser runtime with `strict: true`. Do not
loosen TypeScript config to land a change. Fix DOM and API boundaries with
typed guards, local interfaces, normalizers, or explicit fallback behavior.

## Architecture

- `astro.config.ts` defines the static Astro site (`output: "static"`) and
  `site: "https://bellotreno.org"`.
- Astro pages live in `src/pages/`: `index.astro`, `station.astro`,
  `infomobilita.astro`, `statistics.astro`, `about.astro`, and `404.astro`.
- `src/layouts/BaseLayout.astro` wraps all pages and imports shared browser
  modules through Astro/Vite.
- Shared components live in `src/components/`.
- Browser runtime modules live in `src/client/**/*.ts`.
- Pure data normalizers live in `src/lib/normalizers/**/*.ts` and should have
  focused tests under `tests/js/`.
- Cloudflare Pages Functions live in `functions/api/**/*.ts`.
- Node scripts live in `scripts/**/*.ts`.
- VPS Python services live in `rfi-proxy/` and are intentionally outside the
  TypeScript migration.

Do not add new browser source under `public/scripts/`. Runtime code must be
authored in TypeScript and bundled by Astro/Vite into hashed `/_astro/*` assets.
Use `SMOKE_BASE_URL=https://your-preview.pages.dev npm run smoke:pages` after a
preview deploy to catch missing page entries before deeper manual testing.

## Runtime Modules

Shared runtime import order matters:

1. `src/client/config.ts`
2. `src/client/i18n.ts`
3. `src/client/common.ts`
4. page-specific modules imported by the owning Astro page

Important modules:

- `config.ts`: API base URLs, operator/category maps, train badge helper.
- `i18n.ts`: `zh`, `en`, and `it` translation dictionaries.
- `common.ts`: language/theme management, visitor counter, `escapeHtml`, shared
  page behavior.
- `theme-init-source.ts`: exports a plain JavaScript bootstrap string that
  `BaseLayout.astro` inlines in `<head>` before render. Do not inline raw
  TypeScript with `?raw`; browsers cannot execute TypeScript syntax.
- `main.ts`: homepage train/station search, train details, SmartCaring and
  Trenord traffic card rendering.
- `station.ts`: station departure/arrival board behavior.
- `station-navigation.ts`: canonical `/station?id=&name=&type=` URL creation
  used by search results, recent station chips, train-detail station links, and
  station page compatibility globals.
- `statistics.ts`: statistics dashboard, charts, tables, pagination, and CSV
  links.
- `swiss.ts`: Swiss formation fetch/cache, timeline merge, coach strip, and
  vehicle detail rendering.
- `about.ts`: localized About-page content rendered from typed, in-repo static
  sections.
- `not-found.ts`: 404 terminal theme/device effect with DOM builders.

`src/types/bellotreno-globals.d.ts` is the compatibility boundary for existing
`window.*` globals. Prefer normal imports for new code; add globals only when an
Astro template or legacy browser boundary genuinely needs them.

## Encoding

Repository text files are UTF-8. PowerShell can display UTF-8 Chinese or Italian
accented text incorrectly when its output encoding/code page is not UTF-8; do not
classify that as source corruption by sight alone. Confirm with `rg`, `git diff`,
or a build/typecheck. If the file itself contains mojibake, fix the source text
directly instead of documenting around it.

## Styling And Fonts

- Tailwind CSS v4 is loaded through the Vite plugin and configured in
  `src/styles/global.css`.
- DaisyUI v5 is loaded as a CSS `@plugin`.
- Do not add `tailwind.config.js`; this project uses Tailwind v4 CSS-first
  configuration.
- Theme colors are DaisyUI themes plus project CSS variables.
- Category badge colors and railway-specific animation classes live in
  `global.css`.
- Fonts are configured in `astro.config.ts` through Astro's Fonts API. The build
  produces local hashed font assets; the browser should not load Google Fonts at
  page runtime.

## Cloudflare And Secrets

External Cloudflare Workers are not in this repository:

- `ah.bellotreno.workers.dev`: main ViaggiaTreno CORS/proxy entry.
- `notify.bellotreno.workers.dev`: SmartCaring notices.
- `site-counter.bellotreno.workers.dev`: visitor counter.

Pages Functions in this repo own same-origin server-side calls that require
secrets:

| Function | Secret/config |
| --- | --- |
| `/api/swiss/formation` | `SWISS_TRAIN_FORMATION_API_KEY` |
| `/api/statistics/*` | `STATISTICS_API_BASE_URL`, `STATISTICS_API_TOKEN` |
| `/api/trenord/traffic` | `TRENORD_BFF_SECRET` |

Never expose tokens through `PUBLIC_*`. `PUBLIC_*` variables are visible in the
browser and are only acceptable for public analytics/config values such as
Umami settings.

For Cloudflare Pages preview validation, include the preview domain pattern in
analytics allowlists when needed, for example:

```text
bellotreno.org,real.bellotreno.org,*.bellotreno-site.pages.dev
```

## i18n

- Supported languages: `zh`, `en`, `it`.
- Static HTML uses `lang="it"` for SEO; `theme-init-source.ts` applies the saved
  runtime language before paint.
- Translatable elements use `data-i18n`.
- `common.ts` applies translations on `astro:page-load` and user language
  changes.
- Keep translation keys identical across all languages; `npm run check:i18n`
  enforces this.

## innerHTML And XSS

Prefer DOM APIs (`document.createElement`, `textContent`, `append`) for new
interactive UI. If an existing section still uses `innerHTML`, every external
value must be escaped first.

Treat these values as external even if they usually look safe:

- ViaggiaTreno and RFI payloads;
- OpenTransportData.swiss payloads;
- statistics API payloads;
- Cloudflare Function responses;
- query string values;
- localStorage/sessionStorage values.

Current risk tracking lives in `doc/innerhtml-audit.md`.

## Feature Notes

### Swiss Formation

- Browser code must call the same-origin Pages Function, never the Swiss API
  directly.
- Vehicle identity is primarily EVN-based.
- Segment-specific closed state must not be OR-merged globally across all route
  segments.
- Station board Swiss enrichment should be conservative: only replace a visible
  origin/destination when ViaggiaTreno is blank or clearly truncated at a Swiss
  boundary station such as Chiasso, Domodossola, Luino, Tirano, or Stabio.

### Statistics

- The frontend calls only `/api/statistics/*`.
- The browser must not know `STATISTICS_API_TOKEN`.
- The VPS collector stores SQLite data in the `statistics-data` volume.
- `STATISTICS_BOARD_TYPES=partenze,arrivi` means both board types are fetched.
  Keep each station board type as a separate concurrent task.
- Statistics are observable operational data, not an official full-network
  report. Avoid UI wording that implies official completeness.

### Trenord Traffic

- Trenord traffic is intentionally implemented as a same-origin Pages Function,
  not a new public Worker.
- The frontend calls it only for trains with `codiceCliente === 63`.
- The response is line-level (`direttrice`) information, not a single-train
  official disruption notice.

## Validation Checklist

Before pushing a runtime or deployment change:

```bash
npm run check
npm run build
git status --short
```

If `rfi-proxy/` or Docker deployment config changes:

```bash
cd rfi-proxy
docker compose config
```

For frontend changes, smoke test:

- homepage train search and station search mode;
- recent station search navigation;
- train-detail station links;
- `/station?id=...&type=partenze` and `type=arrivi`;
- Swiss formation card;
- `/statistics/`;
- `/infomobilita/`;
- `zh` / `en` / `it` switching;
- light/dark/auto theme switching;
- desktop and mobile layouts.

Keep PR commits stage-sized and reviewable. Do not mix broad refactors with
runtime bug fixes unless the refactor is required to make the fix correct.
