# Analytics memory regression — 5 September 2026

This change addresses the incomplete memory fix in `f85bd0f`. It has not been
deployed to the VPS. Local synthetic results are not evidence that the live
archive or Linux container has passed.

## Implementation

- Service/stop joins constrain both inputs to the active service-date batch.
- Completed facts are checkpointed into `analytics-*/work.duckdb`, inside the
  disposable publication work directory. The archive and live collector DB
  remain separate from this work database.
- Daily aggregates and historical rolling as-of dates use one-day batches.
- Dashboard aggregates process one window, comparison period and filter type
  at a time. Station groups additionally use 16 disjoint station-key shards.
  Each group retains its complete sample set for exact quantiles and distinct
  service counts; daily percentiles are never averaged together.
- Outlier ranking carries service identities through the four ranking windows,
  then joins the selected identities back to their full service records.
- SQLite export bounds the SQL result itself to 5,000 physical rows per query.
- SQLite index sorting runs in a fresh process after DuckDB closes, with
  `SQLITE_TMPDIR` set before process startup and `temp_store=FILE`. Scratch files
  are removed on success or failure. A runtime environment override was
  insufficient because SQLite caches the directory during initialization.
- Parquet service-date metadata is read once to select batch input files;
  collection-date filenames are never mistaken for service-date boundaries.
- Narrow station shards covering at most 180 days are materialized once and
  reused across dashboard periods and scopes instead of rehashing full history.
- Defaults and daily preflight agree on `128MB` DuckDB buffers, one thread,
  one-day fact/rolling batches, 384 MiB container RAM and 2 GiB RAM-plus-swap.
  The CI memory test allows no additional swap.

DuckDB's buffer limit is not a total-process memory limit. Its official
[OOM guidance](https://duckdb.org/docs/current/guides/troubleshooting/oom_errors)
describes allocations outside that budget. Disk-backed work and additional
queries trade CPU/I/O and disk space for smaller query working sets. The `4GB`
spill limit excludes the work DB/WAL and SQLite publication files.

## Correctness and routine checks

- All 14 business tables exactly match the saved pre-change reference for the
  14-day mixed operator/category fixture, using row counts and SQL `EXCEPT` in
  both directions. This includes nulls, quantiles, counts and exclusions.
- The checked-in equivalence test compares segmented dashboard queries with
  unsegmented queries across current/previous 7/28/90-day boundaries, repeated
  service identities across dates, multiple operators, cancellations and nulls.
- Export tests cover multiple batches, rowid gaps, empty tables, dates,
  booleans and nulls.
- An injected failure after the first SQLite table is exported preserves the
  previous published database byte-for-byte and removes the work directory and
  partial publication file.
- The initial `npm run check` passed, including 78 Node tests and 122 Python tests with
  DuckDB available; no test skips.
- The process-isolation/file-pruning follow-up passed the complete check again:
  78 Node tests and 124 Python tests, plus the production build and daily shell
  scenarios. Its local 400,000-row index-sort smoke also passed. Linux negative
  control, dense-history and two-year gates remain the required CI evidence.
- `npm run build`: passed with `ASTRO_TELEMETRY_DISABLED=1`. The initial attempt
  could not create Astro's telemetry directory outside the workspace sandbox.
- Daily automation shell scenarios and shell syntax: passed.
- CI and Compose YAML parsing: passed. Docker Compose resolution was not run:
  Docker is unavailable on this Windows host.
- The checked-in full-pipeline generator/validator also passed a 7-day,
  100-services/day local smoke run.

## Local full-pipeline resource result

Final production SQL completed the 90-day fixture on Windows / Python 3.14 /
DuckDB 1.5.5 with a `128MB` buffer budget and one thread:

| Measurement | Result |
| --- | --- |
| Build | Success; all 14 business tables published |
| Observed services | 720,000 across 90 service days |
| Stop events in source | 8,640,000 |
| Process RSS sampling peak | 269.28 MiB |
| Process private-memory sampling peak | 253.38 MiB |
| DuckDB spill sampling peak | 0.124 GiB |
| End-to-end elapsed time | 1,077.21 seconds (about 18 minutes) |
| Published SQLite size | 127,791,104 bytes |

The diagnostic wrapper sampled the entire Python process every 200 ms and
recorded queries, without rewriting production SQL. Sampling can miss short
peaks; it does not measure Linux cgroup memory accounting. The spill figure
excludes the work database and SQLite output. No container RAM limit was
enforced locally.

For comparison, the saved `f85bd0f` run failed on only 60 days at `192MB`
DuckDB buffers (283.67 MiB sampled process RSS). The intermediate segmented
experiment still failed on 90 days at `128MB` (448.63 MiB sampled RSS).
The final fix therefore depends on query/storage changes, not just the
lower buffer setting. The 18-minute local runtime also exceeds the default
900-second collector safety interval: scheduling and actual VPS duration
remain deployment checks, not a proven non-overlap guarantee.

## Reproduce the container regression

`tests/ops/statistics_analytics_memory.py` generates synthetic daily Parquet and
then calls the production builder without modifying its SQL. The full fixture
contains 90 service days, 720,000 services, 5,760,000 observations and 8,640,000
stop events. Generation runs outside the resource-constrained container.

The exact build and container commands are in `.github/workflows/ci.yml`.
The container uses the real archive image, a read-only archive mount, no
network, one CPU, 384 MiB RAM and no additional swap. It verifies all 14 output
tables, exact service/arrival-sample totals, all three window lengths, SQLite
integrity and work-directory cleanup. Successful runs print RSS/cgroup peak
measurements and save `resources.json` in the fixture directory.

The first Linux memory run (CI 33969245299) completed all semantic calculations
but failed creating `idx_dimension_day`: SQLite exhausted the 16 MiB `/tmp`
tmpfs with index-sort spill. DuckDB's configured spill directory does not
configure SQLite. The follow-up routes SQLite temporary files to disk as
described in its [temporary storage documentation](https://www.sqlite.org/tempfiles.html#temporary_file_storage_locations),
while preserving the same memory and tmpfs limits in the regression gate.
That environment-only follow-up also failed in CI 33970345088: the library
had already cached its temp directory. The current finalizer instead starts a
fresh process with the directory supplied at process creation. A quick Linux
negative-control test must reproduce `SQLITE_FULL` in the old same-process
path and then complete the same 400,000-row sort through the production helper.
The CI now also exercises 730 days at 100 services/day; this covers calendar
and partition growth, not two years at full production density.

See [the architecture and reliability review](statistics-reliability-review.md)
for the full data path, resource boundaries and production acceptance criteria.

Before restoring the daily timer, verify the corrected gate and perform one controlled build
against the actual VPS archive. Check elapsed time as well as memory, scratch
disk use, publication identity and collector health; shard-based queries do
more scans, so synthetic completion does not establish the VPS run duration.
