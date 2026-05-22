# Priority 2 Maintenance Map

This document tracks the maintainability work that should happen after the first
CI and normalizer baseline. It is intentionally scoped as an engineering map,
not a rewrite plan: each item should be small enough to review in a Cloudflare
Pages preview before merging.

## Current Baseline

The current foundation PR should stay focused on quality gates and pure helpers:

- `npm run check` runs JavaScript syntax checks, JSDoc type checks for new
  normalizers, fixture tests, i18n key parity checks, and Python helper tests.
- `src/lib/normalizers/` now contains pure data-normalization helpers for
  ViaggiaTreno, Swiss formation, and statistics.
- `tests/js/` and `tests/python/` cover the first high-risk edge cases.
- `rfi-proxy/statistics/statistics_core/` starts extracting pure backend logic
  from the large Flask service without changing public API behavior.
- `doc/innerhtml-audit.md` records the current `innerHTML` risk surface.

This is a good first PR because it should not intentionally change visible
production behavior. The Cloudflare Pages preview should mainly prove that the
site still builds and loads normally.

## Remaining Work

| Area | Current size / count | Why it matters | Recommended split |
| --- | ---: | --- | --- |
| Frontend runtime scripts | 3 large files (`main.js`, `swiss.js`, `statistics.js`) plus 2 medium files (`station.js`, `infomobilita.js`) | Most user-facing bugs are fixed directly in global scripts today, so behavior can regress in unrelated pages. | One feature domain per PR. Start with partial-cancellation rendering, then statistics table helpers, then Swiss formation rendering. |
| `innerHTML` migration | 36 recorded assignments/usages | API text is inserted in many places. Some calls are safe today, but future edits can accidentally skip escaping. | Convert highest-risk renderers first: statistics table, train timeline, Swiss vehicle details, station board, infomobilita cards. |
| Statistics backend split | `rfi-proxy/statistics/app.py` is about 1400+ lines | Collector, scheduler, storage, and API code are tightly coupled. This makes performance work and bug fixes harder to review. | Move code without behavior changes first: `config`, `storage`, `viaggiatreno_client`, `collector`, `scheduler`, `api`. |
| Normalizer coverage | 3 new modules, fixture coverage started | Normalizers make external API quirks explicit and testable before UI rendering. | Add fixtures whenever a real bug appears: Swiss same-number false positives, EMU ordering, partial cancellation, statistics category/status mapping. |
| i18n reliability | Key parity check added | Missing language keys are now caught, but copy quality and layout length still need review. | Keep key parity in CI; use PR preview to check zh/en/it layout on desktop and mobile. |
| Type migration | JSDoc `checkJs` only for new normalizers | Full TypeScript migration would be too large, but typed data boundaries already reduce regressions. | Continue adding typed pure modules under `src/lib/`; do not rewrite the whole app at once. |

## Recommended PR Sequence

1. **Foundation PR: quality gates and pure normalizers**
   - Include the current CI, check scripts, first fixture tests, and docs.
   - Cloudflare Pages preview goal: the website still loads and major pages do
     not break.

2. **Partial cancellation runtime PR**
   - Wire the ViaggiaTreno partial-cancellation normalizer into `main.js`.
   - Validate red/normal timeline sections for start-cancelled, end-cancelled,
     and API-cropped journeys.

3. **Statistics rendering safety PR**
   - Move table/chart category/status helpers behind tested functions.
   - Start replacing the statistics table `innerHTML` output with a safer
     builder or controlled template helper.

4. **Swiss formation rendering PR**
   - Move coach order, active segment, and sector display helpers behind tested
     functions.
   - Keep the public `/api/swiss/*` interface unchanged.

5. **Backend statistics split PR**
   - Split `rfi-proxy/statistics/app.py` by module without changing endpoints.
   - Deploy only after `docker compose config`, Python tests, and one VPS test
     pull are clean.

## Cloudflare Pages Preview Checklist

Use this checklist for every PR that can affect runtime behavior:

- Home page loads without console errors.
- Train detail works for one normal REG/IR train and one long-distance train.
- Partial cancellation banner and timeline still render correctly when present.
- Station page departures and arrivals load and link to train details.
- Swiss formation card loads only for eligible cross-border trains.
- Statistics page loads summary cards, charts, query table, and Ranking tab.
- Infomobilita page loads current notices.
- Language switching works for `zh`, `en`, and `it`.
- Mobile width does not show clipped chart legends, buttons, or table headers.

## When To Open The Next PR

Open a PR as soon as a batch satisfies these conditions:

- It has one clear purpose.
- `npm run check` and `npm run build` pass locally.
- The change can be validated in one Cloudflare Pages preview session.
- It avoids mixing foundation work, UI behavior changes, and VPS backend changes
  in the same review unless they are inseparable.

For the current batch, the best timing is now or after one final documentation
pass. Adding more runtime migrations to the same PR would make the review less
useful because the preview would no longer isolate whether the new quality gates
are harmless.
