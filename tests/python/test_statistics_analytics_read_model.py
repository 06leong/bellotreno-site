import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
STATISTICS_DIR = ROOT / "rfi-proxy" / "statistics"
sys.path.insert(0, str(STATISTICS_DIR))

from analytics_read_model import (  # noqa: E402
    AnalyticsReadModel,
    AnalyticsUnavailable,
    METRIC_COUNT_FIELDS,
    wilson_interval,
)


METRIC_DEFINITIONS = ", ".join(f"{name} INTEGER" for name in METRIC_COUNT_FIELDS)
METRIC_VALUES = {
    "service_days": 1,
    "observed_services": 1000,
    "outcome_eligible_services": 900,
    "cancelled_services": 45,
    "completed_services": 855,
    "arrival_sample": 800,
    "within_5": 600,
    "within_15": 720,
    "over_30": 40,
    "over_60": 20,
    "over_120": 5,
    "bucket_early": 80,
    "bucket_0_5": 520,
    "bucket_6_15": 120,
    "bucket_16_30": 40,
    "bucket_31_60": 20,
    "bucket_61_120": 15,
    "bucket_over_120": 5,
}


def metric_values(multiplier=1, service_days=1):
    counts = [METRIC_VALUES[name] * multiplier for name in METRIC_COUNT_FIELDS]
    counts[METRIC_COUNT_FIELDS.index("service_days")] = service_days
    return [*counts, 4.0, 8.0, 22.0, 38.0, 9.5]


class StatisticsAnalyticsReadModelTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.database = Path(self.temporary.name) / "analytics.db"
        with sqlite3.connect(self.database) as connection:
            connection.executescript(
                f"""
                CREATE TABLE analytics_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE network_day (
                    service_date TEXT, {METRIC_DEFINITIONS},
                    delay_p50 REAL, delay_p75 REAL, delay_p90 REAL,
                    delay_p95 REAL, delay_mean REAL
                );
                CREATE TABLE dimension_day (
                    service_date TEXT, dimension_type TEXT, dimension_key TEXT,
                    dimension_label TEXT, {METRIC_DEFINITIONS},
                    delay_p50 REAL, delay_p75 REAL, delay_p90 REAL,
                    delay_p95 REAL, delay_mean REAL
                );
                CREATE TABLE network_window (
                    as_of_date TEXT, window_days INTEGER, window_start TEXT,
                    {METRIC_DEFINITIONS}, delay_p50 REAL, delay_p75 REAL,
                    delay_p90 REAL, delay_p95 REAL, delay_mean REAL
                );
                CREATE TABLE dimension_window (
                    as_of_date TEXT, window_days INTEGER, window_start TEXT,
                    dimension_type TEXT, dimension_key TEXT, dimension_label TEXT,
                    {METRIC_DEFINITIONS}, delay_p50 REAL, delay_p75 REAL,
                    delay_p90 REAL, delay_p95 REAL, delay_mean REAL
                );
                CREATE TABLE quality_day (
                    collection_date TEXT, coverage_status TEXT,
                    comparison_eligible INTEGER, schedule_complete INTEGER,
                    scheduled_slot_count INTEGER, required_slot_count INTEGER,
                    missing_run_slots INTEGER, missing_snapshot_slots INTEGER,
                    observation_rows INTEGER, reason TEXT, collector_runs INTEGER,
                    successful_runs INTEGER, detail_attempts INTEGER, details INTEGER,
                    detail_failures INTEGER, stations INTEGER, last_finished_at TEXT,
                    snapshots INTEGER, successful_snapshots INTEGER,
                    circulated INTEGER, peak_running INTEGER, last_snapshot_at TEXT
                );
                CREATE TABLE outlier_service (
                    service_date TEXT, train_key TEXT, train_number TEXT,
                    operator TEXT, category TEXT, origin TEXT, destination TEXT,
                    origin_code TEXT, destination_code TEXT, relation_key TEXT,
                    status TEXT, cancelled INTEGER, completed INTEGER,
                    final_arrival_delay INTEGER, final_departure_delay INTEGER,
                    scheduled_departure TEXT, scheduled_arrival TEXT,
                    first_observed_at TEXT, last_observed_at TEXT,
                    observation_count INTEGER, latest_state_quality INTEGER,
                    detail_quality INTEGER, observation_quality INTEGER
                );
                """
            )
            metadata = {
                "schemaVersion": "1",
                "metricDefinitionVersion": "2026-08-09-v1",
                "buildId": "fixture-build",
                "builtAt": "2026-08-29T02:30:00Z",
                "asOfDate": "2026-08-28",
                "sourceLatestCreatedAt": "2026-08-29T02:00:00Z",
                "sourceLatestAsOfDate": "2026-08-29",
                "sourceManifests": json.dumps(["manifest-a"]),
                "windows": json.dumps([7, 28, 90]),
                "minimumRankingSample": "100",
            }
            connection.executemany(
                "INSERT INTO analytics_metadata VALUES (?, ?)", metadata.items()
            )
            metric_placeholders = ",".join("?" for _ in range(len(METRIC_COUNT_FIELDS) + 5))
            connection.execute(
                f"INSERT INTO network_day VALUES (?, {metric_placeholders})",
                ["2026-08-28", *metric_values()],
            )
            connection.execute(
                f"INSERT INTO dimension_day VALUES (?, ?, ?, ?, {metric_placeholders})",
                ["2026-08-28", "operator", "10", "10", *metric_values()],
            )
            for as_of, start, multiplier in (
                ("2026-08-28", "2026-08-22", 1),
                ("2026-08-21", "2026-08-15", 2),
            ):
                connection.execute(
                    f"INSERT INTO network_window VALUES (?, ?, ?, {metric_placeholders})",
                    [as_of, 7, start, *metric_values(multiplier, service_days=7)],
                )
                connection.execute(
                    f"INSERT INTO dimension_window VALUES (?, ?, ?, ?, ?, ?, {metric_placeholders})",
                    [as_of, 7, start, "operator", "10", "10", *metric_values(multiplier, service_days=7)],
                )
            connection.execute(
                "INSERT INTO quality_day VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "2026-08-28", "complete", 1, 1, 49, 48, 0, 0, 70000,
                    None, 49, 49, 1000, 990, 10, 2797,
                    "2026-08-28T22:05:00Z", 49, 49, 7000, 500,
                    "2026-08-28T22:05:00Z",
                ),
            )
            connection.execute(
                "INSERT INTO outlier_service VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "2026-08-28", "100-S001-1", "100", "10", "ICN",
                    "MILANO CENTRALE", "LECCE", "S001", "S030",
                    "MILANO CENTRALE -> LECCE", "delayed", 0, 1, 180, 120,
                    "2026-08-28T20:00:00+02:00", "2026-08-29T08:00:00+02:00",
                    "2026-08-28T18:00:00Z", "2026-08-29T09:00:00Z", 12,
                    90, 90, 90,
                ),
            )
            connection.commit()
        self.model = AnalyticsReadModel(self.database)

    def tearDown(self):
        self.temporary.cleanup()

    def test_overview_returns_denominators_intervals_and_previous_window(self):
        payload = self.model.overview(as_of=None, window=7)
        self.assertTrue(payload["available"])
        self.assertEqual(payload["context"]["asOfDate"], "2026-08-28")
        self.assertEqual(payload["current"]["punctuality"]["within5"]["percent"], 75.0)
        self.assertEqual(payload["current"]["cancellation"]["denominator"], 900)
        self.assertIsNotNone(payload["current"]["punctuality"]["within5"]["confidence95"])
        self.assertEqual(payload["previous"]["observedServices"], 2000)
        self.assertEqual(payload["quality"]["completeDays"], 1)

    def test_rankings_and_outliers_preserve_exact_identifiers(self):
        ranking = self.model.rankings(
            dimension="operator", as_of=None, window=7, sort="punctuality",
            direction="desc", minimum_sample=100, limit=25, offset=0,
        )
        self.assertEqual(ranking["items"][0]["key"], "10")
        self.assertEqual(ranking["items"][0]["arrivalSample"], 800)

        outliers = self.model.outliers(as_of=None, window=7)
        self.assertEqual(outliers["items"][0]["train_key"], "100-S001-1")
        self.assertEqual(outliers["items"][0]["final_arrival_delay"], 180)

    def test_invalid_requests_and_missing_database_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "window"):
            self.model.overview(as_of=None, window=14)
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            self.model.overview(as_of=None, window=7, operator="10", category="IC")
        with self.assertRaises(AnalyticsUnavailable):
            AnalyticsReadModel(Path(self.temporary.name) / "missing.db").metadata()

    def test_wilson_interval_is_bounded(self):
        interval = wilson_interval(1, 1)
        self.assertGreaterEqual(interval["low"], 0)
        self.assertLessEqual(interval["high"], 100)
        self.assertIsNone(wilson_interval(0, 0))


if __name__ == "__main__":
    unittest.main()
