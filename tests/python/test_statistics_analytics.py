import json
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
STATISTICS_DIR = ROOT / "rfi-proxy" / "statistics"
sys.path.insert(0, str(STATISTICS_DIR))

from analytics_statistics import AnalyticsConfig, analytics_build, analytics_lock  # noqa: E402


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
        with sqlite3.connect(database) as connection:
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
        with patch("analytics_statistics._create_archive_views", side_effect=RuntimeError("boom")):
            with self.assertRaisesRegex(RuntimeError, "boom"):
                analytics_build(self.config)

        self.assertFalse((self.analytics / ".analytics.db.partial").exists())
        self.assertEqual(list(self.analytics.glob("analytics-*")), [])


class StatisticsAnalyticsLockTest(unittest.TestCase):
    def test_concurrent_build_lock_fails_without_blocking(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
            root = Path(temporary)
            with analytics_lock(root):
                with self.assertRaisesRegex(RuntimeError, "another statistics analytics build"):
                    with analytics_lock(root):
                        pass


if __name__ == "__main__":
    unittest.main()
