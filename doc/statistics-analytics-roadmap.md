# Statistics analytics roadmap

BelloTreno has two different analytics needs. They should share metric
definitions, but they should not share the same user interface or query load.

## Current status (August 2026)

The foundation is now usable rather than hypothetical:

- storage v2 separates train services, observations, stop events, and compressed
  raw payloads while retaining the legacy API compatibility window;
- collection-day and service-day coverage are explicit, and incomplete days are
  not converted into zero or compared as if they were complete;
- the public Statistics page has a responsive dashboard shell, date comparison,
  trends, station/relation exploration, rankings, CSV export, and mobile-specific
  layout work;
- the first production Parquet run preserved 3,453,523 normalized rows in 205
  immutable partitions. It produced 34,367,647 bytes of ZSTD Parquet (about
  35 MiB on disk), and the archive verifier passed;
- the repository now implements a producer/consumer handoff: the collector image
  creates an atomic SQLite Backup API snapshot and ready receipt, while the
  offline archive image consumes one exact snapshot ID through a read-only
  handoff. The archive container no longer mounts the live `statistics-data`
  directory. Production activation still requires publishing and deploying both
  updated images and Compose configuration;
- snapshot publication normalizes the private copy from WAL to DELETE journal
  mode so DuckDB can read the read-only mount without sidecars. Creation also
  reserves the database size plus a free-space floor, permits only one ready
  snapshot, and fails visibly on interrupted artifacts;
- the remaining deployment work is validating that exact-ID workflow on the VPS,
  then scheduling manifest-scoped export and adding a verified off-VPS copy
  before handoff snapshots are released.

The first archive is evidence that normalized Parquet is compact, but it is not
a fair 9.5-GiB-to-35-MiB compression comparison. The live SQLite file contains
legacy duplication, raw JSON, indexes, WAL-era allocation, and free pages that
the analytical dataset intentionally omits. Record at least several daily
increments and one complete month before setting a storage-growth forecast.

## Two surfaces

1. **Public Statistics dashboard** — a curated, fast, multilingual product that
   answers a small set of passenger and railway-observer questions. It uses only
   versioned API contracts, never arbitrary SQL.
2. **Private analyst workbench** — a Tableau-like environment for discovering
   patterns, validating definitions, and prototyping new public metrics. It may
   expose wider tables and SQL, but only to authenticated maintainers.

The public site should not iframe the unrestricted analyst workbench. A BI tool
is excellent for exploration, but a custom dashboard gives BelloTreno better
performance, accessibility, mobile behavior, terminology, and control over what
the data can legitimately claim.

## Recommended stack

### Current operational layer

Keep the collector's SQLite database as the operational source while one VPS,
one collector, and the existing API remain within measured capacity. WAL mode,
short indexed requests, and the current retention split fit this workload.

Do not point exploratory BI scans at the live writable file. Queries that group
millions of stops or fingerprint every column can compete with collection and
inflate the WAL.

### Snapshot handoff and Parquet layer

The statistics service creates a consistent SQLite Backup API snapshot in a
separate writable handoff. It publishes the database before an atomic ready
receipt. The archive service mounts only that handoff read-only, pins one exact
snapshot ID for both `plan` and `run`, and uses DuckDB to produce typed,
partitioned Parquet. DuckDB officially supports attaching SQLite and
reading/writing Parquet:

- <https://duckdb.org/docs/current/core_extensions/sqlite>
- <https://duckdb.org/docs/stable/data/parquet/overview>

This layer is reproducible without changing the collector database, and it gives
large scans a columnar format without a premature production-database migration.
The handoff database is temporary; immutable Parquet partitions and their
completion manifests are the long-term dataset.

Snapshot lifetime must remain bounded. Release only the exact snapshot used by
the successful run, and only after local `verify` plus a fresh off-VPS download
and `verify --all`. Never implement age-based deletion of handoff files, archive
partitions, or rollback backups. A stale snapshot is an operator-visible failure,
not permission to select the newest file automatically.

### Private BI workbench

