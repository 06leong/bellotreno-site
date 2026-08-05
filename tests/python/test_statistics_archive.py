import json
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import closing
from dataclasses import replace
from datetime import date
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
STATISTICS_DIR = ROOT / "rfi-proxy" / "statistics"
sys.path.insert(0, str(STATISTICS_DIR))

from archive_statistics import (  # noqa: E402
    ArchiveConfig,
    archive_lock,
    archive_run,
    build_plan,
    collection_day_quality,
    create_snapshot,
    required_completion_minutes,
    scheduled_minutes,
    slot_utc_iso,
    verify_archives,
)


def duckdb_sqlite_available() -> bool:
    try:
        import duckdb

        connection = duckdb.connect()
        try:
            connection.execute("LOAD sqlite")
        finally:
            connection.close()
        return True
    except Exception:
        return False


DUCKDB_SQLITE_AVAILABLE = duckdb_sqlite_available()
if (
    os.environ.get("STATISTICS_ARCHIVE_TESTS_REQUIRED", "").lower() in {"1", "true", "yes"}
    and not DUCKDB_SQLITE_AVAILABLE
):
    raise RuntimeError("DuckDB sqlite extension is required for archive tests")


def create_source_database(path: Path) -> None:
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE statistics_schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            INSERT INTO statistics_schema_migrations VALUES
                ('v2-additive-storage', '2026-07-14T08:00:00Z'),
                ('v2-quality-ranking', '2026-07-14T08:00:00Z');

            CREATE TABLE statistics_coverage_state (
                name TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO statistics_coverage_state VALUES
                ('v2_collection_rollout_date', '2026-08-02', '2026-08-02T00:05:00Z');

            CREATE TABLE train_services (
                service_date TEXT NOT NULL,
                train_key TEXT NOT NULL,
                train_number TEXT,
                origin_code TEXT,
                scheduled_departure TEXT,
                PRIMARY KEY (service_date, train_key)
            ) WITHOUT ROWID;
            CREATE TABLE train_observations (
                service_date TEXT NOT NULL,
                train_key TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                collection_date TEXT NOT NULL,
                delay INTEGER,
                PRIMARY KEY (service_date, train_key, observed_at, collection_date)
            ) WITHOUT ROWID;
            CREATE TABLE train_stop_events (
                service_date TEXT NOT NULL,
                train_key TEXT NOT NULL,
                stop_number INTEGER NOT NULL,
                station_code TEXT,
                arrival_expected_date TEXT,
                PRIMARY KEY (service_date, train_key, stop_number)
            ) WITHOUT ROWID;

            CREATE TABLE collector_runs (
                slot_at TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE snapshots (
                id INTEGER PRIMARY KEY,
                date TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE station_stats (
                date TEXT NOT NULL,
                station_code TEXT NOT NULL,
                monitored INTEGER,
                PRIMARY KEY (date, station_code)
            );
            CREATE TABLE station_board_stats (
                date TEXT NOT NULL,
                station_code TEXT NOT NULL,
                board_type TEXT NOT NULL,
                monitored INTEGER,
                PRIMARY KEY (date, station_code, board_type)
            );
            CREATE TABLE relation_stats (
                date TEXT NOT NULL,
                relation_key TEXT NOT NULL,
                monitored INTEGER,
                PRIMARY KEY (date, relation_key)
            );
            CREATE TABLE station_registry (
                station_code TEXT PRIMARY KEY,
                station_name TEXT NOT NULL
            );

            INSERT INTO train_services VALUES
                ('2026-07-20', '100-S001-1784502000000', '100', 'S001', '2026-07-20T23:00:00+02:00'),
                ('2026-07-20', '100-S002-1784505600000', '100', 'S002', '2026-07-21T00:00:00+02:00'),
                ('2026-08-02', '200-S003-1785711600000', '200', 'S003', '2026-08-02T23:00:00+02:00');
            INSERT INTO train_observations VALUES
                ('2026-07-20', '100-S001-1784502000000', '2026-07-21T01:05:00Z', '2026-07-21', 180),
                ('2026-07-20', '100-S002-1784505600000', '2026-07-21T02:05:00Z', '2026-07-21', 20),
                ('2026-08-02', '200-S003-1785711600000', '2026-08-03T22:05:00Z', '2026-08-03', 5),
                ('2026-08-02', '200-S003-1785711600000', '2026-08-04T08:05:00Z', '2026-08-04', 8);
            INSERT INTO train_stop_events VALUES
                ('2026-07-20', '100-S001-1784502000000', 0, 'S001', '2026-07-20'),
                ('2026-07-20', '100-S001-1784502000000', 1, 'S004', '2026-07-21'),
                ('2026-07-20', '100-S002-1784505600000', 0, 'S002', '2026-07-21'),
                ('2026-08-02', '200-S003-1785711600000', 0, 'S003', '2026-08-02');

            INSERT INTO collector_runs VALUES ('2026-08-03T22:05:00Z', '2026-08-03', 'success');
            INSERT INTO snapshots VALUES (1, '2026-08-03', '2026-08-03T22:05:00Z', 'success');
            INSERT INTO station_stats VALUES ('2026-08-03', 'S001', 2);
            INSERT INTO station_board_stats VALUES ('2026-08-03', 'S001', 'partenze', 2);
            INSERT INTO relation_stats VALUES ('2026-08-03', 'S001 -> S004', 2);
            INSERT INTO station_registry VALUES ('S001', 'MILANO CENTRALE');
            """
        )
        conn.commit()


class StatisticsArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.temporary.name)
        self.database = self.root / "statistics.db"
        self.archive = self.root / "archive"
        create_source_database(self.database)
        self.config = ArchiveConfig(
            source_db=self.database,
            archive_root=self.archive,
            as_of_date=date(2026, 8, 4),
            active_service_ttl_days=7,
            safety_gib=0,
            duckdb_memory_limit="128MB",
            duckdb_threads=1,
            timezone_name="UTC",
            observation_retention_days=2,
            legacy_retention_days=2,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_plan_separates_ended_days_from_stable_services(self):
        plan = build_plan(self.config)
        datasets = {item["dataset"]: item for item in plan["datasets"]}

        self.assertTrue(plan["capacityOk"])
        self.assertEqual(datasets["train_observations"]["pending"], 3)
        self.assertEqual(datasets["train_observations"]["newestPending"], "2026-08-03")
        self.assertEqual(datasets["train_observations"]["historicalGapCount"], 0)
        self.assertEqual(datasets["train_services"]["pending"], 1)
        self.assertEqual(datasets["train_services"]["newestPending"], "2026-07-20")
        self.assertEqual(datasets["train_stop_events"]["pending"], 1)
        self.assertEqual(datasets["station_registry"]["pending"], 1)
        self.assertTrue(plan["continuityOk"])
        self.assertEqual(plan["collectionDayQuality"]["unavailable"], 2)
        self.assertEqual(plan["collectionDayQuality"]["partial"], 1)

    def test_future_as_of_date_is_rejected(self):
        args = types.SimpleNamespace(
            as_of_date="2999-01-01",
            source_db=str(self.database),
            archive_root=str(self.archive),
        )
        with patch.dict(os.environ, {"TZ": "UTC"}):
            with self.assertRaisesRegex(ValueError, "is not ready"):
                ArchiveConfig.from_args(args)

    def test_schedule_offset_outside_collector_range_is_rejected(self):
        args = types.SimpleNamespace(
            as_of_date="2026-08-04",
            source_db=str(self.database),
            archive_root=str(self.archive),
        )
        with patch.dict(
            os.environ,
            {"ARCHIVE_SCHEDULE_OFFSET_MINUTES": "60"},
        ):
            with self.assertRaisesRegex(ValueError, "between 0 and 59"):
                ArchiveConfig.from_args(args)

    def test_default_schedule_and_dst_slots_match_collector_rules(self):
        default_config = replace(self.config, timezone_name="Europe/Rome")
        self.assertEqual(len(scheduled_minutes(default_config)), 49)
        self.assertEqual(len(required_completion_minutes(default_config)), 48)
        self.assertNotIn(5, required_completion_minutes(default_config))
        self.assertEqual(
            slot_utc_iso(date(2026, 3, 29), 125, "Europe/Rome"),
            "2026-03-29T01:05:00Z",
        )
        self.assertEqual(
            slot_utc_iso(date(2026, 3, 29), 185, "Europe/Rome"),
            "2026-03-29T01:05:00Z",
        )

    def test_archive_lock_rejects_a_second_writer(self):
        with archive_lock(self.archive):
            with self.assertRaisesRegex(RuntimeError, "another statistics archive run"):
                with archive_lock(self.archive):
                    self.fail("a second writer acquired the archive lock")

    def test_plan_reports_dates_lost_beyond_live_retention(self):
        with closing(sqlite3.connect(self.database)) as conn:
            conn.execute(
                "UPDATE statistics_coverage_state SET value='2026-07-30' "
                "WHERE name='v2_collection_rollout_date'"
            )
            conn.commit()

        plan = build_plan(self.config)
        observations = next(
            item
            for item in plan["datasets"]
            if item["dataset"] == "train_observations"
        )
        self.assertFalse(plan["continuityOk"])
        self.assertEqual(observations["historicalGapCount"], 3)
        self.assertEqual(
            observations["historicalGapRanges"],
            [{"from": "2026-07-30", "to": "2026-08-01", "days": 3}],
        )

    def test_plan_reports_stable_service_dates_lost_beyond_retention(self):
        with closing(sqlite3.connect(self.database)) as conn:
            conn.execute(
                "UPDATE statistics_coverage_state SET value='2026-07-10' "
                "WHERE name='v2_collection_rollout_date'"
            )
            conn.commit()

        plan = build_plan(replace(self.config, service_retention_days=2))
        services = next(
            item
            for item in plan["datasets"]
            if item["dataset"] == "train_services"
        )
        stops = next(
            item
            for item in plan["datasets"]
            if item["dataset"] == "train_stop_events"
        )
        self.assertEqual(services["historicalGapCount"], 17)
        self.assertEqual(stops["historicalGapCount"], 17)

    def test_collection_day_bridge_matches_collector_semantics(self):
        bridge_config = replace(self.config, cadence_minutes=1440)
        with closing(sqlite3.connect(self.database)) as conn:
            conn.executemany(
                "INSERT INTO collector_runs VALUES (?, '2026-08-03', 'success')",
                [
                    ("2026-08-03T00:05:00Z",),
                    ("2026-08-03T23:55:00Z",),
                ],
            )
            conn.executemany(
                "INSERT INTO snapshots VALUES (?, '2026-08-03', ?, 'success')",
                [
                    (2, "2026-08-03T00:05:00Z"),
                    (3, "2026-08-03T23:55:00Z"),
                ],
            )
            conn.commit()
        with closing(sqlite3.connect(self.database)) as conn:
            quality = collection_day_quality(conn, bridge_config, "2026-08-03")

        self.assertTrue(quality["scheduleComplete"])
        self.assertTrue(quality["comparisonEligible"])
        self.assertEqual(quality["coverageStatus"], "complete")
        self.assertEqual(
            quality["bridgeSatisfiedBy"],
            ["2026-08-03T00:05:00Z"],
        )
        self.assertEqual(quality["missingCollectorRunSlots"], [])
        self.assertEqual(quality["missingSnapshotSlots"], [])

    def test_backup_snapshot_includes_committed_wal_rows(self):
        snapshot = self.root / "wal-snapshot.db"
        writer = sqlite3.connect(self.database)
        try:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(
                "INSERT INTO station_registry VALUES ('S002', 'ROMA TERMINI')"
            )
            writer.commit()
            self.assertTrue(Path(f"{self.database}-wal").exists())

            create_snapshot(self.database, snapshot)
            with closing(
                sqlite3.connect(
                    f"file:{snapshot.resolve().as_posix()}?mode=ro&immutable=1",
                    uri=True,
                )
            ) as copied:
                self.assertEqual(
                    copied.execute(
                        "SELECT station_name FROM station_registry WHERE station_code='S002'"
                    ).fetchone()[0],
                    "ROMA TERMINI",
                )
        finally:
            writer.close()

    @unittest.skipUnless(
        DUCKDB_SQLITE_AVAILABLE,
        "DuckDB with its preinstalled sqlite extension is required",
    )
    def test_run_is_verified_and_idempotent(self):
        result = archive_run(self.config)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["publishedPartitions"], 16)
        verification = verify_archives(self.config)
        self.assertEqual(verification["status"], "success")
        self.assertEqual(verification["verifiedPartitions"], 16)

        second = archive_run(self.config)
        self.assertEqual(second["status"], "noop")
        self.assertEqual(second["publishedPartitions"], 0)

        manifests = list((self.archive / "manifests").glob("*.complete.json"))
        self.assertEqual(len(manifests), 1)
        manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
        service_item = next(
            item for item in manifest["datasets"] if item["dataset"] == "train_services"
        )
        self.assertEqual(service_item["rows"], 2)
        empty_observation = next(
            item
            for item in manifest["datasets"]
            if item["dataset"] == "train_observations"
            and item["partition"] == {"collection_date": "2026-08-02"}
        )
        self.assertEqual(empty_observation["rows"], 0)
        self.assertIsNone(empty_observation["partitionMin"])
        self.assertIsNone(empty_observation["partitionMax"])
        quality_by_date = {
            item["date"]: item
            for item in manifest["coverage"]["collectionDayQuality"]["items"]
        }
        self.assertEqual(quality_by_date["2026-08-02"]["coverageStatus"], "unavailable")
        self.assertEqual(quality_by_date["2026-08-03"]["coverageStatus"], "partial")

    @unittest.skipUnless(
        DUCKDB_SQLITE_AVAILABLE,
        "DuckDB with its preinstalled sqlite extension is required",
    )
    def test_verify_detects_changed_parquet_bytes(self):
        archive_run(self.config)
        manifest_path = next((self.archive / "manifests").glob("*.complete.json"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        parquet_path = self.archive / manifest["datasets"][0]["path"]
        with parquet_path.open("ab") as handle:
            handle.write(b"changed")

        with self.assertRaisesRegex(RuntimeError, "size differs"):
            verify_archives(self.config)

    @unittest.skipUnless(
        DUCKDB_SQLITE_AVAILABLE,
        "DuckDB with its preinstalled sqlite extension is required",
    )
    def test_verify_rejects_invalid_manifest_metadata(self):
        archive_run(self.config)
        manifest_path = next((self.archive / "manifests").glob("*.complete.json"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["datasets"][0]["primaryKey"] = []
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(RuntimeError, "invalid primary key"):
            verify_archives(self.config)

    @unittest.skipUnless(
        DUCKDB_SQLITE_AVAILABLE,
        "DuckDB with its preinstalled sqlite extension is required",
    )
    def test_published_zero_partition_rejects_late_rows(self):
        archive_run(self.config)
        with closing(sqlite3.connect(self.database)) as conn:
            conn.execute(
                """
                INSERT INTO train_observations VALUES (?, ?, ?, ?, ?)
                """,
                (
                    "2026-07-20",
                    "100-S001-1784502000000",
                    "2026-08-02T12:05:00Z",
                    "2026-08-02",
                    181,
                ),
            )
            conn.commit()

        with self.assertRaisesRegex(RuntimeError, "changed from 0 to 1 live rows"):
            build_plan(self.config)

    @unittest.skipUnless(
        DUCKDB_SQLITE_AVAILABLE,
        "DuckDB with its preinstalled sqlite extension is required",
    )
    def test_schema_drift_is_rejected_before_publication(self):
        archive_run(self.config)
        original_manifests = list((self.archive / "manifests").glob("*.complete.json"))

        with closing(sqlite3.connect(self.database)) as conn:
            conn.execute("ALTER TABLE train_services ADD COLUMN new_field TEXT")
            conn.execute(
                """
                INSERT INTO train_services (
                    service_date, train_key, train_number, origin_code,
                    scheduled_departure, new_field
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    "2026-07-21",
                    "300-S005-1784588400000",
                    "300",
                    "S005",
                    "2026-07-21T23:00:00+02:00",
                    "schema-drift",
                ),
            )
            conn.commit()

        with self.assertRaisesRegex(RuntimeError, "schema changed"):
            archive_run(self.config)

        self.assertEqual(
            list((self.archive / "manifests").glob("*.complete.json")),
            original_manifests,
        )
        drift_path = (
            self.archive
            / "datasets"
            / "schema=v1"
            / "dataset=train_services"
            / "service_date=2026-07-21"
            / "part-00000.parquet"
        )
        self.assertFalse(drift_path.exists())

    @unittest.skipUnless(
        DUCKDB_SQLITE_AVAILABLE,
        "DuckDB with its preinstalled sqlite extension is required",
    )
    def test_plan_fails_when_a_published_file_is_missing(self):
        archive_run(self.config)
        manifest_path = next((self.archive / "manifests").glob("*.complete.json"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        archived_file = self.archive / manifest["datasets"][0]["path"]
        archived_file.unlink()

        with self.assertRaisesRegex(RuntimeError, "published archive file is missing"):
            build_plan(self.config)


if __name__ == "__main__":
    unittest.main()
