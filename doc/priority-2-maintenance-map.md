# Priority 2 Maintenance Map

This document tracks maintainability work after the TypeScript migration PR.
The active JavaScript surfaces have been moved to TypeScript and the browser
runtime now passes `strict: true`; the remaining work is deeper hardening, not a
file-extension migration.

## Current Baseline

- `npm run check` runs a raw JavaScript source guard, strict TypeScript checks,
  JS tests, i18n key parity, and Python compile/unit checks.
- `src/client/**/*.ts` is bundled by Astro/Vite and checked by
  `tsconfig.client.json`.
- `functions/api/**/*.ts` contains typed Cloudflare Pages Functions.
- `src/lib/normalizers/**/*.ts` contains pure data-normalization helpers.
- `tests/js/` and `tests/python/` cover high-risk edge cases.
- `doc/innerhtml-audit.md` records the remaining `innerHTML` risk surface.
- `npm run smoke:pages` can fetch-check key local or Cloudflare Pages Preview
  routes with `SMOKE_BASE_URL`.

## Remaining Work

| Area | Current state | Why it matters | Recommended split |
| --- | --- | --- | --- |
| Payload modeling | Statistics, Trenord, and ViaggiaTreno normalizer payloads now have named interfaces; Swiss browser formation data still has the broadest JSON boundary | TypeScript is most useful when upstream shapes are explicit. | Continue with Swiss formation payloads and then review remaining Function edge cases. |
| `innerHTML` migration | Statistics table/metrics/category bars and Swiss loading states use DOM builders; Swiss full-card and statistics chart/SVG templates remain controlled HTML strings | Escaping is present, but string templates remain easier to misuse in future edits. | Convert the Swiss full-card template first, then statistics SVG/donut templates. |
| Browser smoke tests | A fetch-based page smoke script exists; full interaction testing is still manual | CI catches build/type issues but not all user flows. | Extend smoke coverage later with a real browser runner for homepage search, station navigation, statistics, language, and theme. |
| Statistics backend split | `rfi-proxy/statistics/app.py` remains large | Collector, scheduler, storage, and API code are tightly coupled. | Move code without behavior changes first: `config`, `storage`, `viaggiatreno_client`, `collector`, `scheduler`, `api`. |
| i18n quality | Key parity is enforced | Copy length and layout still require review. | Keep parity in CI; use preview to check zh/en/it on desktop and mobile. |
| Future component islands | No Vue runtime is installed | Vue may help only for dense interactive islands. | Add Vue only for isolated components with typed props; keep domain logic in TypeScript utilities. |

## Recommended PR Sequence

1. **Payload interface hardening**
   - Statistics and Trenord/ViaggiaTreno normalizer payloads now have named
     interfaces.
   - Continue with Swiss formation payloads because they have the most nested
     data.

2. **Swiss rendering safety**
   - Move the full formation card template toward DOM builders or safer template
     helpers.
   - Preserve public `/api/swiss/*` interfaces.

3. **Statistics rendering safety**
   - Continue replacing chart/SVG templates where dynamic values enter HTML/SVG
     strings.
   - Keep table rows, metric cards, tooltips, and category bars on DOM builders.

4. **Browser interaction smoke tests**
   - Keep `npm run smoke:pages` for quick page availability checks.
   - Add a browser runner when the project is ready to carry that dependency in
     CI.
   - Cover homepage search, station navigation, statistics, language, and theme.

5. **Backend statistics split**
   - Split `rfi-proxy/statistics/app.py` by module without changing endpoints.
   - Deploy only after `docker compose config`, Python tests, and one VPS test
     pull are clean.

## Cloudflare Pages Preview Checklist

Use this checklist for every PR that can affect runtime behavior:

- Home page loads without page-level JavaScript errors.
- Train search works for one normal regional train and one long-distance train.
- Station search navigates to `/station?id=&name=&type=`.
- Recent station chips navigate correctly.
- Train-detail station links navigate correctly.
- Station page departures and arrivals load and link back to train details.
- Swiss formation card loads only for eligible cross-border trains.
- Statistics page loads summary cards, charts, query table, pagination, CSV link,
  and Ranking tab.
- Infomobilita page loads current notices.
- Language switching works for `zh`, `en`, and `it`.
- Light/dark/auto theme switching works across Astro client-side navigation.
- Mobile width does not show clipped chart legends, buttons, or table headers.

## When To Open The Next PR

Open a PR as soon as a batch satisfies these conditions:

- It has one clear purpose.
- `npm run check` and `npm run build` pass locally.
- The change can be validated in one Cloudflare Pages preview session.
- It avoids mixing foundation work, UI behavior changes, and VPS backend changes
  in the same review unless they are inseparable.