Begin with DuckDB SQL and versioned notebooks directly over the verified Parquet
copy. This is the lowest-operational-cost way to reconcile metric definitions,
inspect distributions, and prototype marts without exposing a second query
service.

When a Tableau-like visual workbench is useful, self-host Metabase on the second
VPS and point it at a dedicated analytical read model, preferably PostgreSQL
tables materialized from verified Parquet. Do not point it at
`statistics-data/statistics.db` or keep a handoff snapshot alive merely for BI.
Use deliberate schema refresh, bounded filter scans, authentication, and a
separate resource budget. Candidate charts remain private until their metric
definitions and coverage rules reconcile with the public API.

If concurrent analysts, multi-year retention, or API latency later exceeds the
snapshot approach, move the analytical layer—not necessarily the collector—to
PostgreSQL or ClickHouse. Make that decision from query latency, refresh time,
storage growth, and operational burden rather than database fashion.

## Storage and recovery policy

The preferred off-VPS target is the separate 512-GB VPS through Cloudreve
WebDAV or direct file transfer. The upload process belongs on the host, not in
either application image:

1. create one exact handoff snapshot;
2. run archive `plan` and `run` against that same ID;
3. verify the local manifest and files;
4. derive an exact file list from each completed manifest, use host-side rclone
   `copy` for only those dataset files, and verify their downloaded content;
5. copy that exact `.complete.json` manifest last;
6. download the remote prefix into a fresh directory on the second VPS and run
   `verify --all` there;
7. release only the exact handoff snapshot after all preceding steps pass.

Use `copy`, not `sync`, and do not enable unattended deletion. WebDAV/rclone
credentials never enter Git, Compose, an image, a Parquet file, or a manifest.
OneDrive or Google Drive can later become a third failure domain, but they are
not required for the first safe rollout. Cloudreve and Gitea on the same machine
remain one failure domain.

Private GitHub or Gitea repository visibility does not make ordinary Git a
database-backup format. Git LFS is technically possible but adds quota,
bandwidth, history, and restore coupling. A Gitea Generic Package can be a
secondary publication interface only if the Gitea instance itself is backed up;
prefer Git repositories for small manifests, schemas, metric definitions,
notebooks, and signed recovery records. Cloudreve, Gitea, and direct SFTP paths
on the same 512-GB VPS remain one fault domain.

Use the storage surfaces for different jobs:

| Surface | Store here | Role |
| --- | --- | --- |
| Private GitHub/Gitea Git repository | schemas, metric definitions, notebooks, small manifests, restore instructions | versioned control plane, not bulk data |
| Second-VPS filesystem through SFTP or Cloudreve WebDAV | immutable Parquet partitions and completed manifests | primary off-production archive |
| Gitea Generic Package, optionally | selected monthly or release bundles plus their checksums | secondary distribution layer, never the only copy |
| OneDrive/Google Drive, optionally | another verified copy of completed immutable bundles | third failure domain |

GitHub blocks ordinary Git objects above 100 MiB, recommends a file-sharing
service for large databases, and makes Git LFS a separate quota- and
pointer-based storage workflow. Gitea's Generic Package Registry can publish
arbitrary files through an authenticated HTTP API, but those package objects
then become part of the Gitea instance's own storage and recovery burden. See:

- <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>
- <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage>
- <https://docs.gitea.com/usage/packages/generic/>
- <https://docs.gitea.com/administration/backup-and-restore/>

The old 9.5-GiB pre-v2 SQLite rollback file has a different purpose from the
Parquet dataset. Copy it once over SFTP/rsync to the second VPS, compare SHA-256
on both hosts, and keep a restore record. Do not commit SQLite or Parquet as
ordinary Git objects. GitHub/Gitea are appropriate for small manifests, schemas,
data dictionaries, and recovery instructions; a Gitea Generic Package may be an
optional publication layer, not the only data backup.

Capacity should be measured rather than guessed:

```text
safe_months = usable_remote_bytes / median_monthly_archive_increment_bytes
```

