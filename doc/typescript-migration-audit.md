# TypeScript Migration Audit

Last updated: 2026-06-01

This document records the TypeScript migration state for the single PR on
`codex/typescript-migration`. The goal is to keep the project reviewable while
moving source code out of untyped JavaScript and into typed, bundler-managed
modules.

## Current State

The repository source has been migrated to TypeScript for the active JavaScript
surfaces:

| Area | Current source | Type checking |
|------|----------------|---------------|
| Browser runtime | `src/client/**/*.ts` | `tsconfig.client.json` |
| Shared normalizers | `src/lib/normalizers/**/*.ts` | `tsconfig.normalizers.json` |
| Cloudflare Pages Functions | `functions/api/**/*.ts` | `tsconfig.functions.json` |
| Node scripts and JS tests | `scripts/**/*.ts`, `tests/js/**/*.test.ts` | `tsconfig.node.json` |

`public/scripts/` is no longer the browser source location. Shared runtime
modules are imported by `BaseLayout.astro`, and page modules are imported by the
owning Astro page through `slot="scripts"`.

## Architecture Boundaries

- `src/client/config.ts`, `i18n.ts`, and `common.ts` are the shared runtime base
  and must load before page modules.
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

- raw JavaScript syntax check for any remaining JS files;
- TypeScript checks for normalizers, Functions, Node scripts/tests, and client
  modules;
- Node tests under `tests/js/`;
- i18n key parity for `zh`, `en`, and `it`;
- Python compile/unit checks for the VPS services.

When deployment configuration or `rfi-proxy/` changes, also run:

```bash
docker compose config
```

from `rfi-proxy/`.

## Remaining Hardening

The browser modules currently keep migration compatibility through scoped
`// @ts-nocheck` comments on the large runtime files. This is intentional for
the first full-source migration because it avoids mixing behavior changes with
thousands of DOM and upstream payload type decisions.

Recommended hardening order:

1. Add local interfaces for repeated API payloads in `src/client/main.ts`,
   `station.ts`, `statistics.ts`, and `swiss.ts`.
2. Remove `// @ts-nocheck` one file at a time, starting with the smallest page
   runtime modules.
3. Move reusable pure helpers from client files into `src/lib/normalizers/` or
   a new typed client utility module when they can be tested without the DOM.
4. Replace remaining string-template `innerHTML` surfaces according to
   `doc/innerhtml-audit.md`.
5. Keep global `window.*` declarations in `src/types/bellotreno-globals.d.ts`
   as a compatibility boundary only. New feature code should prefer imports.

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
| Hardening | Partially complete; large client files remain in migration mode |
