# BelloTreno VPS services

This folder contains the VPS-side services used by BelloTreno:

- `rfi-proxy`: the ViaggiaTreno/RFI/Italo/Trenord proxy on port `8080`.
- `bellotreno-statistics`: the statistics collector/API on port `8081`.

Both services are started by the same `docker-compose.yml` and share the external Docker network `bellotreno-network`.
The production compose file pulls prebuilt GHCR images:

- `ghcr.io/06leong/bellotreno-rfi-proxy:latest`
- `ghcr.io/06leong/bellotreno-statistics:latest`

Each image is also published with a `sha-<commit>` tag. After the normalized
storage release starts writing compressed legacy raw payloads, an image-only
rollback to an older statistics image is unsafe because that image cannot
decode the new BLOB values. Take a consistent pre-deploy SQLite backup; a full
rollback must restore that database together with the previous image and will
discard observations collected after the backup.
On the VPS, deploy published changes by pulling the GHCR images and recreating the containers; the VPS does not build these images locally.

## Required files on the VPS

Create a local `.env` file next to `docker-compose.yml`:

```env
RFI_PROXY_SECURITY_TOKEN=replace-with-rotated-rfi-proxy-token
STATISTICS_SECURITY_TOKEN=replace-with-new-statistics-token

# Optional proxy tuning
RFI_PROXY_LOG_REQUESTS=false

# Optional collector tuning
STATISTICS_COLLECTOR_ENABLED=true
STATISTICS_COLLECTOR_INTERVAL_MINUTES=30
STATISTICS_COLLECTOR_MAX_RUNTIME_SECONDS=2400
STATISTICS_COLLECTOR_CONCURRENCY=4
STATISTICS_BOARD_CONCURRENCY=24
STATISTICS_DETAIL_CONCURRENCY=12
STATISTICS_REGION_CONCURRENCY=6
STATISTICS_GUNICORN_THREADS=4
STATISTICS_GUNICORN_TIMEOUT_SECONDS=3600
STATISTICS_DETAIL_LIMIT_PER_RUN=750
STATISTICS_DETAIL_RETRY_BASE_MINUTES=60
STATISTICS_DETAIL_RETRY_MAX_MINUTES=720
STATISTICS_DETAIL_SUCCESS_REFRESH_MINUTES=120
STATISTICS_SERVICE_DATE_LOOKBACK_DAYS=1
STATISTICS_ACTIVE_SERVICE_TTL_DAYS=7
STATISTICS_RETENTION_DAYS=30
STATISTICS_V2_SERVICE_RETENTION_DAYS=90
STATISTICS_V2_OBSERVATION_RETENTION_DAYS=30
STATISTICS_RAW_PAYLOAD_RETENTION_DAYS=7
STATISTICS_STATION_REGISTRY_REFRESH_DAYS=7
STATISTICS_REGION_CODES=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22
STATISTICS_BOARD_TYPES=partenze,arrivi
STATISTICS_STATION_CSV_PATH=/data/stations.csv
STATISTICS_SCHEDULE_OFFSET_MINUTES=5
STATISTICS_FINALIZE_TIME=23:55
STATISTICS_CATCHUP_GRACE_MINUTES=20
```

Do not commit `.env`. Use `.env.example` as the template.
The statistics collector reads the `STATISTICS_*` values inside the Flask app. Changing these values on the VPS only requires `docker compose up -d` after the updated image has been pulled.

## Statistics collection model

The statistics service follows the same broad model as `railway-opendata`:

- it refreshes the ViaggiaTreno station registry from `elencoStazioni/1..22` weekly by default, then reuses the saved SQLite `station_registry` between refreshes;
- if a station-registry refresh fails, it falls back to the saved `station_registry` instead of aborting collection;
- it scans every discovered station board, not a small seed list;
- it discovers trains from station boards and calls `andamentoTreno` with `(origin station, train number, departure-day midnight)`;
- it continues to write the legacy daily `trains`/`train_stops` tables and
  aggregates used by the existing API, while also writing the additive v2
  service, observation, stop-event, and raw-payload tables;
