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
- the repository now implements and has deployed a producer/consumer handoff: the collector image
  creates an atomic SQLite Backup API snapshot and ready receipt, while the
  offline archive image consumes one exact snapshot ID through a read-only
  handoff. The archive container no longer mounts the live `statistics-data`
  directory;
- snapshot publication normalizes the private copy from WAL to DELETE journal
  mode so DuckDB can read the read-only mount without sidecars. Creation also
  reserves the database size plus a free-space floor, permits only one ready
  snapshot, and fails visibly on interrupted artifacts;
- the exact-ID workflow has been exercised in production. The second run used
  snapshot `20260808T152105Z-9fe019f42bc3`, published 25 new partitions from
  595,137 source rows, passed `verify --all`, and released the 9.5-GiB handoff;
  the two manifests now cover 230 verified partitions and 40,581,635 bytes;
- production raw-payload retention was raised from 7 to 30 days on 8 August.
  A measurement of 64,853 retained payloads used 129,688,857 compressed bytes,
  about 1,999.7 bytes per service. Full observed days were about 15.9 MiB/day,
  implying roughly 476 MiB for 30 days, 1.39 GiB for 90 days, or 5.65 GiB/year
  before SQLite/page and Parquet overhead;
- optional raw-payload Parquet export now preserves the latest compressed
  provider detail per service when explicitly enabled. It is not a complete
  request log and remains disabled until local or off-VPS long-term capacity is
  intentionally allocated.

The first archive is evidence that normalized Parquet is compact, but it is not
a fair 9.5-GiB-to-35-MiB compression comparison. The live SQLite file contains
legacy duplication, raw JSON, indexes, WAL-era allocation, and free pages that
the analytical dataset intentionally omits. Record at least several daily
increments and one complete month before setting a storage-growth forecast.

The normalized archive remains the default permanent dataset. It contains the
service, observation, stop, collection-health, station/relation aggregate, and
station-dimension tables needed for analytical marts. The optional raw dataset
contains the exact compressed `train_raw_payloads` BLOB plus its format,
quality, and observation metadata. It does not include legacy duplicated
`trains.raw_json`, per-stop legacy JSON, station-board provider bodies, failed
HTTP responses, or successive raw versions of the same service.

## Delivery tracker

This table is the implementation source of truth for analytics work. Update the
status and acceptance evidence in the same pull request that changes a stage.

| Stage | Status | Acceptance condition |
| --- | --- | --- |
| Operational storage v2 | Completed | Service/collection dates, canonical identity, stop events, retry state, and compressed payloads are deployed and covered by tests. |
| Consistent snapshot handoff | Completed | The collector publishes one exact ready snapshot; the archive consumes it read-only and release is lock-safe. |
| Immutable Parquet archive | Completed | Completed manifests are additive, `verify --all` passes, and normalized grains remain distinct. |
| Professional semantic layer | Completed | `quality_day`, stabilized service/stop facts, daily metrics, and exact 7/28/90-day windows are built from completed manifests into an atomic derived SQLite model. |
| Analytics query API | Completed | Versioned metadata, overview, ranking, outlier, and formula-safe CSV endpoints read only the derived analytics database and preserve the last good model when a rebuild fails. |
| Public professional dashboard | Completed | Live remains the default; historical performance is lazy-loaded, mobile-first, multilingual, accessible, source-backed, and visibly qualified. |
| Private analyst workbench | Deferred | A dedicated read model and authenticated workbench are deployed without access to the live collector database. |
| Off-VPS archive copy | Deferred | A completed manifest and its exact files are verified from a fresh second-VPS download before being called a backup. |

### Current milestone: reliability and long-tail performance

The current implementation sequence is deliberately narrow enough to reconcile
before adding more visual surfaces:

1. build the semantic facts and `quality_day` from completed Parquet manifests;
2. materialize network/operator/category/station/relation daily and rolling
   metrics into a small atomic SQLite read model;
3. expose metric metadata, exact denominators, coverage, comparable windows,
   rankings, outliers, and CSV through `/v1/analytics/*`;
4. add a separate historical-performance mode to `/statistics/`, while keeping
   today's live operations as the default;
5. validate the Cloudflare preview on narrow mobile, desktop, all three
   languages, and light/dark themes before merging.

The first public analytical view prioritizes arrival punctuality at 5 and 15
minutes, full observable cancellation, p50/p75/p90/p95 arrival delay, severe
delay above 30/60/120 minutes, delay buckets, sample size, and source quality.
It does not publish a composite reliability score or prediction.

