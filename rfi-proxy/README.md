# BelloTreno VPS services

This folder contains the VPS-side services used by BelloTreno:

- `rfi-proxy`: the ViaggiaTreno/RFI/Italo/Trenord/LeFrecce proxy on port `8080`.
- `bellotreno-statistics`: the statistics collector/API on port `8081`.
- `bellotreno-statistics-archive`: an offline, one-shot local Parquet archive
  job enabled only through the `archive` Compose profile.

The two always-on Python services and the one-shot archive image target Python
3.11, matching the repository CI runtime.

The two always-on services are started by the same `docker-compose.yml` and
share the external Docker network `bellotreno-network`; the archive job is
defined in that file but starts only when its profile is requested.
The production Compose file pulls prebuilt GHCR images. The RFI proxy defaults
to `latest`; the two statistics images use the shared `STATISTICS_IMAGE_TAG`
and only fall back to `latest` when it is unset:

- `ghcr.io/06leong/bellotreno-rfi-proxy:latest`
- `ghcr.io/06leong/bellotreno-statistics:latest`
- `ghcr.io/06leong/bellotreno-statistics-archive:latest`

Each image is also published with a `sha-<full-40-character-commit>` tag. The
statistics collector and archive consumer share `STATISTICS_IMAGE_TAG` in
Compose so production can pin both halves of the handoff protocol to the same
commit. After the normalized
storage release starts writing compressed legacy raw payloads, an image-only
rollback to an older statistics image is unsafe because that image cannot
decode the new BLOB values. Take a consistent pre-deploy SQLite backup; a full
rollback must restore that database together with the previous image and will
discard observations collected after the backup.
On the VPS, deploy published changes by pulling the GHCR images and recreating the containers; the VPS does not build these images locally.

The LeFrecce route forwards only the upstream `WSESSIONID` cookie. Its value is
kept opaque (including punctuation such as `:`), while every other cookie and
attribute is discarded before the stops request is proxied.

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

