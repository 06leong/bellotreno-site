# innerHTML Audit Notes

This note tracks the current migration path away from unsafe HTML string output. The project still uses vanilla browser scripts, so the practical rule is strict escaping before any external API text enters `innerHTML`.

## Current high-output areas

- `public/scripts/main.js`: train details, timeline stops, service messages, partial-cancellation indicators.
- `public/scripts/station.js`: station departure/arrival rows and Swiss route badges.
- `public/scripts/swiss.js`: Swiss formation stop selector, coach strip, vehicle details.
- `public/scripts/statistics.js`: summary cards and charts. Query table rows now use DOM builders instead of HTML string templates.
- `public/scripts/infomobilita.js`: RFI/Infomobilita news content.

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

1. Train timeline and service-message rendering in `main.js`.
2. Swiss vehicle details and coach strip in `swiss.js`.
3. Station board rows in `station.js`.
4. Infomobilita RSS cards.
5. Remaining statistics chart/tooltips templates in `statistics.js`.

The first Priority 2 baseline adds normalizer tests and quality gates. The follow-up statistics rendering PR removes the table body/header `innerHTML` path, reducing the audit count from 36 to 32. Continue converting one high-risk rendering area at a time, with fixture coverage before each behavior change.
