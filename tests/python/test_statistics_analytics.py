import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from unittest.mock import patch
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
STATISTICS_DIR = ROOT / "rfi-proxy" / "statistics"
sys.path.insert(0, str(STATISTICS_DIR))

from analytics_statistics import (  # noqa: E402
    AnalyticsConfig,
    _build_rolling_windows,
    _build_stabilized_facts,
    analytics_build,
    analytics_cleanup,
    analytics_lock,
    remove_abandoned_work_roots,
)


try:
    import duckdb

    DUCKDB_AVAILABLE = True
except ImportError:
    DUCKDB_AVAILABLE = False


@unittest.skipUnless(DUCKDB_AVAILABLE, "DuckDB is required for analytics tests")
class StatisticsAnalyticsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "archive"
        self.analytics = self.root / "analytics"
        self._create_archive()
        self.config = AnalyticsConfig(
            archive_root=self.archive,
            analytics_root=self.analytics,
            as_of_date=date(2026, 8, 2),
            memory_limit="128MB",
            threads=1,
            max_history_days=90,
            minimum_ranking_sample=1,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def _create_archive(self):
        connection = duckdb.connect()
        try:
            connection.execute(
                """
                CREATE TABLE train_services (
                    service_date VARCHAR, train_key VARCHAR, identity_quality VARCHAR,
                    train_number VARCHAR, departure_epoch_ms VARCHAR, category VARCHAR,
                    operator VARCHAR, status VARCHAR, origin VARCHAR, destination VARCHAR,
                    origin_code VARCHAR, destination_code VARCHAR, relation_key VARCHAR,
                    departure_delay INTEGER, arrival_delay INTEGER, delay INTEGER,
                    cancelled INTEGER, rescheduled INTEGER, not_departed INTEGER,
                    scheduled_departure VARCHAR, scheduled_arrival VARCHAR,
                    first_seen VARCHAR, last_seen VARCHAR, latest_collection_date VARCHAR,
                    latest_state_quality INTEGER, detail_last_seen VARCHAR,
                    detail_collection_date VARCHAR, detail_quality INTEGER,
                    has_details INTEGER, completed INTEGER, detail_attempted_at VARCHAR,
                    detail_failure_count INTEGER, detail_next_retry_at VARCHAR,
                    detail_last_error VARCHAR
                );
                INSERT INTO train_services VALUES
                    ('2026-08-01','100-S001-1785627000000','canonical','100','1785627000000','ICN','10','delayed','MILANO CENTRALE','ROMA TERMINI','S001','S010','MILANO CENTRALE -> ROMA TERMINI',5,10,10,0,0,0,'2026-08-01T23:30:00+02:00','2026-08-02T07:00:00+02:00','2026-08-01T21:00:00Z','2026-08-02T05:10:00Z','2026-08-02',90,'2026-08-02T05:10:00Z','2026-08-02',90,1,1,NULL,0,NULL,NULL),
                    ('2026-08-01','100-S002-1785627000000','canonical','100','1785627000000','REG','2','cancelled','MILANO CADORNA','VARESE','S002','S020','MILANO CADORNA -> VARESE',0,0,0,1,0,0,'2026-08-01T23:30:00+02:00','2026-08-02T00:45:00+02:00','2026-08-01T21:00:00Z','2026-08-01T21:30:00Z','2026-08-01',80,NULL,NULL,0,0,1,NULL,0,NULL,NULL),
                    ('2026-08-02','200-S003-1785708000000','canonical','200','1785708000000','IC','4','delayed','TORINO PORTA NUOVA','LECCE','S003','S030','TORINO PORTA NUOVA -> LECCE',120,180,180,0,0,0,'2026-08-02T22:00:00+02:00','2026-08-03T10:00:00+02:00','2026-08-02T20:00:00Z','2026-08-03T11:10:00Z','2026-08-03',95,'2026-08-03T11:10:00Z','2026-08-03',95,1,1,NULL,0,NULL,NULL),
                    ('2026-08-02','201--1785711600000','provisional','201','1785711600000','REG','2','regular','UNKNOWN','UNKNOWN','','','UNKNOWN -> UNKNOWN',0,0,0,0,0,0,'2026-08-02T23:00:00+02:00',NULL,'2026-08-02T21:00:00Z','2026-08-02T21:30:00Z','2026-08-02',10,NULL,NULL,0,0,1,NULL,0,NULL,NULL);

                CREATE TABLE train_stop_events (
                    service_date VARCHAR, train_key VARCHAR, stop_number INTEGER,
                    train_number VARCHAR, category VARCHAR, station_code VARCHAR,
                    station_name VARCHAR, stop_type VARCHAR, platform VARCHAR,
                    arrival_expected VARCHAR, arrival_expected_date VARCHAR,
                    arrival_actual VARCHAR, arrival_actual_date VARCHAR, arrival_delay INTEGER,
                    departure_expected VARCHAR, departure_expected_date VARCHAR,
                    departure_actual VARCHAR, departure_actual_date VARCHAR,
                    departure_delay INTEGER, cancelled INTEGER,
                    detail_observed_at VARCHAR, detail_quality INTEGER
                );
                INSERT INTO train_stop_events VALUES
                    ('2026-08-01','100-S001-1785627000000',0,'100','ICN','S001','MILANO CENTRALE','origine','1',NULL,NULL,NULL,NULL,NULL,'2026-08-01T23:30:00+02:00','2026-08-01','2026-08-01T23:35:00+02:00','2026-08-01',5,0,'2026-08-02T05:10:00Z',90),
                    ('2026-08-01','100-S001-1785627000000',1,'100','ICN','S010','ROMA TERMINI','destinazione','8','2026-08-02T07:00:00+02:00','2026-08-02','2026-08-02T07:10:00+02:00','2026-08-02',10,NULL,NULL,NULL,NULL,NULL,0,'2026-08-02T05:10:00Z',90),
                    ('2026-08-02','200-S003-1785708000000',0,'200','IC','S003','TORINO PORTA NUOVA','origine','5',NULL,NULL,NULL,NULL,NULL,'2026-08-02T22:00:00+02:00','2026-08-02','2026-08-03T00:00:00+02:00','2026-08-03',120,0,'2026-08-03T11:10:00Z',95),
                    ('2026-08-02','200-S003-1785708000000',1,'200','IC','S030','LECCE','destinazione','2','2026-08-03T10:00:00+02:00','2026-08-03','2026-08-03T13:00:00+02:00','2026-08-03',180,NULL,NULL,NULL,NULL,NULL,0,'2026-08-03T11:10:00Z',95);

                CREATE TABLE train_observations (
                    service_date VARCHAR, train_key VARCHAR, observed_at VARCHAR,
                    collection_date VARCHAR, source VARCHAR, status VARCHAR,
                    departure_delay INTEGER, arrival_delay INTEGER, delay INTEGER,
                    cancelled INTEGER, rescheduled INTEGER, not_departed INTEGER,
                    has_details INTEGER, completed INTEGER, quality_score INTEGER,
                    quality_flags VARCHAR, evidence_station_code VARCHAR,
                    evidence_expected_at VARCHAR, evidence_actual_at VARCHAR,
                    evidence_delay INTEGER, recorded_at VARCHAR
                );
                INSERT INTO train_observations VALUES
                    ('2026-08-01','100-S001-1785627000000','2026-08-02T05:05:00Z','2026-08-02','detail','delayed',5,10,10,0,0,0,1,1,90,'[]','S010','2026-08-02T05:00:00Z','2026-08-02T05:10:00Z',10,'2026-08-02T05:05:01Z'),
                    ('2026-08-01','100-S002-1785627000000','2026-08-01T21:05:00Z','2026-08-01','board','cancelled',0,0,0,1,0,0,0,1,80,'[]','S002',NULL,NULL,NULL,'2026-08-01T21:05:01Z'),
                    ('2026-08-02','200-S003-1785708000000','2026-08-03T11:05:00Z','2026-08-03','detail','delayed',120,180,180,0,0,0,1,1,95,'[]','S030','2026-08-03T08:00:00Z','2026-08-03T11:00:00Z',180,'2026-08-03T11:05:01Z'),
                    ('2026-08-02','201--1785711600000','2026-08-02T21:05:00Z','2026-08-02','board','regular',0,0,0,0,0,0,0,1,10,'[]',NULL,NULL,NULL,NULL,'2026-08-02T21:05:01Z');

                CREATE TABLE collector_runs (
                    slot_at VARCHAR, date VARCHAR, status VARCHAR, trigger VARCHAR,
                    started_at VARCHAR, finished_at VARCHAR, duration_seconds DOUBLE,
                    stations INTEGER, board_rows INTEGER, detail_queue INTEGER,
                    details INTEGER, detail_attempts INTEGER, detail_failures INTEGER,
                    detail_deferred INTEGER, error VARCHAR, created_at VARCHAR
                );
                INSERT INTO collector_runs VALUES
                    ('2026-08-01T22:05:00Z','2026-08-02','success','scheduler','2026-08-01T22:05:00Z','2026-08-01T22:15:00Z',600,2797,10000,100,98,100,2,0,NULL,'2026-08-01T22:05:00Z');

                CREATE TABLE snapshots (
                    id INTEGER, date VARCHAR, captured_at VARCHAR, finished_at VARCHAR,
                    duration_seconds DOUBLE, status VARCHAR, treni_giorno INTEGER,
                    treni_circolanti INTEGER, raw_json VARCHAR
                );
                INSERT INTO snapshots VALUES
                    (1,'2026-08-02','2026-08-01T22:05:00Z','2026-08-01T22:15:00Z',600,'success',7000,100,'{}');
                """
            )

            datasets = []
            specs = (
                ("train_services", "service_date", "service_date", ("2026-08-01", "2026-08-02")),
                ("train_stop_events", "service_date", "service_date", ("2026-08-01", "2026-08-02")),
                ("train_observations", "collection_date", "collection_date", ("2026-08-01", "2026-08-02", "2026-08-03")),
                ("collector_runs", "date", "collection_date", ("2026-08-02",)),
                ("snapshots", "date", "collection_date", ("2026-08-02",)),
            )
            for table, source_column, partition_key, values in specs:
                for value in values:
                    relative = Path("datasets") / "schema=v1" / f"dataset={table}" / f"{partition_key}={value}" / "part-00000.parquet"
                    destination = self.archive / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    escaped = str(destination).replace("'", "''")
                    connection.execute(
                        f"COPY (SELECT * FROM {table} WHERE {source_column}='{value}') "
                        f"TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)"
                    )
                    datasets.append(
                        {
                            "dataset": table,
                            "partition": {partition_key: value},
                            "path": relative.as_posix(),
                        }
                    )
        finally:
            connection.close()

        manifest_root = self.archive / "manifests"
        manifest_root.mkdir(parents=True)
        manifest = {
            "formatVersion": 1,
            "datasetSchemaVersion": 1,
            "runId": "analytics-fixture",
            "createdAt": "2026-08-04T02:00:00Z",
            "asOfDate": "2026-08-03",
            "coverage": {
                "collectionDayQuality": {
                    "items": [
                        {
                            "date": "2026-08-02",
                            "coverageStatus": "complete",
                            "comparisonEligible": True,
                            "scheduleComplete": True,
                            "scheduledSlotCount": 49,
                            "requiredSlotCount": 48,
                            "missingCollectorRunSlots": [],
                            "missingSnapshotSlots": [],
                            "observationRows": 2,
                            "reason": None,
                        }
                    ]
                }
            },
            "datasets": datasets,
        }
        (manifest_root / "analytics-fixture.complete.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )

    def test_build_preserves_service_identity_and_professional_metrics(self):
        result = analytics_build(self.config)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["asOfDate"], "2026-08-02")

        database = self.analytics / "analytics.db"
        self.assertTrue(database.is_file())
        with closing(sqlite3.connect(database)) as connection:
            connection.row_factory = sqlite3.Row
            august_first = connection.execute(
                "SELECT * FROM network_day WHERE service_date='2026-08-01'"
            ).fetchone()
            self.assertEqual(august_first["observed_services"], 2)
            self.assertEqual(august_first["outcome_eligible_services"], 2)
            self.assertEqual(august_first["cancelled_services"], 1)
            self.assertEqual(august_first["arrival_sample"], 1)
            self.assertEqual(august_first["within_15"], 1)

            window = connection.execute(
                "SELECT * FROM network_window WHERE as_of_date='2026-08-02' AND window_days=7"
            ).fetchone()
            self.assertEqual(window["observed_services"], 4)
            self.assertEqual(window["outcome_eligible_services"], 3)
            self.assertEqual(window["arrival_sample"], 2)
            self.assertEqual(window["over_120"], 1)
            self.assertGreater(window["delay_p90"], 100)

            operators = connection.execute(
                "SELECT dimension_key, observed_services FROM dimension_window "
                "WHERE as_of_date='2026-08-02' AND window_days=7 "
                "AND dimension_type='operator' ORDER BY dimension_key"
            ).fetchall()
            self.assertEqual([(row[0], row[1]) for row in operators], [("10", 1), ("2", 2), ("4", 1)])

            historical_dimension_types = connection.execute(
                "SELECT DISTINCT dimension_type FROM dimension_window "
                "WHERE as_of_date='2026-08-01' ORDER BY dimension_type"
            ).fetchall()
            self.assertEqual(
                [row[0] for row in historical_dimension_types],
                ["category", "operator"],
            )

            latest_dimension_types = connection.execute(
                "SELECT DISTINCT dimension_type FROM dimension_window "
                "WHERE as_of_date='2026-08-02' ORDER BY dimension_type"
            ).fetchall()
            self.assertEqual(
                [row[0] for row in latest_dimension_types],
                ["category", "operator", "relation", "station"],
            )

            latest_station = connection.execute(
                "SELECT observed_services, outcome_eligible_services, "
                "arrival_sample, within_15, delay_p90 FROM dimension_window "
                "WHERE as_of_date='2026-08-02' AND window_days=7 "
                "AND dimension_type='station' AND dimension_key='S010'"
            ).fetchone()
            self.assertEqual(tuple(latest_station[:4]), (1, 1, 1, 1))
            self.assertEqual(latest_station[4], 10)

            latest_relation = connection.execute(
                "SELECT observed_services, outcome_eligible_services, "
                "arrival_sample, within_15, delay_p90 FROM dimension_window "
                "WHERE as_of_date='2026-08-02' AND window_days=7 "
                "AND dimension_type='relation' "
                "AND dimension_key='MILANO CENTRALE -> ROMA TERMINI'"
            ).fetchone()
            self.assertEqual(tuple(latest_relation[:4]), (1, 1, 1, 1))
            self.assertEqual(latest_relation[4], 10)

            daily_dimension_types = connection.execute(
                "SELECT DISTINCT dimension_type FROM dimension_day "
                "WHERE service_date='2026-08-01' ORDER BY dimension_type"
            ).fetchall()
            self.assertEqual(
                [row[0] for row in daily_dimension_types],
                ["category", "operator", "relation", "station"],
            )

            duplicate_number = connection.execute(
                "SELECT COUNT(*) FROM outlier_service WHERE train_number='100'"
            ).fetchone()[0]
            self.assertEqual(duplicate_number, 2)

            cross_midnight = connection.execute(
                "SELECT observed_services, cross_midnight_services, duration_sample "
                "FROM cross_midnight_window WHERE as_of_date='2026-08-02' "
                "AND window_days=7 AND period='current' "
                "AND filter_type='all' AND filter_key='all'"
            ).fetchone()
            self.assertEqual(tuple(cross_midnight), (3, 3, 3))

            milano_station = connection.execute(
                "SELECT observed_services, departures, arrivals, transits "
                "FROM station_window WHERE as_of_date='2026-08-02' "
                "AND window_days=7 AND period='current' "
                "AND filter_type='all' AND station_code='S001'"
            ).fetchone()
            self.assertEqual(tuple(milano_station), (1, 1, 0, 0))

            roma_relation = connection.execute(
                "SELECT recovery_sample, recovered_services, delay_change_mean, "
                "cross_midnight_services FROM relation_feature_window "
                "WHERE as_of_date='2026-08-02' AND window_days=7 "
                "AND period='current' AND filter_type='all' "
                "AND relation_id='MILANO CENTRALE -> ROMA TERMINI'"
            ).fetchone()
            self.assertEqual(tuple(roma_relation), (1, 0, 5.0, 1))

            service_lifecycle = connection.execute(
                "SELECT station_name, departure_delay, arrival_delay "
                "FROM outlier_stop WHERE train_key='200-S003-1785708000000' "
                "ORDER BY stop_number"
            ).fetchall()
            self.assertEqual(
                [tuple(row) for row in service_lifecycle],
                [("TORINO PORTA NUOVA", 120, None), ("LECCE", None, 180)],
            )

            quality = connection.execute(
                "SELECT coverage_status, comparison_eligible FROM quality_day "
                "WHERE collection_date='2026-08-02'"
            ).fetchone()
            self.assertEqual(tuple(quality), ("complete", 1))

            metadata = dict(connection.execute("SELECT name, value FROM analytics_metadata"))
            self.assertEqual(metadata["schemaVersion"], "2")
            self.assertEqual(metadata["metricDefinitionVersion"], "2026-08-11-v2")
            self.assertEqual(metadata["asOfDate"], "2026-08-02")

    def test_build_disables_duckdb_insertion_order_preservation(self):
        captured_config = None

        class DuckDBProxy:
            @staticmethod
            def connect(*args, **kwargs):
                nonlocal captured_config
                captured_config = kwargs.get("config")
                return duckdb.connect(*args, **kwargs)

        with patch("analytics_statistics._import_duckdb", return_value=DuckDBProxy()):
            analytics_build(self.config)

        self.assertIsNotNone(captured_config)
        self.assertEqual(captured_config["memory_limit"], "128MB")
        self.assertEqual(captured_config["threads"], "1")
        self.assertEqual(captured_config["max_temp_directory_size"], "4GB")
        self.assertEqual(captured_config["preserve_insertion_order"], "false")

    def test_fact_and_rolling_batches_preserve_exact_metrics(self):
        analytics_build(replace(self.config, window_batch_days=1))
        with closing(sqlite3.connect(self.analytics / "analytics.db")) as connection:
            expected_network = connection.execute(
                "SELECT * FROM network_window ORDER BY as_of_date, window_days"
            ).fetchall()
            expected_dimensions = connection.execute(
                "SELECT * FROM dimension_window "
                "ORDER BY as_of_date, window_days, dimension_type, dimension_key"
            ).fetchall()

        batched_root = self.root / "analytics-batched"
        analytics_build(
            replace(
                self.config,
                analytics_root=batched_root,
                fact_batch_days=2,
                window_batch_days=2,
            )
        )
        with closing(sqlite3.connect(batched_root / "analytics.db")) as connection:
            actual_network = connection.execute(
                "SELECT * FROM network_window ORDER BY as_of_date, window_days"
            ).fetchall()
            actual_dimensions = connection.execute(
                "SELECT * FROM dimension_window "
                "ORDER BY as_of_date, window_days, dimension_type, dimension_key"
            ).fetchall()

        self.assertEqual(actual_network, expected_network)
        self.assertEqual(actual_dimensions, expected_dimensions)

    def test_failed_rebuild_does_not_replace_last_good_read_model(self):
        first = analytics_build(self.config)
        database = self.analytics / "analytics.db"
        first_bytes = database.read_bytes()

        for manifest in (self.archive / "manifests").glob("*.complete.json"):
            manifest.unlink()
        with self.assertRaisesRegex(RuntimeError, "no completed archive manifests"):
            analytics_build(self.config)

        self.assertEqual(database.read_bytes(), first_bytes)
        self.assertEqual(first["status"], "success")

    def test_failed_build_cleans_temporary_publication_files(self):
        abandoned = self.analytics / "analytics-abandoned"
        abandoned.mkdir(parents=True)
        (abandoned / "duckdb-temp").mkdir()
        (abandoned / "duckdb-temp" / "spill.tmp").write_bytes(b"stale")

        with patch("analytics_statistics._create_archive_views", side_effect=RuntimeError("boom")):
            with self.assertRaisesRegex(RuntimeError, "boom"):
                analytics_build(self.config)

        self.assertFalse((self.analytics / ".analytics.db.partial").exists())
        self.assertEqual(list(self.analytics.glob("analytics-*")), [])


class StatisticsAnalyticsLockTest(unittest.TestCase):
    def test_abandoned_work_roots_are_removed_without_touching_read_model(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
            root = Path(temporary)
            read_model = root / "analytics.db"
            read_model.write_bytes(b"published")
            abandoned = root / "analytics-abandoned"
            abandoned.mkdir()
            (abandoned / "spill.tmp").write_bytes(b"stale")

            with analytics_lock(root):
                removed = remove_abandoned_work_roots(root)

            self.assertEqual(removed, 1)
            self.assertFalse(abandoned.exists())
            self.assertEqual(read_model.read_bytes(), b"published")

    def test_cleanup_command_reports_removed_work_roots(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
            root = Path(temporary)
            abandoned = root / "analytics-abandoned"
            abandoned.mkdir()

            result = analytics_cleanup(
                AnalyticsConfig(
                    archive_root=root / "archive",
                    analytics_root=root,
                    as_of_date=None,
                    memory_limit="128MB",
                    threads=1,
                    max_history_days=730,
                    minimum_ranking_sample=100,
                )
            )

            self.assertEqual(
                result,
                {
                    "mode": "cleanup",
                    "status": "success",
                    "removedWorkRoots": 1,
                },
            )
            self.assertFalse(abandoned.exists())

    def test_concurrent_build_lock_fails_without_blocking(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
            root = Path(temporary)
            with analytics_lock(root):
                with self.assertRaisesRegex(RuntimeError, "another statistics analytics build"):
                    with analytics_lock(root):
                        pass


@unittest.skipUnless(DUCKDB_AVAILABLE, "DuckDB is required for analytics tests")
class StatisticsAnalyticsMemoryBoundTest(unittest.TestCase):
    def test_daily_fact_batches_complete_under_small_duckdb_limit(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
            connection = duckdb.connect(
                config={
                    "memory_limit": "192MB",
                    "threads": "1",
                    "temp_directory": str(Path(temporary) / "duckdb-temp"),
                    "max_temp_directory_size": "1GB",
                    "preserve_insertion_order": "false",
                }
            )
            try:
                connection.execute(
                    """
                    CREATE TABLE train_services AS
                    SELECT CAST(DATE '2026-01-01' + day_number * INTERVAL 1 DAY
                                AS VARCHAR) AS service_date,
                           CAST(service_number AS VARCHAR) AS train_key,
                           CAST(service_number AS VARCHAR) AS train_number,
                           'canonical' AS identity_quality,
                           '2' AS operator, 'REG' AS category,
                           'ORIGIN' AS origin, 'DESTINATION' AS destination,
                           'S001' AS origin_code, 'S002' AS destination_code,
                           'S001|S002' AS relation_key, 'completed' AS status,
                           0 AS cancelled, 1 AS completed, 0 AS rescheduled,
                           0 AS not_departed,
                           '2026-01-01T06:00:00Z' AS scheduled_departure,
                           '2026-01-01T07:00:00Z' AS scheduled_arrival,
                           '2026-01-01T05:00:00Z' AS first_seen,
                           '2026-01-01T08:00:00Z' AS last_seen,
                           '2026-01-01T08:00:00Z' AS detail_last_seen,
                           1 AS has_details, 100 AS latest_state_quality,
                           100 AS detail_quality,
                           CASE WHEN service_number=0 THEN NULL ELSE 5 END
                               AS arrival_delay,
                           1 AS departure_delay
                    FROM range(3) AS days(day_number)
                    CROSS JOIN range(8000) AS services(service_number);

                    CREATE TABLE train_observations AS
                    SELECT service_date, train_key,
                           '2026-01-01T06:30:00Z' AS observed_at,
                           100 AS quality_score
                    FROM train_services;

                    CREATE TABLE train_stop_events AS
                    SELECT s.service_date, s.train_key, stop_number,
                           'S' || CAST(stop_number AS VARCHAR) AS station_code,
                           'Station ' || CAST(stop_number AS VARCHAR) AS station_name,
                           CASE WHEN stop_number=0 THEN 'origine'
                                WHEN stop_number=11 THEN 'destinazione'
                                ELSE 'fermata' END AS stop_type,
                           '1' AS platform,
                           '2026-01-01T06:00:00Z' AS arrival_expected,
                           s.service_date AS arrival_expected_date,
                           '2026-01-01T06:05:00Z' AS arrival_actual,
                           s.service_date AS arrival_actual_date,
                           CASE WHEN s.train_key='0' AND stop_number=11
                                THEN NULL ELSE 5 END AS arrival_delay,
                           '2026-01-01T06:10:00Z' AS departure_expected,
                           s.service_date AS departure_expected_date,
                           '2026-01-01T06:15:00Z' AS departure_actual,
                           s.service_date AS departure_actual_date,
                           5 AS departure_delay, 0 AS cancelled,
                           '2026-01-01T06:30:00Z' AS detail_observed_at,
                           100 AS detail_quality
                    FROM train_services s
                    CROSS JOIN range(12) AS stops(stop_number)
                    """
                )
                _build_stabilized_facts(
                    connection,
                    max_date="2026-01-03",
                    max_history_days=90,
                    batch_days=1,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM fact_service_outcome"
                    ).fetchone()[0],
                    24_000,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM fact_stop_outcome"
                    ).fetchone()[0],
                    288_000,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM fact_service_outcome "
                        "WHERE train_key='0' AND final_arrival_delay IS NULL"
                    ).fetchone()[0],
                    3,
                )
            finally:
                connection.close()

    def test_daily_batches_complete_under_small_duckdb_limit(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
            connection = duckdb.connect(
                config={
                    "memory_limit": "32MB",
                    "threads": "1",
                    "temp_directory": str(Path(temporary) / "duckdb-temp"),
                    "preserve_insertion_order": "false",
                }
            )
            try:
                connection.execute(
                    """
                    CREATE TEMP TABLE fact_service_outcome AS
                    SELECT CAST(DATE '2026-01-01' + day_number * INTERVAL 1 DAY AS VARCHAR)
                               AS service_date,
                           CAST(service_number AS VARCHAR) AS train_key,
                           CAST(service_number % 7 AS VARCHAR) AS operator,
                           CASE service_number % 4
                               WHEN 0 THEN 'REG' WHEN 1 THEN 'FR'
                               WHEN 2 THEN 'IC' ELSE 'MET' END AS category,
                           1 AS outcome_eligible,
                           1 AS arrival_eligible,
                           0 AS cancelled,
                           1 AS completed,
                           CAST(service_number % 181 - 30 AS INTEGER)
                               AS final_arrival_delay
                    FROM range(60) AS days(day_number)
                    CROSS JOIN range(2500) AS services(service_number)
                    """
                )
                connection.execute(
                    """
                    CREATE TEMP VIEW rolling_dimension_fact AS
                    SELECT service_date, 'operator' AS dimension_type,
                           operator AS dimension_key, operator AS dimension_label,
                           outcome_eligible, arrival_eligible, cancelled, completed,
                           final_arrival_delay
                    FROM fact_service_outcome
                    UNION ALL
                    SELECT service_date, 'category', category, category,
                           outcome_eligible, arrival_eligible, cancelled, completed,
                           final_arrival_delay
                    FROM fact_service_outcome
                    """
                )

                _build_rolling_windows(
                    connection,
                    max_date="2026-03-01",
                    max_history_days=90,
                    batch_days=7,
                )

                self.assertEqual(
                    connection.execute("SELECT COUNT(*) FROM network_window").fetchone()[0],
                    180,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(DISTINCT as_of_date) FROM dimension_window"
                    ).fetchone()[0],
                    60,
                )
                latest = connection.execute(
                    "SELECT observed_services, arrival_sample FROM network_window "
                    "WHERE as_of_date='2026-03-01' AND window_days=7"
                ).fetchone()
                self.assertEqual(latest, (17500, 17500))
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
