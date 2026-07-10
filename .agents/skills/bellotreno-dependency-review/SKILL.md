---
name: bellotreno-dependency-review
description: Review and verify BelloTreno dependency updates with release-note, advisory, lockfile, CI, and runtime-risk analysis. Use for Dependabot pull requests, npm or GitHub Actions upgrades, npm audit findings, vulnerable transitive packages, package-manager or Node changes, grouped updates, and proposed Python or Docker dependency automation.
---

# BelloTreno Dependency Review

Treat bot-generated updates as proposed code changes, not trusted automation.
Keep compatible maintenance separate from major migrations.

## Establish Scope

1. Inspect `package.json`, `package-lock.json`, `.node-version`, the affected
   workflow, and `.github/dependabot.yml`.
2. Identify current, requested, compatible, and latest versions. Use
   `npm outdated --json` for npm and read primary release notes or advisories for
   material changes.
3. Classify every update as patch, minor, major, date-versioned, GitHub Action,
   transitive security resolution, or toolchain migration.
4. For grouped PRs, assess each direct dependency and the combined lockfile
   blast radius. Split a risky or unrelated major from routine maintenance.

## Evaluate Risk

- Check Astro, Tailwind, DaisyUI, TypeScript, Node types, and Cloudflare types as
  a compatible toolchain rather than isolated packages.
- Treat Astro or Vite changes as build and development-server changes even when
  the deployed site is static.
- For GitHub Actions, review permissions, input changes, runner/runtime changes,
  cache behavior, and whether the pinned major is still supported.
- Map an advisory to the affected dependency path and repository usage. Record
  whether it is runtime, build-time, development-only, Windows-specific, or
  unreachable; do not dismiss severity without that evidence.
- Preserve `packageManager`, `engines`, and `.node-version` unless the toolchain
  update is explicitly in scope.

## Apply Updates Safely

Use the package manager to update `package-lock.json`; do not hand-edit resolved
versions. Avoid `npm audit fix --force`. Do not accept unrelated major upgrades
or broad overrides merely to make audit output disappear.

Keep Python and Docker Dependabot disabled until the project defines version
constraints and supported Python runtime policy. If that policy is requested,
design and validate it as a separate migration.

## Verify

1. Inspect the manifest and lockfile diff for unexpected packages, registry
   changes, lifecycle scripts, or major transitive jumps.
2. Run `npm ci` from the updated lockfile.
3. Run `npm run check` and `npm run build`.
4. Run `npm audit --json` again and compare affected paths and severities with
   the baseline. Do not promise zero findings unless the output proves it.
5. Invoke `$bellotreno-change-gate` for browser, Functions, Python, or Docker
   checks required by the changed dependency surface.

## Decide And Report

Recommend merge, split, hold, or migrate. Report versions changed, release-note
or advisory implications, lockfile scope, checks performed, remaining findings,
and any manual preview or production validation still required. Never enable
auto-merge solely because CI is green or the author is Dependabot.
