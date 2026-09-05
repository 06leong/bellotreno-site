"""Full synthetic Parquet -> production Analytics memory regression.

Run generation outside the constrained container, then build inside the actual
archive image with --memory=384m --memory-swap=384m. No production data is used.
"""
import argparse
import json
import sqlite3
import sys
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path.cwd()))
sys.path.insert(1, str(ROOT))
sys.path.insert(2, str(ROOT / "rfi-proxy/statistics"))


def generate(root, days, services):
    import duckdb
    from tests.python.test_statistics_analytics import StatisticsAnalyticsTest

    fixture = StatisticsAnalyticsTest()
    fixture.setUp()
    archive = root / 'archive'
    if archive.exists():
        raise RuntimeError(f"fixture archive already exists: {archive}")
    archive.mkdir(parents=True)
    manifest = json.loads((fixture.archive / 'manifests/analytics-fixture.complete.json').read_text())
    manifest['datasets'] = []
    manifest['runId'] = 'synthetic-memory-probe'
    manifest['coverage']['collectionDayQuality']['items'] = []
    c = duckdb.connect(config={'threads': '1', 'memory_limit': '192MB'})
    try:
        for table in ['train_services', 'train_observations', 'train_stop_events', 'collector_runs', 'snapshots']:
            paths = [str(p).replace("'", "''") for p in fixture.archive.glob(f'datasets/schema=v1/dataset={table}/**/*.parquet')]
            files = '[' + ','.join("'" + p + "'" for p in paths) + ']'
            c.execute(f'CREATE TEMP TABLE template_{table} AS SELECT * FROM read_parquet({files}, hive_partitioning=false) LIMIT 1')
        for day in range(days):
            d = (date(2026, 6, 1) + timedelta(days=day)).isoformat()
            c.execute(f"""
                CREATE OR REPLACE TEMP TABLE generated_train_services AS
                SELECT t.* REPLACE (
                    '{d}' AS service_date,
                    CAST(n AS VARCHAR) || '-S' || CAST(n%1500 AS VARCHAR) || '-1780000000000' AS train_key,
                    CAST(n AS VARCHAR) AS train_number,
                    CASE WHEN n%100 < 90 THEN 'REG' WHEN n%100 < 94 THEN 'FR'
                         WHEN n%100 < 96 THEN 'IC' WHEN n%100 < 97 THEN 'MET'
                         WHEN n%100 < 98 THEN 'EC' WHEN n%100 < 99 THEN 'ICN' ELSE 'FA' END AS category,
                    CASE WHEN n%100 < 60 THEN '2' WHEN n%100 < 85 THEN '63'
                         WHEN n%100 < 93 THEN '18' WHEN n%100 < 96 THEN '1'
                         WHEN n%100 < 98 THEN '4' WHEN n%100 < 99 THEN '910' ELSE '64' END AS operator,
                    'STAZIONE ORIGINE ' || CAST(n%1500 AS VARCHAR) AS origin,
                    'STAZIONE DESTINAZIONE ' || CAST((n+11)%2800 AS VARCHAR) AS destination,
                    'S' || CAST(n%2800 AS VARCHAR) AS origin_code,
                    'S' || CAST((n+11)%2800 AS VARCHAR) AS destination_code,
                    'STAZIONE ORIGINE ' || CAST(n%1500 AS VARCHAR) || ' -> STAZIONE DESTINAZIONE ' || CAST((n+11)%1500 AS VARCHAR) AS relation_key,
                    CASE WHEN n%100=0 THEN 1 ELSE 0 END AS cancelled,
                    CASE WHEN n%30=0 THEN 0 ELSE 1 END AS completed,
                    CASE WHEN n%50=0 THEN 'provisional' ELSE 'canonical' END AS identity_quality,
                    CASE WHEN n%30=0 THEN NULL ELSE CAST((n*13+{day})%201-2 AS INTEGER) END AS arrival_delay,
                    CAST(n%12 AS INTEGER) AS departure_delay,
                    '{d}T' || lpad(CAST(n%18 AS VARCHAR),2,'0') || ':00:00+02:00' AS scheduled_departure,
                    '{d}T' || lpad(CAST(n%18+3 AS VARCHAR),2,'0') || ':00:00+02:00' AS scheduled_arrival
                ) FROM template_train_services t CROSS JOIN range({services}) AS nums(n);

                CREATE OR REPLACE TEMP TABLE generated_train_observations AS
                SELECT t.* REPLACE (
                    s.service_date AS service_date, s.train_key AS train_key,
                    s.service_date AS collection_date,
                    s.service_date || 'T' || lpad(CAST(j+4 AS VARCHAR),2,'0') || ':05:00Z' AS observed_at
                ) FROM template_train_observations t
                CROSS JOIN generated_train_services s CROSS JOIN range(8) AS obs(j);

                CREATE OR REPLACE TEMP TABLE generated_train_stop_events AS
                SELECT t.* REPLACE (
                    s.service_date AS service_date, s.train_key AS train_key,
                    s.train_number AS train_number, s.category AS category,
                    CAST(k AS INTEGER) AS stop_number,
                    'S' || CAST((CAST(s.train_number AS INTEGER)+k)%2800 AS VARCHAR) AS station_code,
                    'STAZIONE FERROVIARIA ' || CAST((CAST(s.train_number AS INTEGER)+k)%2800 AS VARCHAR) AS station_name,
                    CASE WHEN k=0 THEN 'origine' WHEN k=11 THEN 'destinazione' ELSE 'fermata' END AS stop_type,
                    CASE WHEN k=0 THEN NULL ELSE s.scheduled_arrival END AS arrival_expected,
                    CASE WHEN k=0 THEN NULL ELSE s.service_date END AS arrival_expected_date,
                    CASE WHEN k=0 OR s.completed=0 THEN NULL ELSE s.scheduled_arrival END AS arrival_actual,
                    CASE WHEN k=0 OR s.completed=0 THEN NULL ELSE s.service_date END AS arrival_actual_date,
                    CASE WHEN k=0 OR s.completed=0 THEN NULL ELSE s.arrival_delay END AS arrival_delay,
                    CASE WHEN k=11 THEN NULL ELSE s.scheduled_departure END AS departure_expected,
                    CASE WHEN k=11 THEN NULL ELSE s.service_date END AS departure_expected_date,
                    CASE WHEN k=11 OR s.completed=0 THEN NULL ELSE s.scheduled_departure END AS departure_actual,
                    CASE WHEN k=11 OR s.completed=0 THEN NULL ELSE s.service_date END AS departure_actual_date,
                    CASE WHEN k=11 OR s.completed=0 THEN NULL ELSE s.departure_delay END AS departure_delay,
                    s.cancelled AS cancelled
                ) FROM template_train_stop_events t
                CROSS JOIN generated_train_services s CROSS JOIN range(12) AS stops(k);

                CREATE OR REPLACE TEMP TABLE generated_collector_runs AS
                SELECT t.* REPLACE ('{d}' AS date, '{d}T' || CAST(j AS VARCHAR) AS slot_at)
                FROM template_collector_runs t CROSS JOIN range(49) AS slots(j);
                CREATE OR REPLACE TEMP TABLE generated_snapshots AS
                SELECT t.* REPLACE ('{d}' AS date, CAST(j AS INTEGER) AS id)
                FROM template_snapshots t CROSS JOIN range(49) AS slots(j);
            """)
            for table in ['train_services', 'train_observations', 'train_stop_events', 'collector_runs', 'snapshots']:
                key = 'service_date' if table in ['train_services', 'train_stop_events'] else 'collection_date'
                relative = Path('datasets/schema=v1') / f'dataset={table}' / f'{key}={d}' / 'part-00000.parquet'
                path = archive / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                target = str(path).replace("'", "''")
                c.execute(f"COPY generated_{table} TO '{target}' (FORMAT PARQUET, COMPRESSION ZSTD)")
                manifest['datasets'].append({'dataset': table, 'partition': {key: d}, 'path': relative.as_posix()})
            manifest['coverage']['collectionDayQuality']['items'].append({
                'date': d, 'coverageStatus': 'complete', 'comparisonEligible': True,
                'scheduleComplete': True, 'scheduledSlotCount': 49, 'requiredSlotCount': 48,
                'missingCollectorRunSlots': [], 'missingSnapshotSlots': [], 'observationRows': services*8})
            if day%10==0 or day==days-1:
                print(f'generated {day+1}/{days} days', flush=True)
        manifest['asOfDate'] = d
        manifest['createdAt'] = d + 'T02:00:00Z'
        (archive / 'manifests').mkdir(exist_ok=True)
        (archive / 'manifests/probe.complete.json').write_text(json.dumps(manifest), encoding='utf-8')
    finally:
        c.close()
        fixture.tearDown()