- it uses aligned collection slots instead of sleeping after each run. With the default settings, it samples at `HH:05`, `HH:35`, and one final daily slot at `23:55` Europe/Rome time.
- every station board in one run uses the same scheduled slot time, so a single snapshot is internally consistent even if the collection takes several minutes.
- every collected train is stored under the scheduled slot date, with its original departure date preserved as `service_date`; ordinary discovery looks back one day, while an already-known unfinished service remains eligible for board/detail updates for the separate `STATISTICS_ACTIVE_SERVICE_TTL_DAYS` window (seven days by default). During the additive rollout, active keys merge legacy and v2 completion state, with any completed observation taking precedence. This lets a D-day train self-bootstrap into v2 through a D+2 or later extreme delay without admitting arbitrary old services from current boards.
- each configured station board type is fetched as its own concurrent task. With `STATISTICS_BOARD_TYPES=partenze,arrivi`, each station still fetches both departures and arrivals, but those two requests no longer wait on each other inside one station worker.
- board, train-detail, and station-registry lookups have separate concurrency controls. The current default is `24` board requests, `12` detail workers, and `6` region workers under a `680m` memory limit.
- detail failures use persisted exponential retry delays of `60`, `120`, `240`, `480`, then at most `720` minutes. A successful but unfinished service is refreshed after `120` minutes; completed services leave the queue. The default per-run budget is `750`, with space reserved for already-due backlog so current boards cannot permanently starve older extreme-delay services. Non-zero limits are clamped to at least `2`; set the limit to `0` only when an intentionally unlimited queue has been capacity-tested.
- if the service is down or a previous run is still active, the collector records `missed`/`skipped` slots in `collector_runs` instead of starting overlapping work.

Optional full station CSV support is available through `STATISTICS_STATION_CSV_PATH`. If the file exists in the data volume, rows are merged with live ViaggiaTreno stations. The built-in default does not require a CSV.

### Additive statistics storage v2

Storage v2 separates a train service from the times at which BelloTreno observes
it. This is important for overnight trains, trains that arrive one or more days
after departure, and very long genuine delays:

| Table | Grain and purpose |
| --- | --- |
| `train_services` | One current service record keyed by `(service_date, train_key)`. A canonical `train_key` represents train number + origin station code + scheduled departure epoch; `codLocOrig` is the canonical ViaggiaTreno origin field with `idOrigine`/`codOrigine` fallbacks. Incomplete identities are marked `provisional`. Equal-time updates carry a completeness score so a partial retry cannot downgrade a fuller state. Persisted attempt, failure-count, next-retry, and last-error fields make detail retries restart-safe. |
| `train_observations` | One sampled state keyed by service, `observed_at`, and `collection_date`, preserving the distinction between the service day and the day/time at which it was observed. Extreme-delay observations retain the strongest available station/time evidence. |
| `train_stop_events` | One normalized stop per service. Expected and actual arrival/departure timestamps have separate event-date columns, so a stop may occur on the next or a later calendar day. Older, empty, or lower-completeness same-slot detail cannot clear the latest stop set. |
| `train_raw_payloads` | The latest detailed raw payload for a service, stored as a zlib-compressed JSON BLOB instead of repeating uncompressed JSON for every stop. Equal-time partial payloads cannot replace a fuller payload. |
| `statistics_schema_migrations`, `statistics_migration_state` | Additive schema version and resumable legacy-backfill progress. |

The collector does not cap multi-hour delays. It preserves the value and adds
quality flags to observations at the 12-hour and 24-hour thresholds so an
outlier can be investigated without being silently discarded.

The rollout is additive. The legacy tables, daily aggregates, CSV output, and
current `/v1/*` routes remain in place, continue to be populated, and remain the
query source for the existing UI; there is no separate v2 query API yet. The
train-detail route still returns decoded `train.raw` and normalized stops. Each
accepted detail stores one compressed parent payload in the legacy
`trains.raw_json` row for that collection date, preserving the existing 30-day
date-specific route contract, and also stores the latest service-level payload
in `train_raw_payloads` for seven days. A v2 fallback is allowed only when its
`detail_collection_date` equals the requested date, so a D+1 payload cannot
appear in a D response. The compatibility response still includes
`stops[].raw_json`; existing per-stop legacy values are preserved, while a new
stop value is reconstructed from the date-matched parent payload when available
and otherwise returns the JSON string `'{}'`. Deploying or starting the
service creates the additive v2 schema and dual-writes new structured collection
data; it does **not** rewrite historical production rows or remove legacy data
automatically.

An existing compatible v2 database is upgraded in place with the four detail
retry columns; rows are preserved and initialization is idempotent. Startup
validates the full write schema, primary-key order, `WITHOUT ROWID` layout, and
service foreign keys. An incompatible table makes startup fail closed with a
diagnostic instead of dropping or rebuilding production data.

Retention is configured independently:

