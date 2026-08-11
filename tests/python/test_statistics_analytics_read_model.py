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
                CREATE TABLE operator_category_window (
                    as_of_date TEXT, window_days INTEGER, period TEXT,
                    window_start TEXT, window_end TEXT, operator TEXT, category TEXT,
                    {METRIC_DEFINITIONS}, delay_p50 REAL, delay_p75 REAL,
                    delay_p90 REAL, delay_p95 REAL, delay_mean REAL
                );
                CREATE TABLE rhythm_window (
                    as_of_date TEXT, window_days INTEGER, period TEXT,
                    filter_type TEXT, filter_key TEXT, weekday INTEGER, hour INTEGER,
                    {METRIC_DEFINITIONS}, delay_p50 REAL, delay_p75 REAL,
                    delay_p90 REAL, delay_p95 REAL, delay_mean REAL
                );
                CREATE TABLE station_window (
                    as_of_date TEXT, window_days INTEGER, period TEXT,
                    filter_type TEXT, filter_key TEXT, station_code TEXT,
                    station_label TEXT, observed_services INTEGER,
                    arrivals INTEGER, departures INTEGER, transits INTEGER,
                    outcome_eligible_services INTEGER, cancelled_services INTEGER,
                    arrival_sample INTEGER, within_5 INTEGER, within_15 INTEGER,
                    over_60 INTEGER, delay_p50 REAL, delay_p90 REAL
                );
                CREATE TABLE station_hour_window (
                    as_of_date TEXT, window_days INTEGER, station_code TEXT,
                    station_label TEXT, weekday INTEGER, hour INTEGER,
                    observed_services INTEGER, arrivals INTEGER,
                    departures INTEGER, transits INTEGER
                );
                CREATE TABLE relation_feature_window (
                    as_of_date TEXT, window_days INTEGER, period TEXT,
                    filter_type TEXT, filter_key TEXT, relation_id TEXT,
                    relation_label TEXT, {METRIC_DEFINITIONS},
                    delay_p50 REAL, delay_p75 REAL, delay_p90 REAL,
                    delay_p95 REAL, delay_mean REAL, recovery_sample INTEGER,
                    recovered_services INTEGER, delay_change_mean REAL,
                    delay_change_p50 REAL, cross_midnight_services INTEGER,
                    duration_sample INTEGER, duration_mean REAL, duration_max REAL
                );
                CREATE TABLE cross_midnight_window (
                    as_of_date TEXT, window_days INTEGER, period TEXT,
                    filter_type TEXT, filter_key TEXT, observed_services INTEGER,
                    cross_midnight_services INTEGER, duration_sample INTEGER,
                    duration_mean REAL, duration_p90 REAL
                );
                CREATE TABLE long_journey_service (
                    service_date TEXT, train_key TEXT, train_number TEXT,
                    operator TEXT, category TEXT, origin TEXT, destination TEXT,
                    origin_code TEXT, destination_code TEXT, relation_key TEXT,
                    scheduled_departure TEXT, scheduled_arrival TEXT,
                    scheduled_duration_minutes REAL, cross_midnight INTEGER,
                    delay_change REAL, final_departure_delay REAL,
                    final_arrival_delay REAL, observation_count INTEGER
                );
                CREATE TABLE outlier_stop (
                    service_date TEXT, train_key TEXT, stop_number INTEGER,
                    station_code TEXT, station_name TEXT, stop_type TEXT,
                    platform TEXT, arrival_expected TEXT, arrival_actual TEXT,
                    arrival_delay INTEGER, departure_expected TEXT,
                    departure_actual TEXT, departure_delay INTEGER,
                    stop_cancelled INTEGER, delay_change REAL
                );
                """
            )
            metadata = {
                "schemaVersion": "2",
                "metricDefinitionVersion": "2026-08-11-v2",
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
            connection.execute(
                f"INSERT INTO operator_category_window VALUES (?,?,?,?,?,?,?,{metric_placeholders})",
                ["2026-08-28", 7, "current", "2026-08-22", "2026-08-28", "10", "ICN", *metric_values(service_days=7)],
            )
            for filter_type, filter_key in (("all", "all"), ("category", "ICN")):
                connection.execute(
                    f"INSERT INTO rhythm_window VALUES (?,?,?,?,?,?,?,{metric_placeholders})",
                    ["2026-08-28", 7, "current", filter_type, filter_key, 4, 20, *metric_values(service_days=7)],
                )
            station_values = (
                "2026-08-28", 7, "current", "all", "all", "S001",
                "MILANO CENTRALE", 600, 200, 200, 200, 540, 20, 500,
                400, 450, 10, 3.0, 18.0,
            )
            connection.execute(
                "INSERT INTO station_window VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                station_values,
            )
            connection.execute(
                "INSERT INTO station_window VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("2026-08-28", 7, "previous", "all", "all", "S001", "MILANO CENTRALE", 550, 180, 190, 180, 500, 18, 460, 365, 420, 9, 3.5, 20.0),
            )
            connection.execute(
                "INSERT INTO station_hour_window VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("2026-08-28", 7, "S001", "MILANO CENTRALE", 4, 20, 80, 25, 30, 25),
            )
            relation_metric_values = metric_values(service_days=7)
            connection.execute(
                f"INSERT INTO relation_feature_window VALUES (?,?,?,?,?,?,?,{metric_placeholders},?,?,?,?,?,?,?,?)",
                ["2026-08-28", 7, "current", "all", "all", "MILANO CENTRALE -> LECCE", "MILANO CENTRALE -> LECCE", *relation_metric_values, 700, 320, -4.5, -3.0, 120, 800, 430.0, 720.0],
            )
            connection.execute(
                f"INSERT INTO relation_feature_window VALUES (?,?,?,?,?,?,?,{metric_placeholders},?,?,?,?,?,?,?,?)",
                ["2026-08-28", 7, "previous", "all", "all", "MILANO CENTRALE -> LECCE", "MILANO CENTRALE -> LECCE", *metric_values(service_days=7), 650, 280, -2.0, -1.0, 100, 750, 420.0, 700.0],
            )
            connection.execute(
                "INSERT INTO cross_midnight_window VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("2026-08-28", 7, "current", "all", "all", 1000, 120, 900, 240.0, 600.0),
            )
            connection.execute(
                "INSERT INTO cross_midnight_window VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("2026-08-28", 7, "previous", "all", "all", 900, 90, 820, 230.0, 580.0),
            )
            connection.execute(
                "INSERT INTO long_journey_service VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("2026-08-28", "100-S001-1", "100", "10", "ICN", "MILANO CENTRALE", "LECCE", "S001", "S030", "MILANO CENTRALE -> LECCE", "2026-08-28T20:00:00+02:00", "2026-08-29T08:00:00+02:00", 720.0, 1, 60.0, 120.0, 180.0, 12),
            )
            connection.execute(
                "INSERT INTO outlier_stop VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("2026-08-28", "100-S001-1", 0, "S001", "MILANO CENTRALE", "origine", "1", None, None, None, "2026-08-28T20:00:00+02:00", "2026-08-28T22:00:00+02:00", 120, 0, None),
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

    def test_explore_returns_composition_rhythm_network_and_service_features(self):
        payload = self.model.explore(as_of=None, window=7)
        self.assertTrue(payload["available"])
        self.assertEqual(payload["composition"]["activeOperators"], 1)
        self.assertEqual(payload["composition"]["matrix"][0]["category"], "ICN")
        self.assertEqual(payload["rhythm"][0]["hour"], 20)
        self.assertEqual(payload["categoryRhythm"][0]["category"], "ICN")
        self.assertEqual(payload["network"]["stations"][0]["roles"]["transits"], 200)
        self.assertEqual(payload["network"]["stationRhythm"]["stationCode"], "S001")
        self.assertEqual(payload["services"]["crossMidnight"]["percent"], 12.0)
        self.assertEqual(payload["services"]["recoveryRelations"][0]["recovery"]["meanMinutes"], -4.5)
        self.assertEqual(payload["services"]["spotlight"]["stops"][0]["station_code"], "S001")

    def test_wilson_interval_is_bounded(self):
        interval = wilson_interval(1, 1)
        self.assertGreaterEqual(interval["low"], 0)
        self.assertLessEqual(interval["high"], 100)
        self.assertIsNone(wilson_interval(0, 0))


if __name__ == "__main__":
    unittest.main()
