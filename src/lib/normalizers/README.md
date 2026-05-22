# BelloTreno Normalizers

This folder is the migration boundary for data that comes from external APIs or the VPS statistics service.

The current browser runtime still lives mostly in `public/scripts/`, but new pure logic should be added here first and covered by fixtures in `tests/js/`. Runtime scripts can then migrate one behavior at a time without rewriting the full page.

## Rules

- Normalizers are data-only. They should not touch `document`, `window`, local storage, or network APIs.
- Inputs should be treated as untrusted external data.
- Outputs should be stable display models that UI code can consume.
- If a bug is fixed in a normalizer, add or update a fixture test before wiring it into the UI.
- Keep compatibility with the existing `public/scripts/` globals until the entry point has been intentionally migrated.

## Current modules

- `statistics.js`: category/status helpers for the statistics dashboard.
- `swiss.js`: Swiss formation gatekeeping, border station protection, and vehicle identity merging.
- `viaggiatreno.js`: station-name matching and partial-cancellation state detection.