| Setting | Default | Applies to |
| --- | ---: | --- |
| `STATISTICS_RETENTION_DAYS` | 30 | Legacy daily tables and aggregates |
| `STATISTICS_V2_SERVICE_RETENTION_DAYS` | 90 | Nominal cutoff for normalized `train_services` and stop facts, keyed by `service_date`; a retained observation keeps its parent service |
| `STATISTICS_V2_OBSERVATION_RETENTION_DAYS` | 30 | `train_observations`, keyed by `collection_date` |
| `STATISTICS_RAW_PAYLOAD_RETENTION_DAYS` | 7 | `train_raw_payloads`, expired by payload `observed_at` |

Legacy `trains.raw_json` stores one compressed parent payload per collection-day
train row and expires with the 30-day legacy row. New `train_stops` rows do not
store another duplicate per-stop payload; the detail route reconstructs it from
that date-specific parent and uses `'{}'` when no matching parent is available.
The additional v2 service-level raw copy remains shorter-lived at seven days.
This representation is forward-compatible with the new image but not readable
by older statistics images, so keep the pre-deploy database backup until the
new collector and API have completed their production verification window.

For a multi-gigabyte rollback copy, successful completion of SQLite's Backup
API plus a lightweight immutable open, page-count, schema, and sampled-row
check is the deployment gate. A full `PRAGMA quick_check` scans the whole file
and can run separately against the offline copy; it is not required to block a
first deployment when there are no prior I/O or corruption warnings. The
lightweight check confirms usability, not every individual data page.

SQLite deletes make pages reusable but do not by themselves shrink the main
database file. Treat physical compaction as a separate maintenance operation
with a backup, downtime plan, and sufficient temporary disk space.

### Explicit v2 history migration

`migrate_statistics_v2.py` is included in the statistics image, but neither the
container entrypoint nor application startup invokes it. Run it manually only
after the new image is deployed.

First run the default read-only dry-run. It reports the legacy train and v2 row
counts, rows with missing service dates, rows whose collection date differs
from their valid service date (`collectionDateDiffersFromServiceDate`),
database/WAL/free-space sizes, `estimatedV2GrowthBytes`, and
`requiredFreeBytes`. It deliberately skips exact counts of both legacy
`train_stops` and v2 `train_stop_events` unless `--include-stops` is requested,
returning null stop counts with `legacyStopsCounted: false` and
`v2StopEventsCounted: false`. Stage progress is written to stderr while stdout
remains one machine-readable JSON document. The command does not create or
change tables:

```bash
docker compose exec -T bellotreno-statistics \
  python migrate_statistics_v2.py
```

Backfill services and observations in bounded transactions. The default batch
size is `500`; `--max-batches` lets an operator limit each maintenance window,
and rerunning the same command resumes from `statistics_migration_state`. At the
first apply run, the utility records a legacy-rowid high-water mark and scans
only through that fixed boundary, so rows appended by the live collector cannot
make an in-progress backfill endless. It pauses `100` milliseconds between
committed batches by default; use `--pause-ms` to tune that interval.

Do not run `VACUUM` until a resumable migration reaches its recorded high-water
mark. `VACUUM` can renumber legacy rowids and invalidate rowid-based progress.

A bounded apply example:

```bash
docker compose exec -T bellotreno-statistics \
  python migrate_statistics_v2.py --apply --batch-size 500 --max-batches 10
```

After one or more bounded runs, omit `--max-batches` to finish the remaining
service/observation rows:

```bash
docker compose exec -T bellotreno-statistics \
  python migrate_statistics_v2.py --apply --batch-size 500
```

Stop-event backfill is optional and is deliberately excluded from the default
apply path. It must run with the collector paused in a deliberate maintenance
window, and `--include-stops --apply` therefore also requires the explicit
`--maintenance-window` acknowledgement. Before using it, check the host
filesystem rather than only the current database size: millions of legacy stops
can require substantial additional database and WAL space. Keep room for a
verified external backup and rollback copy as well as the migration itself.

Run the stop-inclusive profile first; it remains read-only without `--apply`
and is the only profile mode that performs exact legacy and v2 stop-table
counts. It makes `estimatedV2GrowthBytes` include the legacy stop count. On a
large database these explicit stop-count stages can take several minutes; the
utility prints a progress message before and after them:

```bash
docker compose exec -T bellotreno-statistics \
  python migrate_statistics_v2.py --include-stops
```

The utility performs every parameter and capacity check through a read-only
connection before creating v2 tables or changing migration progress. Estimated
growth is conservative (`1024` bytes per legacy train row plus `768` bytes per
stop when requested), and required free space is the largest of 1 GiB, twice the
estimate, or 10% of the current database; a stop migration additionally has a
2 GiB floor. This is still a safety estimate rather than a capacity guarantee.
`--force-low-space` overrides the refusal only after capacity and an external
backup have been reviewed; it should not be a routine flag.