`usable_remote_bytes` must reserve room for Cloudreve/Gitea, temporary downloads,
filesystem overhead, and at least one restore drill. Track the total immutable
archive size after every run and calculate the median increment only after a
full month. Retention can then be expressed in months with a clear low-space
alarm instead of relying on the headline 512-GB disk size.

## Observed provider-quality behavior

The 6 August diagnostic showed that 55 of 56 latest detail failures were
`empty_or_non_object_payload`; most were canonical `REG` services near the end
of the seven-day active window, commonly still labelled `not_departed`. A single
row was an identity mismatch. The collector continued successfully and persisted
exponential retry eligibility.

This is consistent with an unstable or expired ViaggiaTreno detail response and
is not an archive failure. It should appear in data-quality reporting as source
availability and retry backlog, not be silently rewritten as cancellation or
zero delay. Revisit the retry policy only if the failure share stays materially
high, complete collector runs are missed, or identity mismatches rise sharply.

## Semantic grains

Every metric must declare its grain and time basis:

| Grain | Identity | Primary time basis | Typical use |
| --- | --- | --- | --- |
| Train service | `service_date + train_key` | planned service day | final service outcome, route reliability |
| Observation | service identity + `observed_at` | `collection_date` | network state at a sampled time |
| Stop event | service identity + stop number | event timestamps | station punctuality and delay propagation |
| Station day | station code + day + board type | collection/service day, explicitly named | station comparison |
| Relation day | origin + destination + day | service day | corridor comparison |

`train_key` remains the ViaggiaTreno-derived triplet: train number, origin code,
and scheduled departure time. Train number alone is never a service identity.

Collection-day and service-day questions are different:

- “What did BelloTreno observe on Tuesday?” uses `collection_date`.
- “How did trains scheduled to begin on Tuesday eventually perform?” uses
  `service_date` and must wait for the active-service stabilization window.

## Analytical marts and contracts

The public API should query compact, versioned marts rather than scanning raw
Parquet in a browser request. Each build records its source manifest IDs and
metric-definition version.

| Mart | Grain | Required outputs |
| --- | --- | --- |
| `fact_service_outcome` | one stabilized train service | final status, departure/arrival delay, operator, category, origin/destination, completed/quality flags |
| `fact_observation_slot` | service + sampled slot | observed state, current delay, collection coverage, detail availability |
| `fact_stop_outcome` | service + stop number | scheduled/actual arrival and departure, dwell, delay gained/lost, platform evidence |
| `agg_network_day` | collection or service day, explicitly named | counts, rates, delay quantiles/buckets, completeness, source-manifest ID |
| `agg_operator_category_day` | operator + category + service day | sample, punctuality thresholds, cancellation, p50/p90/p95 delay |
| `agg_station_day` | station + event type + day | arrivals/departures, delay distribution, cancellation, sample threshold |
| `agg_relation_day` | origin + destination + service day | service sample, regularity, cancellation, delay distribution |
| `agg_weekday_hour` | weekday + hour + segment | recurring temporal baseline and comparable-window sample |
| `quality_day` | collection day | expected/received slots, station/board coverage, detail success, retries, stale/identity failures |

Rates must return numerator, denominator, excluded count, sample threshold, and
coverage state. Quantiles must state whether they use final arrival, final
departure, maximum observed, or stop-event delay. No API field should be named
simply `averageDelay` when its underlying event is more specific.

## Metric families worth mining

### Trust and coverage

- observed stations, boards, trains, details, and stop events;
- collection success, duration, failure rate, and freshness;
- missing slots and date gaps;
- detail completion and retry backlog;
- sample size and completeness beside every derived rate.

### Daily operating outcome

- monitored services, regularity, delayed share, cancellation share;
- median, p75, p90, p95, and maximum delay instead of average alone;
- delay buckets (`0–5`, `6–15`, `16–30`, `31–60`, `61–120`, `>120` minutes);
- departure versus arrival punctuality;
- current partial-day values compared only with the same elapsed-time window.

### Network explanation