# Optional local archive tuning
STATISTICS_ARCHIVE_SNAPSHOT_MAX_AGE_HOURS=48
STATISTICS_ARCHIVE_SNAPSHOT_MIN_FREE_GIB=5
STATISTICS_ARCHIVE_SAFETY_GIB=5
STATISTICS_ARCHIVE_ENDED_DAY_READY_HOUR=2
STATISTICS_ARCHIVE_DUCKDB_MEMORY_LIMIT=256MB
STATISTICS_ARCHIVE_DUCKDB_THREADS=1
STATISTICS_ARCHIVE_DUCKDB_MAX_TEMP_DIRECTORY_SIZE=4GB
```

Do not commit `.env`. Use `.env.example` as the template.
The statistics collector reads the `STATISTICS_*` values inside the Flask app. Changing these values on the VPS only requires `docker compose up -d` after the updated image has been pulled.

## Long-term statistics archive

The archive uses a producer/consumer handoff so the offline image never opens
or mounts the live WAL-mode database:

1. `snapshot_statistics.py create` runs inside the always-on statistics image,
   where `/data` and `/snapshot-handoff` are writable. It opens the live database
   read-only, uses the SQLite Backup API, writes a `.partial` file, validates and
   fsyncs it, atomically renames it to `snapshots/<snapshot-id>.db`, and finally
   publishes `receipts/<snapshot-id>.ready.json`.
2. `bellotreno-statistics-archive` mounts only
   `./statistics-snapshot-handoff:/snapshot-handoff:ro` plus its writable
   `./statistics-archive:/archive`. It consumes one exact ready snapshot ID as
   an immutable database; it has no `statistics-data` mount and no network.
3. `plan` and `run` must receive the same snapshot ID. The consumer rejects a
   missing, changed, invalid, or older-than-policy receipt rather than silently
   switching to a newer database.
4. `snapshot_statistics.py release --snapshot-id EXACT` removes only that
   handoff database and receipt. Run it only after local verification and an
   independently verified off-VPS copy.

The archive container remains one-shot and is not started by ordinary
`docker compose up -d`. It has a read-only root filesystem, all Linux
capabilities dropped, `no-new-privileges`, and no network. DuckDB and archive
credentials stay out of the always-on service; rclone and remote credentials
stay out of both images.

Neither image deletes or compacts the live SQLite database. Archive runs also
never prune Parquet, rollback backups, or operator-owned files automatically.
The handoff snapshot is approximately the size of the allocated live database,
so check free space before `create`; the Parquet consumer no longer creates a
second multi-gigabyte SQLite working copy. The producer itself refuses to start
unless the handoff filesystem can hold the source database and still retain the
`STATISTICS_ARCHIVE_SNAPSHOT_MIN_FREE_GIB` reserve (5 GiB by default). It also
allows only one ready snapshot at a time and fails visibly on leftover partial
or orphan files instead of accumulating hidden multi-gigabyte copies.

The archive keeps the service-day and observation-day grains separate:

- `train_observations`, collector runs, snapshots, and station/relation daily
  aggregates are published only after their collection day has ended (D+1);
- `train_services` and `train_stop_events` are published only after the active
  service window has elapsed (D+8 with the default seven-day TTL), so an
  overnight or severely delayed train can finish updating first;
- `station_registry` is saved as a dated dimension snapshot;
- legacy `trains`/`train_stops` and short-lived raw payload BLOBs are not copied
  into the long-term dataset.

Files are written as ZSTD-compressed Parquet under Hive-style partition paths.
A `.complete.json` manifest records row counts, primary keys, date bounds,
schema fingerprints, file sizes, and SHA-256 checksums. A partition is treated
as published only after that manifest is atomically committed, which also makes
repeated runs idempotent.

Published partitions are immutable. If a still-retained live partition later
has a different row count, `plan` and `run` fail instead of silently ignoring
the late rows. The normal collector contract does not backfill ended collection
days or services after the D+8 stability boundary; an intentional historical
repair therefore requires an explicit future archive-revision workflow rather
than overwriting a schema-v1 file.

When no explicit `--as-of-date` is supplied, snapshot creation before
`STATISTICS_ARCHIVE_ENDED_DAY_READY_HOUR` (02:00 Europe/Rome by default)
uses the preceding day as its cutoff. This prevents a just-ended calendar day
from being frozen while its final collector slot may still be finishing. The
chosen cutoff is recorded in the ready receipt and cannot be changed by
`plan`/`run`. The archive also holds an exclusive process lock, so a timer and a
manual run cannot publish the same partition concurrently.

The ready hour is only a post-midnight safety delay; it does not claim that the
previous collection day is complete. The archive inherits the collector's
cadence, schedule offset, finalization time, and relevant retention
windows from the same `STATISTICS_*` settings. The effective service retention
also follows the collector's maximum of service, observation, raw-payload, and
active-service windows. Each ended date is labelled
`complete`, `partial`, or `unavailable` in the manifest using the same
collector-run and snapshot-slot rules as the statistics API. Recoverable
zero-observation dates receive an explicit zero-row Parquet partition, while
older dates already lost outside the live retention window are reported as
historical gaps and are never fabricated as empty data.

Run every command from the Compose directory so relative bind mounts and
`.env` resolve consistently. Before the first run, deploy the merged Compose
file and recreate `bellotreno-statistics`; pulling only the archive image is not
enough because the old service has no handoff mount.

Wait for every job in the GitHub `Docker Images` workflow to succeed. Then put
the exact merged commit in the VPS `.env`, for example
`STATISTICS_IMAGE_TAG=sha-0123456789abcdef0123456789abcdef01234567`.
Do not use different tags for the producer and consumer, and do not begin the
snapshot workflow while either image is still on a moving `latest` tag.

```bash
cd /home/docker_apps/rfi-proxy
mkdir -p statistics-snapshot-handoff statistics-archive

docker compose pull bellotreno-statistics bellotreno-statistics-archive

STATISTICS_IMAGE=$(docker compose --profile archive config --images | \
  grep -E '^ghcr.io/06leong/bellotreno-statistics:sha-[0-9a-f]{40}$')
ARCHIVE_IMAGE=$(docker compose --profile archive config --images | \
  grep -E '^ghcr.io/06leong/bellotreno-statistics-archive:sha-[0-9a-f]{40}$')