```bash
df -h statistics-data
du -sh statistics-data

docker compose stop bellotreno-statistics
docker compose run --rm --no-deps bellotreno-statistics \
  python migrate_statistics_v2.py --apply --include-stops --maintenance-window \
  --batch-size 250 --max-batches 2
docker compose up -d bellotreno-statistics
```

Repeat the bounded stop command to resume, increasing limits only after
observing disk and collection health. `--reset-progress` restarts the resumable
scan from legacy rowid zero; it is idempotent, but it is not a rollback and
should not be used as routine recovery. The backfill normalizes legacy services,
observations, and optionally stops; it does not copy old raw payload history into
`train_raw_payloads`. When a migration reaches its recorded high-water mark, the
utility runs `PRAGMA foreign_key_check` and reports up to 20 violations in
`foreignKeyViolationsSample`. A violation keeps migration state incomplete and
returns a non-zero exit status; a completed result contains an empty list.
`foreignKeyViolationsTruncated=true` means additional findings exist beyond the
20-row sample. `missingV2Tables` in a dry-run lists additive tables not yet
created; that is expected before the first new-image startup or apply run.

## Start

```bash
docker network create bellotreno-network 2>/dev/null || true
docker compose pull
docker compose up -d
```

To collect arrivals as well as departures, keep this in `.env`:

```env
STATISTICS_BOARD_TYPES=partenze,arrivi
```

Then pull the published image and restart the statistics service:

```bash
docker compose pull bellotreno-statistics
docker compose up -d bellotreno-statistics
```

After deployment, `GET /health` returns the last collector run, next scheduled
slot, effective detail budget, and retry timings. Collector-run rows also expose
detail attempts, failures, and deferred due work, making retry pressure visible
without opening SQLite directly.

## NPM routing

Preferred path routing:

```text
https://api.bellotreno.org/              -> rfi-proxy:8080
https://api.bellotreno.org/statistics/v1 -> bellotreno-statistics:8081/v1
```

If path routing is inconvenient, use a separate host:

```text
https://stats-api.bellotreno.org/v1 -> bellotreno-statistics:8081/v1
```

## Realtime proxy allowlist

The `rfi-proxy` service accepts only targets under these base domains:

- `viaggiatreno.it`
- `rfi.it`
- `italotreno.com`
- `trenord.it`

Every request still requires `X-Bello-Token: <RFI_PROXY_SECURITY_TOKEN>`.
For Italo in Viaggio, the proxy uses `curl_cffi` Chrome impersonation plus an
Italo referer and JSON accept headers. This is required because Cloudflare Pages
direct `fetch()` can receive upstream `403` responses from
`italoinviaggio.italotreno.com` even when the same URL works in a normal browser.
Trenord BFF traffic uses the same proxy pattern with a Trenord journey referer.

Cloudflare Pages should call this proxy for `/api/italo/*` with:

```text
ITALO_PROXY_BASE_URL=https://api.bellotreno.org/
ITALO_PROXY_TOKEN=<same secret as RFI_PROXY_SECURITY_TOKEN>
```

If the public Cloudflare Worker `https://ah.bellotreno.workers.dev/` is used as
the token-injecting broker instead, that Worker must also add `italotreno.com`
and its subdomains to its own target allowlist. In that route, the VPS token
stays in the Worker's `RFI_PROXY_TOKEN` secret rather than in Pages.

## Statistics API auth

Every `/v1/*` statistics request must include:

```http
X-Bello-Stats-Token: <STATISTICS_SECURITY_TOKEN>
```

The frontend Cloudflare Pages Function injects this header from the `STATISTICS_API_TOKEN` secret.

Main statistics endpoints:

- `GET /v1/days`
- `GET /v1/summary?date=YYYY-MM-DD`
- `GET /v1/timeseries?date=YYYY-MM-DD`
- `GET /v1/trains?date=&q=&category=&status=`
- `GET /v1/stations/search?q=`
- `GET /v1/stations/{stationCode}?date=YYYY-MM-DD`
- `GET /v1/relations?date=YYYY-MM-DD`
- `GET /v1/ranking?date=YYYY-MM-DD&metric=delay`
- `POST /v1/collect`

## Manual collector run

```bash
docker compose exec bellotreno-statistics sh -lc \
  'curl -X POST -H "X-Bello-Stats-Token: $STATISTICS_SECURITY_TOKEN" http://127.0.0.1:8081/v1/collect'
```

The collector runs automatically on aligned slots when `STATISTICS_COLLECTOR_ENABLED=true`. With the example above, that means every 30 minutes at `HH:05` and `HH:35`, plus the `23:55` final daily slot.
