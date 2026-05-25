# BelloTreno VPS services

This folder contains the VPS-side services used by BelloTreno:

- `rfi-proxy`: the existing ViaggiaTreno/RFI proxy on port `8080`.
- `bellotreno-statistics`: the statistics collector/API on port `8081`.

Both services are started by the same `docker-compose.yml` and share the external Docker network `bellotreno-network`.
The production compose file pulls prebuilt GHCR images:

- `ghcr.io/06leong/bellotreno-rfi-proxy:latest`
- `ghcr.io/06leong/bellotreno-statistics:latest`

Each image is also published with a `sha-<commit>` tag for rollback.
On the VPS, deploy published changes by pulling the GHCR images and recreating the containers; the VPS does not build these images locally.

## Required files on the VPS

Create a local `.env` file next to `docker-compose.yml`:

```env
RFI_PROXY_SECURITY_TOKEN=replace-with-rotated-rfi-proxy-token
STATISTICS_SECURITY_TOKEN=replace-with-new-statistics-token

# Optional proxy tuning
RFI_PROXY_WORKERS=2
RFI_PROXY_THREADS=16
RFI_PROXY_TIMEOUT_SECONDS=45
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
STATISTICS_DETAIL_LIMIT_PER_RUN=0
STATISTICS_SERVICE_DATE_LOOKBACK_DAYS=1
STATISTICS_RETENTION_DAYS=30
STATISTICS_STATION_REGISTRY_REFRESH_DAYS=7
STATISTICS_REGION_CODES=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22
STATISTICS_BOARD_TYPES=partenze,arrivi
STATISTICS_STATION_CSV_PATH=/data/stations.csv
STATISTICS_SCHEDULE_OFFSET_MINUTES=5
STATISTICS_FINALIZE_TIME=23:55
STATISTICS_CATCHUP_GRACE_MINUTES=20
```

Do not commit `.env`. Use `.env.example` as the template.
The Dockerfiles read the Gunicorn tuning variables at container start, while the collector reads the `STATISTICS_*` values inside the Flask app. Changing these values on the VPS only requires `docker compose up -d` after the updated image has been pulled.

## Statistics collection model

The statistics service follows the same broad model as `railway-opendata`:

- it refreshes the ViaggiaTreno station registry from `elencoStazioni/1..22` weekly by default, then reuses the saved SQLite `station_registry` between refreshes;
- if a station-registry refresh fails, it falls back to the saved `station_registry` instead of aborting collection;
- it scans every discovered station board, not a small seed list;
- it discovers trains from station boards and calls `andamentoTreno` with `(origin station, train number, departure-day midnight)`;
- it stores one row per train and one row per stop in SQLite, then rebuilds daily station/relation aggregates.
- it uses aligned collection slots instead of sleeping after each run. With the default settings, it samples at `HH:05`, `HH:35`, and one final daily slot at `23:55` Europe/Rome time.
- every station board in one run uses the same scheduled slot time, so a single snapshot is internally consistent even if the collection takes several minutes.
- every collected train is stored under the scheduled slot date, with its original departure date preserved as `service_date`; by default, trains from the previous service date are included when they are still observable on the current day's station boards, while next-day service-date trains are still excluded from the previous day.
- each configured station board type is fetched as its own concurrent task. With `STATISTICS_BOARD_TYPES=partenze,arrivi`, each station still fetches both departures and arrivals, but those two requests no longer wait on each other inside one station worker.
- board, train-detail, and station-registry lookups have separate concurrency controls. The current default is `24` board requests, `12` detail workers, and `6` region workers under a `680m` memory limit.
- if the service is down or a previous run is still active, the collector records `missed`/`skipped` slots in `collector_runs` instead of starting overlapping work.

Optional full station CSV support is available through `STATISTICS_STATION_CSV_PATH`. If the file exists in the data volume, rows are merged with live ViaggiaTreno stations. The built-in default does not require a CSV.

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

After deployment, `GET /health` returns the last collector run and the next scheduled slot. This is useful for confirming the scheduler is no longer drifting from the configured cadence.

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