STATISTICS_REVISION=$(docker image inspect \
  "$STATISTICS_IMAGE" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
ARCHIVE_REVISION=$(docker image inspect \
  "$ARCHIVE_IMAGE" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
test -n "$STATISTICS_REVISION"
test "$STATISTICS_REVISION" = "$ARCHIVE_REVISION"
test "$STATISTICS_IMAGE" = \
  "ghcr.io/06leong/bellotreno-statistics:sha-$STATISTICS_REVISION"
test "$ARCHIVE_IMAGE" = \
  "ghcr.io/06leong/bellotreno-statistics-archive:sha-$STATISTICS_REVISION"

docker compose up -d --no-deps --force-recreate bellotreno-statistics

SNAPSHOT_JSON=$(docker compose exec -T bellotreno-statistics \
  python snapshot_statistics.py create)
printf '%s\n' "$SNAPSHOT_JSON" | tee snapshot-create-latest.json
SNAPSHOT_ID=$(printf '%s' "$SNAPSHOT_JSON" | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshotId"])')
printf 'snapshot_id=%s\n' "$SNAPSHOT_ID"

docker compose exec -T bellotreno-statistics \
  python snapshot_statistics.py list

docker compose --profile archive run --rm \
  bellotreno-statistics-archive plan --snapshot-id "$SNAPSHOT_ID"
```

`create` emits progress only on stderr and one machine-readable JSON document on
stdout. Preserve its `snapshotId`; do not run another `create` between `plan`
and `run` as a substitute. A receipt is accepted for 48 hours by default through
`STATISTICS_ARCHIVE_SNAPSHOT_MAX_AGE_HOURS`. This window permits a slow first
export but is not a retention policy.

`plan` is the read-only preflight. Review its source dates, selected partitions,
snapshot provenance, disk estimate, and free-space decision. The default safety
reserve is 5 GiB; the capacity gate also reserves room for configured DuckDB
spill and conservative Parquet growth. Adjust
`STATISTICS_ARCHIVE_SAFETY_GIB` only from measured capacity, not merely to make
a full disk pass.

`continuityOk: false` or a non-zero `historicalPartitionGapCount` does not make
`run` exit non-zero: the job still preserves every currently recoverable
partition, but the resulting dataset has an explicitly recorded historical
gap and must not be described as complete. Run the archive daily where
possible, and always at an interval comfortably shorter than the shortest
30-day live retention window.

Export from that same snapshot only after `plan` succeeds:

```bash
docker compose --profile archive run --rm \
  bellotreno-statistics-archive run --snapshot-id "$SNAPSHOT_ID"
```

Dataset names, partition dates, and row counts are printed while exporting. The
initial snapshot creation and first export can compete with collection for disk
I/O, so start them in a quieter period after confirming collector health. After
the run, inspect the next collector duration and detail-failure count. Ordinary
intermittent ViaggiaTreno empty payloads remain governed by the persisted retry
backoff and are not, by themselves, archive corruption.

Then run the independent local verifier and inspect the retained output size:

```bash
docker compose --profile archive run --rm bellotreno-statistics-archive verify
du -sh statistics-archive
```

`verify` checks the newest complete manifest. Use `verify --all` for a deeper
periodic pass over every published manifest. If `run` fails, it leaves its
diagnostic directory under `statistics-archive/work/`; inspect the error before
manually removing only that failed run directory.

The first production archive on 5 August 2026 preserved 3,453,523 normalized
rows in 205 immutable partitions. Its ZSTD Parquet payload was 34,367,647 bytes
and `verify` passed. The on-disk archive directory was about 35 MiB. This is an
encouraging compression result, but it must not be presented as a direct
9.5-GiB-to-35-MiB compression ratio: the long-term dataset intentionally omits
legacy duplicates and raw JSON, and the live SQLite file also contained free
pages. Measure several incremental runs before forecasting monthly growth.

The container currently writes archive files as root, matching the documented
VPS commands. If a non-root operator will manage the output directly, set an
intentional ownership policy for `statistics-archive` before scheduling the
job rather than recursively changing ownership after every run.

Treat a non-zero `create`, `plan`, `run`, or `verify` exit code as a failed
operation. Do not release the snapshot or remove any local archive or rollback
backup on the strength of `run` alone.

### Off-VPS copy through Cloudreve

The preferred second copy is the separate 512-GB VPS, reached either directly
or through Cloudreve's WebDAV endpoint. Keep rclone on the host, outside Docker,
and keep its configuration readable only by the dedicated backup account. Do
not add WebDAV URLs, usernames, passwords, or rclone configuration to `.env`,
Compose, an image, Git, or a manifest.

Before exposing a Cloudreve WebDAV endpoint, run Cloudreve 4.16.1 or newer and
confirm that the instance includes the fix described in
<https://github.com/cloudreve/cloudreve/security/advisories/GHSA-w5fv-7x5q-g8qp>.
Use a dedicated least-privilege account restricted to the archive prefix.

Use `rclone copy`, never `rclone sync`: immutable remote history must not be
deleted merely because a local file is absent. Upload only files committed by a
completed manifest; a failed run can leave uncommitted diagnostics or payloads
that must never be published. Process payloads before their exact manifest so a
remote `.complete.json` is never visible early. The following fail-fast
bootstrap processes every local manifest in chronological order. Configure the
`cloudreve` WebDAV remote interactively with `vendor = other` (Cloudreve is not
Nextcloud or ownCloud) and replace the destination as needed. Ordinary WebDAV
does not expose a portable server-side content hash, so the `check --download`
steps intentionally download and hash the remote objects. Scheduled incremental
runs should process only the manifest returned by that run. Before scheduling,
the feature check below must report a server-side `Move`; otherwise use direct
SFTP or another target that can rename a fully uploaded marker instead of
publishing completion through WebDAV:

```bash
set -euo pipefail
REMOTE='cloudreve:bellotreno/statistics-archive'
FILES_FROM=$(mktemp)
trap 'rm -f "$FILES_FROM"' EXIT

rclone backend features cloudreve: --json | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["Features"]["Move"], "remote lacks server-side Move"'

while IFS= read -r MANIFEST_FILE; do
  MANIFEST_NAME=$(basename "$MANIFEST_FILE")
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); [print(item["path"]) for item in d["datasets"]]' \
    "$MANIFEST_FILE" > "$FILES_FROM"
  test -s "$FILES_FROM"

  # Copy and content-check only payloads committed by this exact manifest.
  rclone copy statistics-archive "$REMOTE" \
    --files-from "$FILES_FROM" --checksum --immutable --transfers 2
  rclone check statistics-archive "$REMOTE" \
    --files-from "$FILES_FROM" --download --one-way

  # Stage and content-check the marker under a non-complete path. Plain WebDAV
  # uploads are not partial-name uploads, so never PUT the final marker directly.
  rclone copyto "$MANIFEST_FILE" "$REMOTE/.incoming/$MANIFEST_NAME" \
    --checksum --immutable
  rclone check "$MANIFEST_FILE" "$REMOTE/.incoming" --download --one-way

  # Publish through one same-backend server-side rename, then re-check final.
  rclone moveto "$REMOTE/.incoming/$MANIFEST_NAME" \
    "$REMOTE/manifests/$MANIFEST_NAME" --immutable
  rclone check "$MANIFEST_FILE" "$REMOTE/manifests" --download --one-way
done < <(find statistics-archive/manifests -maxdepth 1 -type f \
  -name '*.complete.json' -print | sort)
```

An rclone comparison is necessary but not the independent dataset verification.
On the second VPS, download the remote prefix into a fresh directory and run the
same archive image's `verify --all` against that downloaded copy:

```bash
set -euo pipefail
REMOTE='cloudreve:bellotreno/statistics-archive'
RESTORE_ROOT="$PWD/statistics-archive-restore-$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_IMAGE='ghcr.io/06leong/bellotreno-statistics-archive:sha-<full-40-character-commit>'
mkdir -p "$RESTORE_ROOT"
rclone copy "$REMOTE" "$RESTORE_ROOT" --immutable --transfers 2
docker pull "$ARCHIVE_IMAGE"

docker run --rm --network none --read-only --tmpfs /tmp:size=64m,mode=1777 \
  -e ARCHIVE_ROOT=/archive \
  -v "$RESTORE_ROOT:/archive:ro" \
  "$ARCHIVE_IMAGE" \
  verify --all
```

Use the same `sha-<full-40-character-commit>` archive image tag that created the
local manifest; do not substitute the moving `latest` tag at this recovery gate.

Only after this fresh-download verification passes may the exact handoff
snapshot be released on the collector VPS:

```bash
docker compose exec -T bellotreno-statistics \
  python snapshot_statistics.py release --snapshot-id "$SNAPSHOT_ID"
```

Release deletes only `snapshots/<id>.db` and its matching ready receipt; it does
not delete Parquet or the old SQLite backup. Cloudreve, Gitea, and a direct SFTP
directory on the same second VPS are one failure domain, not independent copies.

Do not commit Parquet or SQLite databases as ordinary Git objects. GitHub blocks
regular Git objects above 100 MiB and recommends a file-sharing/storage service
for database files; see
<https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>.
A Gitea Generic Package registry can be an optional publication channel, but it
adds a dependency on the Gitea instance and its own backup policy. GitHub or
Gitea should hold small manifests, schemas, data dictionaries, and restore
records—not the primary data copy.
Private repository visibility does not change Git's object model or file limits.
Git LFS can technically store large snapshots, but quota, bandwidth, history,
and restore coupling make it unsuitable as BelloTreno's primary archive; see
<https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage>.

For the existing 9.5-GiB pre-v2 SQLite rollback database, prefer a one-time SFTP
or rsync transfer directly to the second VPS. Record SHA-256 before transfer,
verify the checksum on the destination, and retain a restore note. Do not delete
the source backup until that verification and an intentional operator approval;
the archive workflow never deletes it automatically.

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

The current production rollout is intentionally **forward-only**. Structured v2
coverage begins with observations collected after the v2 image was activated;
the existing legacy tables continue to serve their rolling compatibility window.
Do not run `migrate_statistics_v2.py --apply` merely to make the coverage date
look older. The `/v1/days` response exposes the actual collection-date and
service-date coverage so clients can label partial, live, complete, and
unavailable days without turning missing history into zero.

`coverage.rolloutDate` is a durable first-collection anchor and does not move
when old observations expire; `coverage.collectionDate` describes the rows
currently retained. A past date is comparison-eligible only when every required
cadence/finalization slot has both a successful collector run and a successful
snapshot. A date with some v2 observations but incomplete slot evidence remains
`partial` with reason `incomplete_collection_day`.

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
after the new image is deployed **and only if an explicit, capacity-reviewed
backfill decision replaces the default forward-only policy**. Normal deployment
and dashboard comparison do not require a historical backfill.

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
- `lefrecce.it` (only `/Channels.Website.BFF.WEB/website/*`)

Every request still requires `X-Bello-Token: <RFI_PROXY_SECURITY_TOKEN>`.
For Italo in Viaggio, the proxy uses `curl_cffi` Chrome impersonation plus an
Italo referer and JSON accept headers. This is required because Cloudflare Pages
direct `fetch()` can receive upstream `403` responses from
`italoinviaggio.italotreno.com` even when the same URL works in a normal browser.
Trenord BFF traffic uses the same proxy pattern with a Trenord journey referer.
LeFrecce uses the same Chrome impersonation because its BFF can also reject
Cloudflare Pages egress. POST is enabled only for the restricted LeFrecce BFF
path. The proxy accepts only a sanitized `WSESSIONID` through
`X-Bello-Upstream-Cookie`; it does not forward arbitrary caller cookies.

Cloudflare Pages should call this proxy for `/api/italo/*` with:

```text
ITALO_PROXY_BASE_URL=https://api.bellotreno.org/
ITALO_PROXY_TOKEN=<same secret as RFI_PROXY_SECURITY_TOKEN>
```

LeFrecce can use dedicated Pages variables or reuse the generic/Italo proxy
configuration:

```text
TRENITALIA_LEFRECCE_PROXY_BASE_URL=https://api.bellotreno.org/
TRENITALIA_LEFRECCE_PROXY_TOKEN=<same secret as RFI_PROXY_SECURITY_TOKEN>
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
