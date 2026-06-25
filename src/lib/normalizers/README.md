# BelloTreno Normalizers

This folder is the migration boundary for data that comes from external APIs or the VPS statistics service.

Browser runtime source now lives in `src/client/**/*.ts`. New pure logic should be added here first when it can be tested without the DOM, then wired into the owning client module.

## Rules

- Normalizers are data-only. They should not touch `document`, `window`, local storage, or network APIs.
- Inputs should be treated as untrusted external data.
- Outputs should be stable display models that UI code can consume.
- If a bug is fixed in a normalizer, add or update a fixture test before wiring it into the UI.
- Keep compatibility globals in `src/types/bellotreno-globals.d.ts` only when an Astro template or existing runtime boundary still needs them.

## Current modules

- `statistics.ts`: category/status helpers for the statistics dashboard.
- `swiss.ts`: Swiss formation gatekeeping, border station protection, and vehicle identity merging.
- `viaggiatreno.ts`: station-name matching, stop-time status evidence,
  partial-cancellation state detection, and subtitle-derived actual route
  endpoints for `Parte da ...` / `Arriva a ...` notices.
