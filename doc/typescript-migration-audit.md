# TypeScript Migration Audit

Last updated: 2026-06-04

This document records the TypeScript migration state after the single migration
PR and follow-up hardening PRs. The goal is to keep the project reviewable while
keeping source code out of untyped JavaScript and inside typed, bundler-managed
modules.

## Current State

The repository source has been migrated to TypeScript for the active JavaScript
surfaces:

| Area | Current source | Type checking |
|------|----------------|---------------|
| Browser runtime | `src/client/**/*.ts` | `tsconfig.client.json` (`strict: true`) |
| Shared normalizers | `src/lib/normalizers/**/*.ts` | `tsconfig.normalizers.json` |
| Cloudflare Pages Functions | `functions/api/**/*.ts` | `tsconfig.functions.json` |
| Node scripts and JS tests | `scripts/**/*.ts`, `tests/js/**/*.test.ts` | `tsconfig.node.json` |

`public/scripts/` is no longer the browser source location. Shared runtime
modules are imported by `BaseLayout.astro`, and page modules are imported by the
owning Astro page through `slot="scripts"`.

The 404 page is also backed by `src/client/not-found.ts`; it is intentionally
outside `BaseLayout.astro`, but its runtime behavior is still TypeScript and is
bundled by Astro/Vite.

## Architecture Boundaries

- `src/client/config.ts`, `i18n.ts`, and `common.ts` are the shared runtime base
  and must load before page modules.
- `src/client/theme-init-source.ts` exports a browser-ready JavaScript bootstrap
  string for the inline head script. Do not inline raw TypeScript source with
  `?raw`.
- `src/client/station-navigation.ts` is the canonical station board navigation
  API. Search results, recent station chips, train-detail station links, and
  station-page compatibility globals should use this module instead of
  reassembling `/station` URLs independently.
- `src/lib/normalizers/` is the preferred home for pure data shaping logic.
  Put behavior there when it can be tested without the DOM.
- `functions/api/` owns same-origin server-side API calls that need secrets or
  upstream normalization. Browser code must not read Swiss, statistics, or
  Trenord secrets.
- `rfi-proxy/` remains Python and is intentionally outside the TypeScript
  migration. It is still covered by `npm run check:python`.
- External Cloudflare Workers such as `ah.bellotreno.workers.dev`,
  `notify.bellotreno.workers.dev`, and `site-counter.bellotreno.workers.dev`
  are not in this repository and are not modified by this PR.

## Validation Gates

The PR quality gate is:

```bash
npm run check
npm run build
```

`npm run check` includes:

- raw JavaScript source guard for `.js`, `.mjs`, and `.cjs` files outside
  generated/dependency directories;
- TypeScript checks for normalizers, Functions, Node scripts/tests, and client
  modules;
- Node tests under `tests/js/`;
- i18n key parity for `zh`, `en`, and `it`;
- Python compile/unit checks for the VPS services.

For quick preview validation after deployment, use:

```bash
npm run smoke:pages
```

Set `SMOKE_BASE_URL` to a Cloudflare Pages Preview URL when checking deployed
output. This is a page availability smoke check, not a substitute for manual
search/navigation/theme/language interaction testing.

When deployment configuration or `rfi-proxy/` changes, also run:

```bash
docker compose config
```

from `rfi-proxy/`.

## Remaining Hardening

The full source migration is complete for active JavaScript surfaces, and the
browser runtime now passes TypeScript with `strict: true`. Remaining work is no
longer about renaming files; it is about improving domain models, reducing broad
`Record<string, unknown>` boundaries, and lowering rendering risk.

Recommended hardening order:

1. Replace broad `Record<string, unknown>` boundaries with named payload
   interfaces where the upstream shape is stable enough to model.
2. Move reusable pure helpers from client files into `src/lib/normalizers/` or
   a new typed client utility module when they can be tested without the DOM.
3. Replace remaining string-template `innerHTML` surfaces according to
   `doc/innerhtml-audit.md`.
4. Keep global `window.*` declarations in `src/types/bellotreno-globals.d.ts`
   as a compatibility boundary only. New feature code should prefer imports.
5. Extend smoke coverage from the current fetch-based page check to browser
   interaction tests for homepage search, station board navigation, statistics,
   language switching, and theme switching.

## Future Vue Islands

Astro can host Vue components later without changing the current TypeScript
layout. The recommended path is:

1. Keep page-level routing and SEO in Astro pages.
2. Introduce Vue only for isolated interactive islands where component state is
   genuinely useful, such as complex filters, coach selectors, or chart controls.
3. Pass server-safe data into islands through typed props; do not let Vue
   components read deployment secrets or bypass Pages Functions.
4. Keep domain logic in `src/lib/normalizers/` or typed client utilities so it
   can be shared by Astro, Vue, and tests.
5. Avoid converting the whole app to an SPA unless there is a concrete product
   need. The current static Astro model keeps SEO, build output, and Cloudflare
   Pages deployment simple.

## PR Stage Status

| Stage | Status |
|-------|--------|
| Foundation | Complete |
| Core logic | Complete |
| Cloudflare Pages Functions | Complete |
| Tooling scripts | Complete |
| Client runtime | Complete |
| Documentation | Complete |
| Hardening | Partially complete; client strict mode is enabled, remaining work is payload modeling and innerHTML reduction |
