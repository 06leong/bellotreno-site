# innerHTML Audit Notes

This note tracks the current migration path away from unsafe HTML string output. The project still uses vanilla browser scripts, so the practical rule is to prefer DOM builders and use strict escaping before any external API text enters `innerHTML`.

## Current high-output areas

- `public/scripts/main.js`: train details, timeline stops, service messages, partial-cancellation indicators, disambiguation choices, recent searches, and SmartCaring now use DOM builders.
- `public/scripts/station.js`: station departure/arrival rows and Swiss route badges now use DOM builders.
- `public/scripts/swiss.js`: Swiss formation stop selector, coach strip, vehicle details.
- `public/scripts/statistics.js`: summary cards and charts still use controlled HTML/SVG templates. Query table rows use DOM builders instead of HTML string templates.
- `public/scripts/infomobilita.js`: RFI/Infomobilita news content now uses DOM builders.

## Current safe patterns

- Prefer `window.escapeHtml` from `common.js` for browser-rendered external text.
- Some files use local helpers such as `esc()` or `escapeHtml()` aliases. Those should remain simple wrappers around the shared escaping behavior.
- Static labels from `i18n.js` are lower risk, but translated strings should still be escaped when inserted into larger HTML templates.

## Rules for new code

- Do not concatenate raw API fields into `innerHTML`.
- Escape all values from ViaggiaTreno, OpenTransportData.swiss, the statistics API, RSS feeds, Cloudflare Functions, query strings, and local storage.
- Prefer DOM builder functions (`document.createElement`, `textContent`, `append`) for new interactive sections.
- If an existing section must keep string templates, introduce a small local template helper that escapes every dynamic value by default.

## Migration priority

1. Swiss vehicle details and coach strip in `swiss.js`.
2. Remaining statistics chart/tooltips templates in `statistics.js`.
3. Any future high-risk page added under `public/scripts/`.

The first Priority 2 baseline added normalizer tests and quality gates. Follow-up PRs converted the statistics table, station board, Infomobilita cards, and `main.js` train-detail surfaces. Continue converting one high-risk rendering area at a time, with fixture coverage before each behavior change.