- station and relation rankings with a minimum sample threshold;
- category/operator mix and reliability;
- recurring time-of-day and weekday patterns;
- delay propagation between consecutive stops;
- concentration: how much disruption is explained by the worst stations,
  corridors, or services;
- recovery: services that reduce delay between origin and destination.

### Event and anomaly analysis

- extreme delays remain present and receive quality flags;
- distinguish a source anomaly from a genuine operational outlier;
- show first seen, peak, recovery, and final state for long-running services;
- compare an incident window with comparable weekdays, never an arbitrary day.

Predictive claims should wait until there is enough stable history and a defined
evaluation method. The first useful models are descriptive baselines and anomaly
scores, not passenger-facing delay promises.

## Public dashboard priorities

The next UI should answer a question first and expose the calculation second. It
should remain a custom, responsive BelloTreno experience rather than embedding
the private BI workbench.

### 1. Trust before ranking

- a compact freshness/coverage strip with expected versus received slots;
- a calendar that distinguishes `live`, `complete`, `partial`, and
  `unavailable`, with missing days shown as gaps rather than zero;
- a metric-definition drawer containing numerator, denominator, time basis,
  sample, and known limitations;
- source-error and retry backlog trends, separated from operational disruption.

### 2. Comparable outcomes

- punctuality at `<=5`, `<=15`, and `<=30` minutes, cancellation share, p50,
  p90, and p95 final delay;
- 7/28/90-day windows, same-weekday baseline, and a custom range;
- live-day comparison only against the same elapsed sampling window;
- deltas with both absolute percentage points and underlying sample change.

### 3. Explain the distribution

- delay-bucket stacked bars and a cumulative percentile curve;
- weekday × hour heatmap with accessible table fallback;
- operator/category small multiples using the same axis and minimum sample;
- an outlier panel that preserves extreme delays but shows quality evidence and
  first/last observation timestamps.

### 4. Explore the network

- station explorer with arrivals/departures separated, trend, sample, and nearby
  ranking context;
- corridor explorer comparing relations over time rather than only one-day
  totals;
- service drill-down showing delay propagation and recovery between stops;
- geographic station view only after coordinate coverage and mobile interaction
  are validated; the map must not replace the accessible table.

### 5. Mobile interaction quality

- stacked controls and bottom-sheet filters instead of clipped desktop selects;
- horizontal table scrolling only for true data matrices, with frozen identity
  columns and an explicit scroll cue;
- chart summaries and accessible data tables for narrow screens and assistive
  technology;
- stable card heights, correct Material Symbols glyphs, and no data labels that
  overlap status or source notes;
- remembered date/range/filter state without hiding that a selected day is
  partial or live.

## Delivery stages

1. **Completed:** publish honest v2 coverage, missing-value semantics, and
   complete-day comparison eligibility.
2. **Completed:** establish immutable, verified, partitioned Parquet and record
   the first successful production archive.
3. **In this change:** replace the live-database archive mount with atomic
   snapshot handoff and exact-ID `create -> plan/run -> local verify ->
   manifest-scoped off-VPS copy -> fresh-download verify -> release`.
4. **Next operations:** configure Cloudreve/rclone on the host, upload datasets
   before manifests, verify a fresh download on the second VPS, and separately
   copy/checksum the pre-v2 SQLite rollback file.
5. **Next reliability:** schedule the workflow with a lock and alerts, but keep
   release contingent on remote verification and never schedule archive/backup
   deletion.
6. **Next analytics:** build `quality_day`, `fact_service_outcome`, and
   `agg_network_day`, then add comparison/distribution APIs with sample sizes.
7. **Next product:** deliver trust/coverage, comparable outcomes, distributions,
   and operator/category/station/corridor drill-down in mobile-first stages.
8. **Later:** deploy a private workbench against a dedicated analytical read
   model and promote only stable, reconciled metrics into the public API/UI.

Every promoted metric needs a definition, numerator, denominator, grain, time
basis, coverage requirement, refresh cadence, and known limitation.
