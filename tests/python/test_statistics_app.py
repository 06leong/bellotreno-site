import gc
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
STATISTICS_DIR = ROOT / "rfi-proxy" / "statistics"
TEMP_DIR = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
MISSING = object()


class StubLogger:
    def info(self, *args, **kwargs):
        pass

    def warning(self, *args, **kwargs):
        pass

    def exception(self, *args, **kwargs):
        pass


class StubFlask:
    def __init__(self, *args, **kwargs):
        self.logger = StubLogger()

    def before_request(self, fn):
        return fn

    def get(self, *args, **kwargs):
        return lambda fn: fn

    def post(self, *args, **kwargs):
        return lambda fn: fn

    def run(self, *args, **kwargs):
        pass


class StubResponse:
    def __init__(self, *args, **kwargs):
        pass


def load_statistics_app(env_overrides=None):
    env_overrides = env_overrides or {}
    module_names = (
        "flask",
        "requests",
        "zoneinfo",
        "statistics_core",
        "statistics_core.normalizers",
        "statistics_storage",
    )
    saved_modules = {name: sys.modules.get(name, MISSING) for name in module_names}

    flask = types.ModuleType("flask")
    flask.Flask = StubFlask
    flask.Response = StubResponse
    flask.jsonify = lambda *args, **kwargs: (
        args[0] if len(args) == 1 and not kwargs else {"args": args, **kwargs}
    )
    flask.request = types.SimpleNamespace(path="/health", args={}, headers={})
    requests = types.ModuleType("requests")
    requests.Session = type("Session", (), {})
    zoneinfo = types.ModuleType("zoneinfo")
    zoneinfo.ZoneInfoNotFoundError = type("ZoneInfoNotFoundError", (Exception,), {})
    zoneinfo.ZoneInfo = lambda key: timezone(timedelta(hours=2), key)

    for name in ("statistics_core", "statistics_core.normalizers", "statistics_storage"):
        sys.modules.pop(name, None)
    sys.modules["flask"] = flask
    sys.modules["requests"] = requests
    sys.modules["zoneinfo"] = zoneinfo

    env_names = {
        "SQLITE_PATH",
        "CACHE_DIR",
        "COLLECTOR_ENABLED",
        *env_overrides,
    }
    saved_env = {name: os.environ.get(name) for name in env_names}
    os.environ["SQLITE_PATH"] = str(Path(TEMP_DIR.name) / "statistics.db")
    os.environ["CACHE_DIR"] = str(Path(TEMP_DIR.name) / "cache")
    os.environ["COLLECTOR_ENABLED"] = "false"
    os.environ.update(env_overrides)
    sys.path.insert(0, str(STATISTICS_DIR))
    try:
        spec = importlib.util.spec_from_file_location(
            "bellotreno_statistics_app_test",
            STATISTICS_DIR / "app.py",
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(STATISTICS_DIR))
        for name, value in saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        for name, value in saved_modules.items():
            if value is MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


APP = load_statistics_app()


def detail_payload(epoch_ms: int, marker: str) -> dict:
    return {
        "numeroTreno": "1954",
        "idOrigine": "S01700",
        "idDestinazione": "S08409",
        "dataPartenzaTreno": epoch_ms,
        "origine": "PALERMO CENTRALE",
        "destinazione": "ROMA TERMINI",
        "ritardo": 1451,
        "marker": marker,
        "fermate": [
            {
                "id": "S01700",
                "stazione": "PALERMO CENTRALE",
                "partenza_teorica": epoch_ms,
                "ritardoPartenza": 1451,
                "marker": marker,
            },
            {
                "id": "S08409",
                "stazione": "ROMA TERMINI",
                "arrivo_teorico": epoch_ms + 12 * 60 * 60 * 1000,
                "ritardoArrivo": 1451,
                "marker": marker,
            },
        ],
    }


def service_row(number: int, *, completed: int = 0) -> dict:
    epoch_ms = 1783890000000 + number
    return {
        "date": "2026-07-13",
        "service_date": "2026-07-12",
        "train_key": f"{number}-S01700-{epoch_ms}",
        "identity_quality": "canonical",
        "train_number": str(number),
        "departure_epoch_ms": str(epoch_ms),
        "category": "ICN",
        "operator": "10",
        "status": "delayed",
        "origin": "PALERMO CENTRALE",
        "destination": "ROMA TERMINI",
        "origin_code": "S01700",
        "destination_code": "S08409",
        "relation_key": "PALERMO CENTRALE -> ROMA TERMINI",
        "departure_delay": 30,
        "arrival_delay": 30,
        "delay": 30,
        "cancelled": 0,
        "rescheduled": 0,
        "not_departed": 0,
        "scheduled_departure": "2026-07-12T20:30:00+02:00",
        "scheduled_arrival": "2026-07-13T08:30:00+02:00",
        "last_seen": "2026-07-13T10:35:00Z",
        "detail_last_seen": "",
        "has_details": 0,
        "completed": completed,
    }


class StatisticsAppIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.original_detail_limit = APP.DETAIL_LIMIT_PER_RUN
        conn = APP.db()
        try:
            for table in (
                "train_raw_payloads",
                "train_stop_events",
                "train_observations",
                "train_services",
                "train_stops",
                "trains",
                "snapshots",
                "collector_runs",
                "station_stats",
                "station_board_stats",
                "relation_stats",
                "station_registry",
            ):
                conn.execute(f"DELETE FROM {table}")
            conn.commit()
        finally:
            conn.close()

    def tearDown(self):
        APP.DETAIL_LIMIT_PER_RUN = self.original_detail_limit

    def test_service_retention_covers_every_dependent_window(self):
        configured = load_statistics_app(
            {
                "V2_OBSERVATION_RETENTION_DAYS": "1",
                "V2_SERVICE_RETENTION_DAYS": "2",
                "RAW_PAYLOAD_RETENTION_DAYS": "9",
                "COLLECTOR_ACTIVE_SERVICE_TTL_DAYS": "7",
            }
        )
        self.assertEqual(configured.V2_SERVICE_RETENTION_DAYS, 9)

    def write_detail(self, payload: dict, collection_date: str, observed_at: str) -> dict:
        row = APP.normalize_train(
            payload,
            observed_at,
            has_details=True,
            fallback_date=collection_date,
            stats_date=collection_date,
        )
        conn = APP.db()
        try:
            APP.upsert_train(conn, row)
            APP.upsert_train_service(
                conn,
                row,
                collection_date=collection_date,
                observed_at=observed_at,
                source="detail",
            )
            stops = APP.replace_train_stops(conn, payload, row)
            APP.replace_train_stop_events(conn, row, stops)
            APP.store_train_raw_payload(conn, row, row["raw_payload"])
            conn.commit()
        finally:
            conn.close()
        return row

    def test_board_deduplication_keeps_the_highest_quality_same_slot_row(self):
        rows = {}
        partial = service_row(1900)
        partial.update(observation_quality=110, origin="PALERMO")
        complete = service_row(1900)
        complete.update(observation_quality=145, origin="PALERMO CENTRALE")
        later_partial = service_row(1900)
        later_partial.update(observation_quality=120, origin="PALERMO C.")

        APP.retain_best_service_observation(rows, partial)
        APP.retain_best_service_observation(rows, complete)
        APP.retain_best_service_observation(rows, later_partial)

        retained = rows[(complete["service_date"], complete["train_key"])]
        self.assertEqual(retained["observation_quality"], 145)
        self.assertEqual(retained["origin"], "PALERMO CENTRALE")

    def test_conflicting_origin_fields_use_one_canonical_identity(self):
        payload = detail_payload(1783890000000, "origin-priority")
        payload["codLocOrig"] = "S01700"
        payload["idOrigine"] = "S99999"
        candidate = APP.board_candidate(payload, "2026-07-12")
        normalized = APP.normalize_train(
            payload,
            "2026-07-12T22:35:00Z",
            has_details=True,
            fallback_date="2026-07-12",
            stats_date="2026-07-12",
        )

        self.assertEqual(candidate["origin_code"], "S01700")
        self.assertEqual(normalized["origin_code"], "S01700")
        self.assertEqual(candidate["train_key"], normalized["train_key"])

    def test_train_detail_route_keeps_d_and_d_plus_one_raw_separate(self):
        epoch_ms = 1783890000000
        first = self.write_detail(
            detail_payload(epoch_ms, "D"),
            "2026-07-12",
            "2026-07-12T22:35:00Z",
        )
        self.write_detail(
            detail_payload(epoch_ms, "D+1"),
            "2026-07-13",
            "2026-07-13T10:35:00Z",
        )

        first_response = APP.train_detail_endpoint("2026-07-12", first["train_key"])
        latest_response = APP.train_detail_endpoint("2026-07-13", first["train_key"])
        self.assertEqual(first_response["train"]["raw"]["marker"], "D")
        self.assertEqual(latest_response["train"]["raw"]["marker"], "D+1")
        self.assertEqual(
            json.loads(first_response["train"]["stops"][0]["raw_json"])["marker"],
            "D",
        )
        self.assertEqual(
            json.loads(latest_response["train"]["stops"][0]["raw_json"])["marker"],
            "D+1",
        )

        board_replay = APP.normalize_train(
            detail_payload(epoch_ms, "board"),
            "2026-07-12T23:05:00Z",
            has_details=False,
            fallback_date="2026-07-12",
            stats_date="2026-07-12",
        )
        conn = APP.db()
        try:
            APP.upsert_train(conn, board_replay)
            conn.commit()
            stored_type = conn.execute(
                "SELECT typeof(raw_json) FROM trains WHERE date=? AND train_key=?",
                ("2026-07-12", first["train_key"]),
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(stored_type, "blob")
        self.assertEqual(
            APP.train_detail_endpoint("2026-07-12", first["train_key"])["train"]["raw"]["marker"],
            "D",
        )

        conn = APP.db()
        try:
            conn.execute(
                "UPDATE trains SET raw_json=NULL WHERE date=? AND train_key=?",
                ("2026-07-12", first["train_key"]),
            )
            conn.commit()
        finally:
            conn.close()
        missing_old = APP.train_detail_endpoint("2026-07-12", first["train_key"])
        self.assertEqual(missing_old["train"]["raw"], {})
        self.assertEqual(missing_old["train"]["stops"][0]["raw_json"], "{}")

    def test_detail_queue_honors_due_time_completion_and_backlog_reservation(self):
        now_iso = "2026-07-13T12:00:00Z"
        current_rows = [service_row(number) for number in (2001, 2002, 2003)]
        backlog_rows = [service_row(number) for number in (3001, 3002)]
        future = service_row(4001)
        completed = service_row(5001, completed=1)
        conn = APP.db()
        try:
            for row in (*current_rows, *backlog_rows, future, completed):
                APP.upsert_train_service(
                    conn,
                    row,
                    collection_date="2026-07-13",
                    observed_at=row["last_seen"],
                    source="board",
                )
            conn.execute(
                "UPDATE train_services SET detail_next_retry_at=? WHERE train_key=?",
                (now_iso, backlog_rows[0]["train_key"]),
            )
            conn.execute(
                "UPDATE train_services SET detail_next_retry_at=? WHERE train_key=?",
                ("2026-07-13T13:00:00Z", future["train_key"]),
            )
            conn.commit()
        finally:
            conn.close()

        board_candidates = {
            (row["service_date"], row["train_key"]): {
                "service_date": row["service_date"],
                "train_key": row["train_key"],
                "number": row["train_number"],
                "origin_code": row["origin_code"],
                "departure_epoch_ms": row["departure_epoch_ms"],
            }
            for row in current_rows
        }
        APP.DETAIL_LIMIT_PER_RUN = 2
        queue, due_count = APP.detail_queue(
            "2026-07-13",
            board_candidates,
            as_of=now_iso,
        )
        current_keys = {row["train_key"] for row in current_rows}
        backlog_keys = {row["train_key"] for row in backlog_rows}
        selected_keys = {candidate["train_key"] for candidate in queue}
        self.assertEqual(due_count, 5)
        self.assertEqual(len(queue), 2)
        self.assertEqual(len(selected_keys & current_keys), 1)
        self.assertEqual(len(selected_keys & backlog_keys), 1)
        self.assertNotIn(future["train_key"], selected_keys)
        self.assertNotIn(completed["train_key"], selected_keys)
        self.assertEqual(due_count - len(queue), 3)

        APP.DETAIL_LIMIT_PER_RUN = 0
        unlimited, unlimited_due = APP.detail_queue(
            "2026-07-13",
            board_candidates,
            as_of=now_iso,
        )
        self.assertEqual(unlimited_due, 5)
        self.assertEqual(len(unlimited), 5)

    def test_legacy_d_plus_two_service_self_bootstraps_into_v2(self):
        departure = datetime(2026, 7, 11, 20, 30, tzinfo=APP.APP_TZ)
        payload = detail_payload(int(departure.timestamp() * 1000), "legacy-active")
        legacy = APP.normalize_train(
            payload,
            "2026-07-11T22:35:00Z",
            has_details=True,
            fallback_date="2026-07-11",
            stats_date="2026-07-11",
        )
        conn = APP.db()
        try:
            APP.upsert_train(conn, legacy)
            conn.commit()
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_services").fetchone()[0], 0)
        finally:
            conn.close()

        active_keys = APP.active_service_keys("2026-07-13")
        self.assertIn(legacy["train_key"], active_keys)
        self.assertTrue(
            APP.is_collectable_service_date(payload, "2026-07-13", active_keys)
        )
        board = APP.normalize_train(
            payload,
            "2026-07-13T10:35:00Z",
            has_details=False,
            fallback_date="2026-07-13",
            stats_date="2026-07-13",
        )
        candidate = APP.board_candidate(payload, "2026-07-13")
        conn = APP.db()
        try:
            APP.upsert_train(conn, board)
            APP.upsert_train_service(
                conn,
                board,
                collection_date="2026-07-13",
                observed_at="2026-07-13T10:35:00Z",
                source="board",
            )
            conn.commit()
        finally:
            conn.close()

        queue, due_count = APP.detail_queue(
            "2026-07-13",
            {(candidate["service_date"], candidate["train_key"]): candidate},
            as_of="2026-07-13T11:00:00Z",
        )
        self.assertEqual(due_count, 1)
        self.assertEqual(queue[0]["train_key"], legacy["train_key"])


def tearDownModule():
    gc.collect()
    TEMP_DIR.cleanup()
