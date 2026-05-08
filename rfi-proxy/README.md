# BelloTreno VPS services

This folder contains the VPS-side services used by BelloTreno:

- `rfi-proxy`: the existing ViaggiaTreno/RFI proxy on port `8080`.
- `bellotreno-statistics`: the statistics collector/API on port `8081`.

Both services are started by the same `docker-compose.yml` and share the external Docker network `bellotreno-network`.

## Required files on the VPS

Create a local `.env` file next to `docker-compose.yml`:

```env
RFI_PROXY_SECURITY_TOKEN=replace-with-rotated-rfi-proxy-token
STATISTICS_SECURITY_TOKEN=replace-with-new-statistics-token
```

Do not commit `.env`. Use `.env.example` as the template.

## Statistics collection model

The statistics service follows the same broad model as `railway-opendata`:

- it refreshes the ViaggiaTreno station registry from `elencoStazioni/1..22`;
- it scans every discovered station board, not a small seed list;
- it discovers trains from station departures and calls `andamentoTreno` with `(origin station, train number, departure-day midnight)`;
- it stores one row per train and one row per stop in SQLite, then rebuilds daily station/relation aggregates.

Optional full station CSV support is available through `STATISTICS_STATION_CSV_PATH`. If the file exists in the data volume, rows are merged with live ViaggiaTreno stations. The built-in default does not require a CSV.

## Start

```bash
docker network create bellotreno-network 2>/dev/null || true
docker compose up -d --build
```

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

## Manual collector run

```bash
docker compose exec bellotreno-statistics sh -lc \
  'curl -X POST -H "X-Bello-Stats-Token: $STATISTICS_SECURITY_TOKEN" http://127.0.0.1:8081/v1/collect'
```

The collector also runs automatically every `STATISTICS_COLLECTOR_INTERVAL_MINUTES` minutes when `STATISTICS_COLLECTOR_ENABLED=true`.
