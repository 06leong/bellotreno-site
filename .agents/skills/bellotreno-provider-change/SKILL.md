---
name: bellotreno-provider-change
description: Implement and diagnose BelloTreno railway data-provider changes across Cloudflare Pages Functions, VPS proxies, normalizers, browser modules, and tests. Use for new providers, endpoint or payload changes, incorrect train, station, formation, traffic, infomobility, or statistics data, proxy and authentication boundaries, or provider-specific regressions involving ViaggiaTreno or RFI, Italo, Swiss Open Data, Trenord, and the statistics service.
---

# BelloTreno Provider Change

Trace provider data from its source to visible behavior. Fix the earliest owned
boundary that can express the correct meaning; do not patch only the renderer.

## Establish The Call Chain

1. Read the root `AGENTS.md` and the provider-specific guide when one exists:
   - ViaggiaTreno/RFI: `doc/blog-viaggiatreno-api.md`
   - Italo: `doc/italo-integration-guide.md`
   - Swiss: `doc/swiss-open-data-integration-guide.md`
   - VPS/statistics: `rfi-proxy/README.md` and `doc/PROJECT_GUIDE.md`
2. Search with `rg` for the endpoint, response field, normalizer, and rendered
   label. Follow imports and fetch calls instead of assuming ownership from a
   filename.
3. Identify which boundary is in this repository. The public ViaggiaTreno,
   SmartCaring, and visitor-counter Workers are external; Pages Functions and
   the VPS Python services in this repository are owned here.
4. Reproduce the problem with a representative raw payload, URL, or existing
   test fixture. Separate missing upstream data from a parsing or rendering bug.

## Choose The Owned Boundary

| Data lane | Server boundary | Pure normalization | Browser consumer |
| --- | --- | --- | --- |
| ViaggiaTreno/RFI | external Worker or direct public feed | `src/lib/normalizers/viaggiatreno.ts`, `infomobilita.ts` | `main.ts`, `station.ts`, `infomobilita.ts` |
| Italo | `functions/api/italo/` | `src/lib/normalizers/italo.ts` | `main.ts`, `station.ts` |
| Swiss | `functions/api/swiss/` | `src/lib/normalizers/swiss.ts` | `swiss.ts`, `station.ts` |
| Trenord | `functions/api/trenord/traffic.ts` | `src/lib/normalizers/trenord.ts` | `main.ts` |
| Statistics | `functions/api/statistics/`, `rfi-proxy/statistics/` | `src/lib/normalizers/statistics.ts` | `statistics.ts` |

Put unstable provider shapes behind typed guards and pure normalizers. Preserve
unknown or absent states explicitly; do not invent operational certainty from
missing fields.

## Implement End To End

1. Add or update a focused normalizer fixture before wiring the UI when pure
   data behavior changes.
2. Keep secrets and authenticated upstream calls in Pages Functions or the VPS
   service. Never expose tokens through `PUBLIC_*` or browser code.
3. Preserve canonical URL builders and shared navigation helpers. Avoid adding
   new compatibility globals when normal imports work.
4. Treat every provider string, query parameter, Function response, and stored
   value as external. Prefer DOM builders and `textContent`; escape any value
   that must enter existing `innerHTML`.
5. Add `zh`, `en`, and `it` keys together when visible wording changes.
6. Update the relevant integration guide when an endpoint, payload contract,
   fallback, secret, or deployment boundary changes.

## Protect Cross-Provider Behavior

- Keep Swiss enrichment conservative at border stations and preserve
  segment-specific vehicle state.
- Keep Trenord notices line-level and limited to the correct operator gate.
- Preserve Italo station aliases, typed IDs, and ViaggiaTreno-compatible station
  navigation.
- Keep statistics wording observational rather than officially exhaustive.
- Do not modify an external shared Worker or production service unless the user
  explicitly places it in scope.

## Validate And Report

Run focused tests while iterating, then run `npm run check` and `npm run build`.
If VPS or Docker files changed, also run `docker compose config` from
`rfi-proxy/`. For visible behavior, invoke the browser testing workflow and
exercise the affected route in all relevant languages.

Report the upstream symptom, the owned root cause, the boundaries changed, the
fallback behavior, and the exact validation performed.