Implemented constraints are deliberate and visible in the product:

- stabilized service outcomes trail live operations by the configured active
  service TTL, currently seven days, so the UI labels the latest archived
  service date separately from the read-model build time;
- a selected 28/90-day window may initially contain fewer actual service days;
  `serviceDays / windowDays` is displayed and the previous-window delta remains
  unavailable until both windows are complete;
- operator/category rolling windows are available through the retained history;
  station/relation ranking windows are materialized for the latest archive date
  to keep the public read model compact;
- the outlier mart keeps the network-wide extreme tail plus per-operator,
  per-category, and operator-category tails so a smaller segment is not erased
  by a global top-N cutoff;
- exact trip identity and extreme delays are retained, while provider failures,
  unresolved identity and incomplete outcomes remain exclusions rather than
  invented zeroes or cancellations.

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
the successful run. During the explicitly local-only phase, release it after
local `verify --all` and record that the archive is not protected against loss
of the production VPS. Once remote storage is configured, require a fresh
off-VPS download and `verify --all` before release. Never implement age-based
deletion of handoff files, archive partitions, or rollback backups. A stale
snapshot is an operator-visible failure, not permission to select the newest
file automatically.

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

### Public chart renderer

Use a custom BelloTreno dashboard with tree-shaken Apache ECharts loaded only
when the historical-performance mode is opened. Ordinary daily trends,
distribution bars, and the 90-day calendar use SVG; switch an individual view
to Canvas only when measured mark count or mobile performance justifies it.
Every chart needs an equivalent data table or textual summary, non-colour state
encoding, reduced-motion behavior, and touch/focus interaction. Metric
calculation remains in the semantic layer rather than ECharts transforms.

Reference products contribute principles rather than layouts:

- Zugfinder: exact-service history and an outlier explorer;
- chuuchuu: future journey/corridor reliability framed around a passenger
  decision;
- ORR Data Portal: explicit definitions, denominators, provisional status,
  operator/route/station breakdowns, and downloads;
- Eurostat railway transport: metadata, methodology, quality, frequency, and
  revision context.

BelloTreno must not borrow official-sounding completeness or metric names when
its observable source cannot support the same denominator.

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
3. **Completed:** replace the live-database archive mount with atomic
   snapshot handoff and exact-ID `create -> plan/run -> local verify ->
   release`; two local manifests and 230 partitions now pass `verify --all`.
4. **Optional later operations:** configure Cloudreve/rclone on the host,
   upload datasets before manifests, verify a fresh download on the second VPS,
   and separately copy/checksum the pre-v2 SQLite rollback file. This is
   intentionally postponed, so a local-only archive is not yet a backup against
   production-VPS loss.
5. **Next reliability:** schedule the workflow with a lock and alerts. Once a
   remote target is enabled, make release contingent on remote verification;
   never schedule archive/backup deletion.
6. **Completed — semantic analytics:** build stabilized service/stop facts,
   `quality_day`, network/dimension daily aggregates, and exact 7/28/90-day
   rolling windows from completed Parquet manifests. Publish the derived SQLite
   read model atomically and keep the previous model on failure.
7. **Completed — query contracts:** deliver `/v1/analytics/meta`, `overview`,
   `rankings`, `outliers`, and filtered CSV. Preserve nulls, numerators,
   denominators, exclusions, samples, coverage state, source manifests, and the
   metric-definition version.
8. **Completed — public product:** add live/performance modes, ECharts trend,
   distribution, percentile, calendar, long-tail, dimension ranking, and
   outlier views. Keep live as the default and use Cloudflare Preview for final
   responsive visual approval.
9. **Following — dimension drill-down:** add operator, category, station, and
   relation detail views; weekday/hour baselines; delay propagation and
   recovery; shareable URL state; and stable service-instance links.
10. **Later — journey decisions:** define a separately versioned recurring
    service-pattern identity, obtain a trustworthy timetable/transfer model,
    then evaluate corridor choice and connection reliability. Never infer a
    recurring service from train number alone.
11. **Later — advanced analysis:** after at least 90 stable days, evaluate
    seasonal baselines, robust anomaly detection, incident windows, and only
    then prediction with an explicit backtest and calibration report.
12. **Later — spatial and private analysis:** add a station/route map only after
    coordinate and topology coverage pass QA; deploy a private DuckDB notebook
    or BI workbench against a dedicated read model, never the live SQLite file.

Every promoted metric needs a definition, numerator, denominator, grain, time
basis, coverage requirement, refresh cadence, and known limitation.
