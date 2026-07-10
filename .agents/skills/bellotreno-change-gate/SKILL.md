---
name: bellotreno-change-gate
description: Select and run risk-proportionate validation for BelloTreno changes before handoff, commit, push, or pull-request review. Use after modifying documentation, Skills, Astro pages, browser TypeScript, normalizers, Cloudflare Pages Functions, Python services, Docker deployment, dependencies, encoding-sensitive text, or external-data rendering, and when asked whether a change is ready to ship.
---

# BelloTreno Change Gate

Build a validation plan from the actual diff, execute it, and report evidence.
Do not claim checks that were not run.

## Inspect Before Testing

1. Run `git status --short` and inspect the scoped diff. Preserve unrelated user
   changes and identify generated or ignored output.
2. Read the root `AGENTS.md` and any closer nested instructions.
3. Classify the change by its highest-risk boundary rather than its file count.
4. For suspicious Chinese or accented text, read explicitly as UTF-8 and verify
   with `rg`, `git diff`, or code points. Do not classify console rendering as
   source corruption by sight alone.

## Select The Gate

| Change boundary | Minimum targeted evidence |
| --- | --- |
| Markdown, AGENTS, configuration | `git diff --check`; validate referenced commands and paths |
| Repository Skill | run `quick_validate.py` for every changed Skill and inspect `agents/openai.yaml` |
| Pure normalizer or URL state | run its focused Node tests and scoped TypeScript check |
| Browser module, Astro page, component, or CSS | `npm run check`, `npm run build`, then rendered browser QA |
| Pages Function or secrets boundary | Functions typecheck, full check/build, and request/fallback review |
| Python service | Python compile/unit tests; full check when shared with the repository |
| Docker or Compose | Python checks plus `docker compose config` from `rfi-proxy/` |
| Dependency or lockfile | use `$bellotreno-dependency-review` and run the full baseline |

Always run `git diff --check`. Before pushing a runtime or deployment change,
run both `npm run check` and `npm run build` even if targeted checks passed.

## Add Risk-Specific Checks

- Run `npm run audit:innerhtml` when external data, query strings, stored values,
  or HTML rendering changes. Review findings; the audit is a locator, not a
  proof of safety.
- Run `npm run check:i18n` whenever visible wording or translation keys change;
  the full check already includes it.
- Use the in-app browser and the frontend testing/debugging workflow first for
  rendered UI validation. Fall back to terminal Playwright only when that
  browser capability is unavailable and record why.
- Exercise the affected desktop and mobile layout, language switching, and
  light/dark/auto theme. Include train/station navigation or provider cards when
  the shared runtime changes.
- Use `SMOKE_BASE_URL` with `npm run smoke:pages` for a running local or preview
  deployment; do not pretend a static build alone tested network behavior.

## Interpret Failures

Fix failures caused by the scoped change. If a failure predates the change,
capture the command, output, and evidence that it is unrelated before deciding
whether to continue. Never weaken TypeScript, tests, security guards, or CI to
make the gate pass.

## Handoff

Summarize changed files by purpose, commands run and outcomes, browser scenarios
actually exercised, residual risks, and any checks that require preview or
production access. State clearly whether the work is ready to commit, ready to
push, or still blocked.