def build(root, days, services):
    import analytics_statistics as analytics
    import duckdb

    started = time.monotonic()
    result = analytics.analytics_build(analytics.AnalyticsConfig(
        archive_root=root / "archive", analytics_root=root / "output",
        as_of_date=None, memory_limit="128MB", threads=1,
        max_history_days=730, minimum_ranking_sample=100,
        window_batch_days=1, fact_batch_days=1,
    ))
    with sqlite3.connect(root / "output/analytics.db") as connection:
        counts = connection.execute(
            "SELECT COUNT(*), SUM(observed_services), SUM(arrival_sample) FROM network_day"
        ).fetchone()
        eligible_per_day = sum(n % 50 != 0 and n % 30 != 0 for n in range(services))
        assert counts == (days, days * services, days * eligible_per_day), counts
        windows = connection.execute(
            "SELECT DISTINCT window_days FROM network_window ORDER BY 1"
        ).fetchall()
        assert windows == [(7,), (28,), (90,)], windows
        assert len(result["rows"]) == 14, result["rows"]
        assert all(count > 0 for count in result["rows"].values()), result["rows"]
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    assert not list((root / "output").glob("analytics-*")), "work database was not cleaned"
    result["seconds"] = round(time.monotonic() - started, 2)
    result["fixture"] = {"days": days, "servicesPerDay": services,
                         "stopEvents": days * services * 12}
    result["duckdbVersion"] = duckdb.__version__
    result["python"] = sys.version
    if sys.platform == "linux":
        import resource
        result["peakRssMiB"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2)
        peak_file = Path("/sys/fs/cgroup/memory.peak")
        if peak_file.exists():
            result["cgroupPeakMiB"] = round(int(peak_file.read_text()) / 2**20, 2)
    (root / "resources.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("generate", "build"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--services", type=int, default=8000)
    args = parser.parse_args()
    if not 7 <= args.days <= 730 or not 100 <= args.services <= 20000:
        parser.error("days must be 7..730 and services must be 100..20000")
    args.root.mkdir(parents=True, exist_ok=True)
    if args.command == "generate":
        generate(args.root, args.days, args.services)
    else:
        build(args.root, args.days, args.services)
