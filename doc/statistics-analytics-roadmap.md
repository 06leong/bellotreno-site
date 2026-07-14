# Statistics analytics roadmap

BelloTreno has two different analytics needs. They should share metric
definitions, but they should not share the same user interface or query load.

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

### Analytical snapshot layer

Create a consistent SQLite Backup API snapshot on a schedule, then use DuckDB
to build typed daily facts and partitioned Parquet extracts. DuckDB officially
supports attaching SQLite and reading/writing Parquet:

- <https://duckdb.org/docs/current/core_extensions/sqlite>
- <https://duckdb.org/docs/stable/data/parquet/overview>

This layer is disposable and reproducible. It can be rebuilt without changing
the collector database, and it gives large scans a columnar format without a
premature production-database migration.

Snapshot retention must be bounded. Keep one active analytical snapshot and,
at most, one last-known-good replacement while an integrity check is running;
delete the superseded copy only after the new snapshot passes validation. Abort
refresh before writing when free space is below twice the live database size
plus a 5 GiB safety margin. Parquet outputs should use their own explicit
retention policy rather than accumulating unbounded dated SQLite copies.

### Private BI workbench

Start with self-hosted Metabase. Its maintained database drivers include SQLite,
and it provides a visual query builder, saved questions, filters, dashboards,
and SQL for deeper investigation:

- <https://www.metabase.com/docs/latest/databases/connections/sqlite>
- <https://www.metabase.com/docs/latest/databases/connecting>

Connect Metabase to a separate read-only snapshot, not
`statistics-data/statistics.db`. Disable automatic re-query for simple
explorations, schedule schema sync deliberately, scan filter values only on
demand, and keep periodic refingerprinting off unless it is needed. The official
SQLite connection guide calls out the cost of scans and automatic exploration
queries.

If concurrent analysts, multi-year retention, or API latency later exceeds the
snapshot approach, move the analytical layer—not necessarily the collector—to
PostgreSQL or ClickHouse. Make that decision from query latency, refresh time,
storage growth, and operational burden rather than database fashion.

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

## Delivery stages

1. Publish honest v2 coverage, missing-value semantics, and complete-day
   comparison eligibility.
2. Redesign the public dashboard around outcome, movement, explanation, and
   drill-down.
3. Add server-side comparison and distribution endpoints with sample sizes.
4. Produce daily analytical snapshots and a documented DuckDB transformation.
5. Deploy private Metabase against the snapshot and use it to validate candidate
   metrics.
6. Promote only stable, reconciled metrics into the public API and UI.

Every promoted metric needs a definition, numerator, denominator, grain, time
basis, coverage requirement, refresh cadence, and known limitation.
