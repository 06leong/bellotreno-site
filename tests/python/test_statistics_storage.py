import json
import re
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing
from datetime import datetime, timedelta, timezone
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_SCRIPT = ROOT / "rfi-proxy" / "statistics" / "migrate_statistics_v2.py"
sys.path.insert(0, str(ROOT / "rfi-proxy" / "statistics"))

from migrate_statistics_v2 import profile  # noqa: E402
from statistics_storage import (  # noqa: E402
    backfill_legacy_batch,
    cleanup_v2_rows,
    decode_raw_json,
    detail_retry_due,
    encode_raw_json,
    initialize_v2_schema,
    load_active_service_keys,
    migration_state,
    record_detail_attempt,
    replace_train_stop_events,
    resolve_train_raw_payload,
    save_migration_state,
    store_train_raw_payload,
    upsert_train_service,
)


OPEN_TEST_CONNECTIONS: list[sqlite3.Connection] = []


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    initialize_v2_schema(conn)
    OPEN_TEST_CONNECTIONS.append(conn)
    return conn


def tearDownModule() -> None:
    for conn in OPEN_TEST_CONNECTIONS:
        conn.close()
    OPEN_TEST_CONNECTIONS.clear()


def service_row(**overrides):
    row = {
        "date": "2026-07-12",
        "service_date": "2026-07-12",
        "train_key": "1954-S01700-1783890000000",
        "identity_quality": "canonical",
        "train_number": "1954",
        "departure_epoch_ms": "1783890000000",
        "category": "ICN",
        "operator": "10",
        "status": "delayed",
        "origin": "PALERMO CENTRALE",
        "destination": "ROMA TERMINI",
        "origin_code": "S01700",
        "destination_code": "S08409",
        "relation_key": "PALERMO CENTRALE -> ROMA TERMINI",
        "departure_delay": 120,
        "arrival_delay": 120,
        "delay": 120,
        "cancelled": 0,
        "rescheduled": 0,
        "not_departed": 0,
        "scheduled_departure": "2026-07-12T20:30:00+02:00",
        "scheduled_arrival": "2026-07-13T08:30:00+02:00",
        "last_seen": "2026-07-12T22:35:00Z",
        "detail_last_seen": "2026-07-12T22:35:00Z",
        "has_details": 1,
        "completed": 0,
    }
    row.update(overrides)
    return row


def create_legacy_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE trains (
            date TEXT NOT NULL,
            service_date TEXT,
            train_key TEXT NOT NULL,
            train_number TEXT,
            departure_epoch_ms TEXT,
            category TEXT,
            operator TEXT,
            status TEXT,
            origin TEXT,
            destination TEXT,
            origin_code TEXT,
            destination_code TEXT,
            relation_key TEXT,
            departure_delay INTEGER,
            arrival_delay INTEGER,
            delay INTEGER,
            cancelled INTEGER,
            rescheduled INTEGER,
            not_departed INTEGER,
            scheduled_departure TEXT,
            scheduled_arrival TEXT,
            last_seen TEXT,
            detail_last_seen TEXT,
            has_details INTEGER,
            completed INTEGER,
            raw_json BLOB,
            PRIMARY KEY (date, train_key)
        );
        CREATE TABLE train_stops (
            date TEXT NOT NULL,
            train_key TEXT NOT NULL,
            stop_number INTEGER NOT NULL,
            train_number TEXT,
            category TEXT,
            station_code TEXT,
            station_name TEXT,
            stop_type TEXT,
            platform TEXT,
            arrival_expected TEXT,
            arrival_actual TEXT,
            arrival_delay INTEGER,
            departure_expected TEXT,
            departure_actual TEXT,
            departure_delay INTEGER,
            cancelled INTEGER,
            raw_json BLOB,
            PRIMARY KEY (date, train_key, stop_number)
        );
        """
    )


def insert_legacy_train(conn: sqlite3.Connection, row: dict) -> None:
    columns = [column for column in row if column != "identity_quality"]
    placeholders = ",".join("?" for _ in columns)
    conn.execute(
        f"INSERT INTO trains ({','.join(columns)}) VALUES ({placeholders})",
        [row[column] for column in columns],
    )


class StatisticsStorageTest(unittest.TestCase):
    def test_raw_json_codec_supports_compressed_and_legacy_text(self):
        payload = {"numeroTreno": 1954, "fermate": [{"stazione": "Milano Centrale"}]}

        encoded = encode_raw_json(payload)

        self.assertLess(len(encoded), len(json.dumps(payload).encode("utf-8")) + 10)
        self.assertEqual(decode_raw_json(encoded), payload)
        self.assertEqual(decode_raw_json(json.dumps(payload)), payload)
        self.assertEqual(decode_raw_json(None), {})

    def test_raw_payload_resolution_preserves_collection_date_semantics(self):
        conn = connection()
        latest = service_row(
            date="2026-07-13",
            last_seen="2026-07-13T10:35:00Z",
            detail_last_seen="2026-07-13T10:35:00Z",
        )
        upsert_train_service(
            conn,
            latest,
            collection_date="2026-07-13",
            observed_at=latest["last_seen"],
            source="detail",
        )
        old_payload = encode_raw_json({"collectionDate": "2026-07-12"})
        latest_payload = encode_raw_json({"collectionDate": "2026-07-13"})
        store_train_raw_payload(conn, latest, latest_payload)

        resolved_old = resolve_train_raw_payload(
            conn,
            collection_date="2026-07-12",
            service_date=latest["service_date"],
            train_key=latest["train_key"],
            legacy_payload=old_payload,
        )
        missing_old = resolve_train_raw_payload(
            conn,
            collection_date="2026-07-12",
            service_date=latest["service_date"],
            train_key=latest["train_key"],
        )
        resolved_latest = resolve_train_raw_payload(
            conn,
            collection_date="2026-07-13",
            service_date=latest["service_date"],
            train_key=latest["train_key"],
        )

        self.assertEqual(decode_raw_json(resolved_old), {"collectionDate": "2026-07-12"})
        self.assertIsNone(missing_old)
        self.assertEqual(
            decode_raw_json(resolved_latest),
            {"collectionDate": "2026-07-13"},
        )

    def test_active_service_keys_merge_legacy_and_v2_completion_state(self):
        conn = connection()
        create_legacy_tables(conn)
        active = service_row(
            date="2026-07-13",
            service_date="2026-07-11",
            train_key="active-legacy",
            completed=0,
        )
        null_service_date = service_row(
            date="2026-07-12",
            service_date=None,
            train_key="active-null-service-date",
            completed=0,
        )
        expired = service_row(
            date="2026-07-05",
            service_date="2026-07-05",
            train_key="expired-legacy",
            completed=0,
        )
        completed_first = service_row(
            date="2026-07-12",
            service_date="2026-07-10",
            train_key="completed-across-days",
            completed=0,
        )
        completed_latest = service_row(
            date="2026-07-13",
            service_date="2026-07-10",
            train_key="completed-across-days",
            completed=1,
        )
        legacy_overridden_by_v2 = service_row(
            date="2026-07-13",
            service_date="2026-07-09",
            train_key="v2-completed",
            completed=0,
        )
        for row in (
            active,
            null_service_date,
            expired,
            completed_first,
            completed_latest,
            legacy_overridden_by_v2,
        ):
            insert_legacy_train(conn, row)
        v2_completed = service_row(
            service_date="2026-07-09",
            train_key="v2-completed",
            completed=1,
        )
        upsert_train_service(
            conn,
            v2_completed,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )

        keys = load_active_service_keys(
            conn,
            earliest_service_date="2026-07-06",
            collection_date="2026-07-13",
        )

        self.assertIn("active-legacy", keys)
        self.assertIn("active-null-service-date", keys)
        self.assertNotIn("expired-legacy", keys)
        self.assertNotIn("completed-across-days", keys)
        self.assertNotIn("v2-completed", keys)

    def test_detail_retry_backoff_caps_resets_and_survives_upserts(self):
        conn = connection()
        row = service_row(completed=0)
        upsert_train_service(
            conn,
            row,
            collection_date="2026-07-12",
            observed_at=row["last_seen"],
            source="detail",
        )
        attempted_at = datetime(2026, 7, 13, 10, 0, tzinfo=timezone.utc)
        for expected_minutes in (60, 120, 240, 480, 720, 720):
            result = record_detail_attempt(
                conn,
                service_date=row["service_date"],
                train_key=row["train_key"],
                attempted_at=attempted_at.isoformat().replace("+00:00", "Z"),
                succeeded=False,
                error="upstream timeout",
                retry_base_minutes=60,
                retry_max_minutes=720,
                success_refresh_minutes=120,
            )
            expected_retry = attempted_at + timedelta(minutes=expected_minutes)
            self.assertEqual(
                result["next_retry_at"],
                expected_retry.isoformat().replace("+00:00", "Z"),
            )
            self.assertFalse(
                detail_retry_due(
                    result["next_retry_at"],
                    (expected_retry - timedelta(seconds=1)).isoformat(),
                )
            )
            self.assertTrue(detail_retry_due(result["next_retry_at"], expected_retry.isoformat()))
            attempted_at = expected_retry

        before_replay = conn.execute(
            "SELECT detail_failure_count, detail_next_retry_at FROM train_services"
        ).fetchone()
        upsert_train_service(
            conn,
            service_row(
                has_details=0,
                detail_last_seen="",
                completed=0,
                last_seen="2026-07-13T11:00:00Z",
            ),
            collection_date="2026-07-13",
            observed_at="2026-07-13T11:00:00Z",
            source="board",
        )
        after_replay = conn.execute(
            "SELECT detail_failure_count, detail_next_retry_at FROM train_services"
        ).fetchone()
        self.assertEqual(tuple(after_replay), tuple(before_replay))

        success = record_detail_attempt(
            conn,
            service_date=row["service_date"],
            train_key=row["train_key"],
            attempted_at=attempted_at.isoformat().replace("+00:00", "Z"),
            succeeded=True,
            completed=False,
            success_refresh_minutes=120,
        )
        self.assertEqual(success["failure_count"], 0)
        self.assertEqual(
            success["next_retry_at"],
            (attempted_at + timedelta(minutes=120)).isoformat().replace("+00:00", "Z"),
        )
        completed = record_detail_attempt(
            conn,
            service_date=row["service_date"],
            train_key=row["train_key"],
            attempted_at=success["next_retry_at"],
            succeeded=True,
            completed=True,
        )
        state = conn.execute(
            "SELECT detail_failure_count, detail_next_retry_at, detail_last_error "
            "FROM train_services"
        ).fetchone()
        self.assertIsNone(completed["next_retry_at"])
        self.assertEqual(state["detail_failure_count"], 0)
        self.assertIsNone(state["detail_next_retry_at"])
        self.assertIsNone(state["detail_last_error"])

    def test_existing_v2_schema_adds_retry_columns_without_rebuilding(self):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(
            """
            CREATE TABLE train_services (
                service_date TEXT NOT NULL,
                train_key TEXT NOT NULL,
                identity_quality TEXT NOT NULL DEFAULT 'canonical',
                train_number TEXT,
                departure_epoch_ms TEXT,
                category TEXT,
                operator TEXT,
                status TEXT,
                origin TEXT,
                destination TEXT,
                origin_code TEXT,
                destination_code TEXT,
                relation_key TEXT,
                departure_delay INTEGER DEFAULT 0,
                arrival_delay INTEGER DEFAULT 0,
                delay INTEGER DEFAULT 0,
                cancelled INTEGER DEFAULT 0,
                rescheduled INTEGER DEFAULT 0,
                not_departed INTEGER DEFAULT 0,
                scheduled_departure TEXT,
                scheduled_arrival TEXT,
                first_seen TEXT,
                last_seen TEXT,
                latest_collection_date TEXT,
                latest_state_quality INTEGER NOT NULL DEFAULT 0,
                detail_last_seen TEXT,
                detail_collection_date TEXT,
                detail_quality INTEGER NOT NULL DEFAULT 0,
                has_details INTEGER DEFAULT 0,
                completed INTEGER DEFAULT 0,
                PRIMARY KEY (service_date, train_key)
            ) WITHOUT ROWID;
            INSERT INTO train_services (
                service_date, train_key, last_seen, latest_collection_date
            ) VALUES (
                '2026-07-12', 'preserved-service',
                '2026-07-13T10:35:00Z', '2026-07-13'
            );
            """
        )

        initialize_v2_schema(conn)
        initialize_v2_schema(conn)

        writable = service_row(
            train_key="writable-after-upgrade",
            train_number="1955",
            departure_epoch_ms="1783890000001",
        )
        upsert_train_service(
            conn,
            writable,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        self.assertTrue(
            replace_train_stop_events(
                conn,
                writable,
                [{"stop_number": 0, "station_code": "S01700"}],
            )
        )
        store_train_raw_payload(conn, writable, encode_raw_json({"upgraded": True}))

        columns = {
            column["name"]
            for column in conn.execute("PRAGMA table_info(train_services)").fetchall()
        }
        preserved = conn.execute(
            "SELECT train_key, detail_failure_count FROM train_services "
            "WHERE train_key='preserved-service'"
        ).fetchone()
        self.assertTrue(
            {
                "detail_attempted_at",
                "detail_failure_count",
                "detail_next_retry_at",
                "detail_last_error",
            }.issubset(columns)
        )
        self.assertEqual(preserved["train_key"], "preserved-service")
        self.assertEqual(preserved["detail_failure_count"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_observations").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_stop_events").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_raw_payloads").fetchone()[0], 1)
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_incompatible_v2_schema_fails_closed_without_dropping_rows(self):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE train_services (
                service_date TEXT NOT NULL,
                train_key TEXT NOT NULL,
                identity_quality TEXT NOT NULL DEFAULT 'canonical',
                delay INTEGER DEFAULT 0,
                last_seen TEXT,
                latest_collection_date TEXT,
                latest_state_quality INTEGER NOT NULL DEFAULT 0,
                detail_last_seen TEXT,
                detail_collection_date TEXT,
                detail_quality INTEGER NOT NULL DEFAULT 0,
                has_details INTEGER DEFAULT 0,
                completed INTEGER DEFAULT 0,
                PRIMARY KEY (service_date, train_key)
            ) WITHOUT ROWID;
            INSERT INTO train_services (
                service_date, train_key, last_seen, latest_collection_date
            ) VALUES (
                '2026-07-12', 'must-survive-failure',
                '2026-07-13T10:35:00Z', '2026-07-13'
            );
            """
        )

        with self.assertRaisesRegex(RuntimeError, "missing columns"):
            initialize_v2_schema(conn)

        preserved = conn.execute(
            "SELECT train_key FROM train_services WHERE train_key='must-survive-failure'"
        ).fetchone()
        self.assertEqual(preserved["train_key"], "must-survive-failure")

    def test_separate_single_column_foreign_keys_fail_closed(self):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        initialize_v2_schema(conn)
        child_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='train_observations'"
        ).fetchone()[0]
        malformed_sql = re.sub(
            r"FOREIGN KEY\s*\(service_date,\s*train_key\)\s*"
            r"REFERENCES\s+train_services\s*\(service_date,\s*train_key\)\s*"
            r"ON DELETE CASCADE",
            "FOREIGN KEY (service_date) REFERENCES train_services(service_date) "
            "ON DELETE CASCADE, "
            "FOREIGN KEY (train_key) REFERENCES train_services(train_key) "
            "ON DELETE CASCADE",
            child_sql,
            flags=re.IGNORECASE,
        )
        self.assertNotEqual(malformed_sql, child_sql)
        conn.execute("DROP TABLE train_observations")
        conn.execute(malformed_sql)

        with self.assertRaisesRegex(RuntimeError, "incompatible service foreign key"):
            initialize_v2_schema(conn)

    def test_cross_midnight_observation_updates_one_service_without_capping_delay(self):
        conn = connection()
        first = service_row()
        upsert_train_service(
            conn,
            first,
            collection_date="2026-07-12",
            observed_at="2026-07-12T22:35:00Z",
            source="detail",
        )
        latest = service_row(
            date="2026-07-13",
            status="delayed",
            departure_delay=1320,
            arrival_delay=1451,
            delay=1451,
            last_seen="2026-07-13T10:35:00Z",
            detail_last_seen="2026-07-13T10:35:00Z",
            completed=1,
        )
        upsert_train_service(
            conn,
            latest,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        observations = conn.execute(
            "SELECT * FROM train_observations ORDER BY observed_at"
        ).fetchall()

        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_services").fetchone()[0], 1)
        self.assertEqual(len(observations), 2)
        self.assertEqual(service["service_date"], "2026-07-12")
        self.assertEqual(service["latest_collection_date"], "2026-07-13")
        self.assertEqual(service["delay"], 1451)
        self.assertEqual(service["completed"], 1)
        self.assertEqual(
            json.loads(observations[-1]["quality_flags"]),
            ["extreme_delay_12h", "extreme_delay_24h"],
        )

    def test_late_arriving_older_observation_does_not_replace_latest_state(self):
        conn = connection()
        latest = service_row(delay=1451, arrival_delay=1451, completed=1)
        upsert_train_service(
            conn,
            latest,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        older = service_row(delay=30, arrival_delay=30, completed=0)
        upsert_train_service(
            conn,
            older,
            collection_date="2026-07-12",
            observed_at="2026-07-12T22:35:00Z",
            source="detail",
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        self.assertEqual(service["delay"], 1451)
        self.assertEqual(service["completed"], 1)
        self.assertEqual(service["latest_collection_date"], "2026-07-13")
        self.assertEqual(service["first_seen"], "2026-07-12T22:35:00Z")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_observations").fetchone()[0], 2)

    def test_same_slot_retry_is_idempotent_and_detail_wins(self):
        conn = connection()
        board = service_row(has_details=0, detail_last_seen="", delay=15)
        detail = service_row(has_details=1, delay=45)

        upsert_train_service(
            conn,
            board,
            collection_date="2026-07-12",
            observed_at="2026-07-12T22:35:00Z",
            source="board",
        )
        upsert_train_service(
            conn,
            detail,
            collection_date="2026-07-12",
            observed_at="2026-07-12T22:35:00Z",
            source="detail",
        )

        observation = conn.execute("SELECT * FROM train_observations").fetchone()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_observations").fetchone()[0], 1)
        self.assertEqual(observation["source"], "detail")
        self.assertEqual(observation["has_details"], 1)
        self.assertEqual(observation["delay"], 45)

    def test_same_slot_board_replay_does_not_downgrade_canonical_detail(self):
        conn = connection()
        detail = service_row(
            status="completed",
            delay=1451,
            arrival_delay=1451,
            completed=1,
        )
        board = service_row(
            has_details=0,
            detail_last_seen="",
            status="delayed",
            delay=15,
            arrival_delay=15,
            completed=0,
            origin="PALERMO",
        )

        upsert_train_service(
            conn,
            detail,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        upsert_train_service(
            conn,
            board,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="board",
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        observation = conn.execute("SELECT * FROM train_observations").fetchone()
        self.assertEqual(service["status"], "completed")
        self.assertEqual(service["delay"], 1451)
        self.assertEqual(service["arrival_delay"], 1451)
        self.assertEqual(service["origin"], "PALERMO CENTRALE")
        self.assertEqual(service["has_details"], 1)
        self.assertEqual(service["completed"], 1)
        self.assertEqual(observation["source"], "detail")
        self.assertEqual(observation["delay"], 1451)
        self.assertEqual(observation["has_details"], 1)

    def test_same_slot_partial_detail_cannot_replace_more_complete_evidence(self):
        conn = connection()
        complete = service_row(
            observation_quality=1600,
            detail_stop_count=12,
            delay=1451,
            arrival_delay=1451,
            evidence_station_code="S08409",
            evidence_expected_at="2026-07-13T08:30:00+02:00",
            evidence_actual_at="2026-07-14T08:41:00+02:00",
            evidence_delay=1451,
        )
        partial = service_row(
            observation_quality=1100,
            detail_stop_count=1,
            origin="PALERMO",
            delay=10,
            arrival_delay=10,
            evidence_station_code="",
            evidence_expected_at="",
            evidence_actual_at="",
            evidence_delay=10,
        )
        upsert_train_service(
            conn,
            complete,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        complete_stops = [
            {"stop_number": 0, "station_code": "S01700", "station_name": "PALERMO CENTRALE"},
            {
                "stop_number": 1,
                "station_code": "S08409",
                "station_name": "ROMA TERMINI",
                "arrival_actual": "2026-07-14T08:41:00+02:00",
            },
        ]
        self.assertTrue(replace_train_stop_events(conn, complete, complete_stops))
        store_train_raw_payload(conn, complete, encode_raw_json({"version": "complete"}))

        upsert_train_service(
            conn,
            partial,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        self.assertFalse(
            replace_train_stop_events(
                conn,
                partial,
                [{"stop_number": 0, "station_code": "S01700"}],
            )
        )
        store_train_raw_payload(conn, partial, encode_raw_json({"version": "partial"}))

        service = conn.execute("SELECT * FROM train_services").fetchone()
        observation = conn.execute("SELECT * FROM train_observations").fetchone()
        raw = conn.execute("SELECT payload FROM train_raw_payloads").fetchone()[0]
        self.assertEqual(service["origin"], "PALERMO CENTRALE")
        self.assertEqual(service["delay"], 1451)
        self.assertEqual(service["latest_state_quality"], 1600)
        self.assertEqual(observation["evidence_delay"], 1451)
        self.assertEqual(observation["quality_score"], 1600)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_stop_events").fetchone()[0], 2)
        self.assertEqual(decode_raw_json(raw), {"version": "complete"})

    def test_older_high_quality_detail_does_not_replace_newer_static_fields(self):
        conn = connection()
        newer = service_row(
            origin="PALERMO CENTRALE NEW",
            observation_quality=1300,
            last_seen="2026-07-13T10:35:00Z",
            detail_last_seen="2026-07-13T10:35:00Z",
        )
        older = service_row(
            origin="PALERMO CENTRALE OLD",
            observation_quality=1900,
            last_seen="2026-07-12T22:35:00Z",
            detail_last_seen="2026-07-12T22:35:00Z",
        )
        upsert_train_service(
            conn,
            newer,
            collection_date="2026-07-13",
            observed_at=newer["last_seen"],
            source="detail",
        )
        upsert_train_service(
            conn,
            older,
            collection_date="2026-07-12",
            observed_at=older["last_seen"],
            source="detail",
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        self.assertEqual(service["origin"], "PALERMO CENTRALE NEW")
        self.assertEqual(service["detail_last_seen"], "2026-07-13T10:35:00Z")

    def test_later_board_updates_status_without_erasing_detail_fields(self):
        conn = connection()
        detail = service_row()
        upsert_train_service(
            conn,
            detail,
            collection_date="2026-07-12",
            observed_at="2026-07-12T22:35:00Z",
            source="detail",
        )
        board = service_row(
            has_details=0,
            detail_last_seen="",
            origin="PALERMO",
            scheduled_departure="20:30",
            delay=75,
        )
        upsert_train_service(
            conn,
            board,
            collection_date="2026-07-13",
            observed_at="2026-07-13T00:05:00Z",
            source="board",
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        self.assertEqual(service["origin"], "PALERMO CENTRALE")
        self.assertEqual(service["scheduled_departure"], "2026-07-12T20:30:00+02:00")
        self.assertEqual(service["delay"], 75)
        self.assertEqual(service["latest_collection_date"], "2026-07-13")

    def test_stop_event_keeps_next_day_and_following_day_dates(self):
        conn = connection()
        row = service_row()
        upsert_train_service(
            conn,
            row,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        stops = [
            {
                "stop_number": 4,
                "train_number": "1954",
                "category": "ICN",
                "station_code": "S08409",
                "station_name": "ROMA TERMINI",
                "stop_type": "F",
                "platform": "8",
                "arrival_expected": "2026-07-13T01:00:00+02:00",
                "arrival_actual": "2026-07-14T01:11:00+02:00",
                "arrival_delay": 1451,
                "departure_expected": None,
                "departure_actual": None,
                "departure_delay": 0,
                "cancelled": 0,
            }
        ]

        replace_train_stop_events(conn, row, stops)

        stop = conn.execute("SELECT * FROM train_stop_events").fetchone()
        self.assertEqual(stop["service_date"], "2026-07-12")
        self.assertEqual(stop["arrival_expected_date"], "2026-07-13")
        self.assertEqual(stop["arrival_actual_date"], "2026-07-14")
        self.assertEqual(stop["arrival_delay"], 1451)
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_older_or_empty_detail_does_not_replace_or_clear_stop_events(self):
        conn = connection()
        newest = service_row(
            last_seen="2026-07-13T10:35:00Z",
            detail_last_seen="2026-07-13T10:35:00Z",
        )
        upsert_train_service(
            conn,
            newest,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )
        newest_stops = [
            {
                "stop_number": 1,
                "train_number": "1954",
                "category": "ICN",
                "station_code": "S08409",
                "station_name": "ROMA TERMINI",
                "arrival_expected": "2026-07-13T08:30:00+02:00",
                "arrival_actual": "2026-07-14T08:41:00+02:00",
                "arrival_delay": 1451,
            }
        ]
        self.assertTrue(replace_train_stop_events(conn, newest, newest_stops))

        older = service_row(
            last_seen="2026-07-12T22:35:00Z",
            detail_last_seen="2026-07-12T22:35:00Z",
        )
        older_stops = [
            {
                "stop_number": 1,
                "station_code": "S01700",
                "station_name": "PALERMO CENTRALE",
                "arrival_delay": 5,
            }
        ]
        self.assertFalse(replace_train_stop_events(conn, older, older_stops))
        self.assertFalse(
            replace_train_stop_events(
                conn,
                service_row(
                    last_seen="2026-07-13T11:00:00Z",
                    detail_last_seen="2026-07-13T11:00:00Z",
                ),
                [],
            )
        )

        stop = conn.execute("SELECT * FROM train_stop_events").fetchone()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_stop_events").fetchone()[0], 1)
        self.assertEqual(stop["station_code"], "S08409")
        self.assertEqual(stop["arrival_delay"], 1451)
        self.assertEqual(stop["detail_observed_at"], "2026-07-13T10:35:00Z")

    def test_retention_uses_observation_and_raw_timestamps_before_deleting_service(self):
        conn = connection()
        row = service_row(
            service_date="2026-06-01",
            date="2026-07-12",
            last_seen="2026-07-12T10:00:00Z",
            detail_last_seen="2026-06-30T23:59:00Z",
        )
        upsert_train_service(
            conn,
            row,
            collection_date="2026-07-12",
            observed_at="2026-07-12T10:00:00Z",
            source="detail",
        )
        store_train_raw_payload(conn, row, encode_raw_json({"numeroTreno": 1954}))

        cleanup_v2_rows(
            conn,
            service_cutoff="2026-07-01",
            observation_cutoff="2026-07-01",
            raw_cutoff="2026-07-01T00:00:00Z",
        )

        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_raw_payloads").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_observations").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_services").fetchone()[0], 1)

        cleanup_v2_rows(
            conn,
            service_cutoff="2026-07-01",
            observation_cutoff="2026-07-13",
            raw_cutoff="2026-07-13T00:00:00Z",
        )

        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_observations").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_services").fetchone()[0], 0)

    def test_extreme_delay_observation_keeps_supporting_evidence(self):
        conn = connection()
        row = service_row(
            departure_delay=1320,
            arrival_delay=1451,
            delay=1451,
            evidence_station_code="S08409",
            evidence_expected_at="2026-07-13T08:30:00+02:00",
            evidence_actual_at="2026-07-14T08:41:00+02:00",
            evidence_delay=1451,
        )
        upsert_train_service(
            conn,
            row,
            collection_date="2026-07-13",
            observed_at="2026-07-13T10:35:00Z",
            source="detail",
        )

        observation = conn.execute("SELECT * FROM train_observations").fetchone()
        self.assertEqual(
            json.loads(observation["quality_flags"]),
            ["extreme_delay_12h", "extreme_delay_24h"],
        )
        self.assertEqual(observation["evidence_station_code"], "S08409")
        self.assertEqual(
            observation["evidence_expected_at"], "2026-07-13T08:30:00+02:00"
        )
        self.assertEqual(
            observation["evidence_actual_at"], "2026-07-14T08:41:00+02:00"
        )
        self.assertEqual(observation["evidence_delay"], 1451)

    def test_legacy_backfill_merges_adjacent_collection_dates_idempotently(self):
        conn = connection()
        create_legacy_tables(conn)
        first = service_row()
        latest = service_row(
            date="2026-07-13",
            departure_delay=1320,
            arrival_delay=1451,
            delay=1451,
            last_seen="2026-07-13T10:35:00Z",
            detail_last_seen="2026-07-13T10:35:00Z",
            completed=1,
        )
        insert_legacy_train(conn, first)
        insert_legacy_train(conn, latest)
        conn.execute(
            """
            INSERT INTO train_stops (
                date, train_key, stop_number, train_number, category, station_code,
                station_name, stop_type, platform, arrival_expected, arrival_actual,
                arrival_delay, departure_expected, departure_actual, departure_delay,
                cancelled, raw_json
            ) VALUES (?, ?, 4, '1954', 'ICN', 'S08409', 'ROMA TERMINI', 'F', '8', ?, ?, 1451, NULL, NULL, 0, 0, NULL)
            """,
            (
                "2026-07-13",
                latest["train_key"],
                "2026-07-13T01:00:00+02:00",
                "2026-07-14T01:11:00+02:00",
            ),
        )

        result = backfill_legacy_batch(
            conn,
            last_rowid=0,
            high_water_rowid=2,
            batch_size=100,
            include_stops=True,
        )
        replay = backfill_legacy_batch(
            conn,
            last_rowid=0,
            high_water_rowid=2,
            batch_size=100,
            include_stops=True,
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        stop = conn.execute("SELECT * FROM train_stop_events").fetchone()
        self.assertTrue(result["done"])
        self.assertTrue(replay["done"])
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_services").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_observations").fetchone()[0], 2)
        self.assertEqual(service["delay"], 1451)
        self.assertEqual(service["latest_collection_date"], "2026-07-13")
        self.assertEqual(stop["arrival_actual_date"], "2026-07-14")
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_legacy_null_service_date_is_derived_from_departure_not_collection_date(self):
        conn = connection()
        create_legacy_tables(conn)
        row = service_row(
            date="2026-07-13",
            service_date=None,
            last_seen="2026-07-13T10:35:00Z",
            detail_last_seen="2026-07-13T10:35:00Z",
        )
        insert_legacy_train(conn, row)

        result = backfill_legacy_batch(
            conn,
            last_rowid=0,
            high_water_rowid=1,
            batch_size=100,
        )

        service = conn.execute("SELECT * FROM train_services").fetchone()
        self.assertTrue(result["done"])
        self.assertEqual(result["last_rowid"], 1)
        self.assertEqual(service["service_date"], "2026-07-12")
        self.assertEqual(service["latest_collection_date"], "2026-07-13")

    def test_migration_high_water_exact_boundary_is_resumable(self):
        conn = connection()
        create_legacy_tables(conn)
        for index in range(3):
            insert_legacy_train(
                conn,
                service_row(
                    train_key=f"{1954 + index}-S01700-{1783890000000 + index}",
                    train_number=str(1954 + index),
                    departure_epoch_ms=str(1783890000000 + index),
                ),
            )

        result = backfill_legacy_batch(
            conn,
            last_rowid=0,
            high_water_rowid=2,
            batch_size=2,
        )
        save_migration_state(
            conn,
            "legacy-v2",
            last_rowid=result["last_rowid"],
            high_water_rowid=2,
            completed=result["done"],
            details={"processed": result["processed"]},
        )
        state = migration_state(conn, "legacy-v2")
        resumed = backfill_legacy_batch(
            conn,
            last_rowid=state["last_legacy_rowid"],
            high_water_rowid=state["high_water_rowid"],
            batch_size=2,
        )

        self.assertEqual(result["processed"], 2)
        self.assertEqual(result["last_rowid"], 2)
        self.assertTrue(result["done"])
        self.assertEqual(state["last_legacy_rowid"], 2)
        self.assertEqual(state["high_water_rowid"], 2)
        self.assertEqual(state["completed"], 1)
        self.assertEqual(json.loads(state["details"]), {"processed": 2})
        self.assertEqual(resumed["processed"], 0)
        self.assertTrue(resumed["done"])
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM train_services").fetchone()[0], 2)

    def test_migration_cli_defaults_to_read_only_dry_run(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.executescript(
                    """
                    CREATE TABLE trains (
                        date TEXT NOT NULL,
                        service_date TEXT,
                        train_key TEXT NOT NULL
                    );
                    CREATE VIEW train_stops AS
                        SELECT * FROM deliberately_missing_stop_source;
                    """
                )

            completed = subprocess.run(
                [sys.executable, str(MIGRATION_SCRIPT), "--database", str(database)],
                check=True,
                capture_output=True,
                text=True,
            )
            output = json.loads(completed.stdout)
            with closing(sqlite3.connect(database)) as conn:
                v2_exists = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='train_services'"
                ).fetchone()

            self.assertEqual(output["mode"], "dry-run")
            self.assertEqual(output["legacyTrains"], 0)
            self.assertIsNone(output["legacyStops"])
            self.assertFalse(output["legacyStopsCounted"])
            self.assertIsNone(output["v2StopEvents"])
            self.assertFalse(output["v2StopEventsCounted"])
            self.assertEqual(output["collectionDateDiffersFromServiceDate"], 0)
            self.assertNotIn("nonCanonicalLegacyRows", output)
            self.assertIn("skipping legacy stop count", completed.stderr)
            self.assertIsNone(v2_exists)

    def test_default_profile_never_reads_legacy_or_v2_stop_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database, cached_statements=0)) as conn:
                conn.row_factory = sqlite3.Row
                conn.executescript(
                    """
                    CREATE TABLE trains (
                        date TEXT NOT NULL,
                        service_date TEXT,
                        train_key TEXT NOT NULL
                    );
                    CREATE TABLE train_stops (value INTEGER);
                    CREATE TABLE train_stop_events (value INTEGER);
                    """
                )
                stop_reads = []

                def authorizer(action, arg1, arg2, database_name, source):
                    if action == sqlite3.SQLITE_READ and arg1 in {
                        "train_stops",
                        "train_stop_events",
                    }:
                        stop_reads.append((arg1, arg2))
                        return sqlite3.SQLITE_DENY
                    return sqlite3.SQLITE_OK

                conn.set_authorizer(authorizer)
                messages = []
                output = profile(
                    conn,
                    str(database),
                    include_stops=False,
                    progress=messages.append,
                )

            self.assertEqual(stop_reads, [])
            self.assertIsNone(output["legacyStops"])
            self.assertFalse(output["legacyStopsCounted"])
            self.assertIsNone(output["v2StopEvents"])
            self.assertFalse(output["v2StopEventsCounted"])
            self.assertTrue(any("skipping legacy stop count" in item for item in messages))
            self.assertTrue(any("skipping train_stop_events" in item for item in messages))

    def test_migration_cli_counts_stops_only_when_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.executescript(
                    """
                    CREATE TABLE trains (
                        date TEXT NOT NULL,
                        service_date TEXT,
                        train_key TEXT NOT NULL
                    );
                    CREATE TABLE train_stops (
                        date TEXT NOT NULL,
                        train_key TEXT NOT NULL,
                        stop_number INTEGER NOT NULL
                    );
                    INSERT INTO train_stops VALUES
                        ('2026-07-13', 'service-1', 0),
                        ('2026-07-13', 'service-1', 1);
                    CREATE TABLE train_stop_events (value INTEGER);
                    INSERT INTO train_stop_events VALUES (1);
                    """
                )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--include-stops",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            output = json.loads(completed.stdout)

            self.assertEqual(output["legacyStops"], 2)
            self.assertTrue(output["legacyStopsCounted"])
            self.assertEqual(output["v2StopEvents"], 1)
            self.assertTrue(output["v2StopEventsCounted"])
            self.assertTrue(output["estimateIncludesStops"])
            self.assertEqual(output["estimatedV2GrowthBytes"], 2 * 768)
            self.assertIn("counting legacy stops", completed.stderr)
            self.assertIn("legacy stop count complete (2 rows)", completed.stderr)

    def test_default_apply_does_not_require_or_count_stop_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.execute(
                    """
                    CREATE TABLE trains (
                        date TEXT NOT NULL,
                        service_date TEXT,
                        train_key TEXT NOT NULL
                    )
                    """
                )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--apply",
                    "--max-batches",
                    "1",
                    "--pause-ms",
                    "0",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            output = json.loads(completed.stdout)

            self.assertTrue(output["completed"])
            self.assertIsNone(output["legacyStops"])
            self.assertFalse(output["legacyStopsCounted"])
            self.assertIsNone(output["v2StopEvents"])
            self.assertFalse(output["v2StopEventsCounted"])
            self.assertIn("batch 1 committed", completed.stderr)

    def test_stop_migration_guard_rejects_before_any_database_write(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.execute(
                    "CREATE TABLE trains (date TEXT, service_date TEXT, train_key TEXT)"
                )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--apply",
                    "--include-stops",
                    "--reset-progress",
                    "--force-low-space",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            with closing(sqlite3.connect(database)) as conn:
                v2_exists = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='train_services'"
                ).fetchone()

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("--maintenance-window", completed.stderr)
            self.assertNotIn("[statistics-v2]", completed.stderr)
            self.assertIsNone(v2_exists)

    def test_migration_foreign_key_failure_stays_incomplete_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.row_factory = sqlite3.Row
                create_legacy_tables(conn)
                initialize_v2_schema(conn)
                conn.commit()
                conn.execute("PRAGMA foreign_keys=OFF")
                conn.executemany(
                    """
                    INSERT INTO train_raw_payloads (
                        service_date, train_key, observed_at, payload,
                        payload_format, payload_quality
                    ) VALUES ('2026-07-12', ?, '2026-07-13T10:35:00Z',
                              X'00', 'zlib-json-v1', 1)
                    """,
                    [(f"missing-parent-{index}",) for index in range(20)],
                )
                conn.commit()

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--apply",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            output = json.loads(completed.stdout)
            with closing(sqlite3.connect(database)) as conn:
                state = conn.execute(
                    "SELECT completed FROM statistics_migration_state "
                    "WHERE name='legacy-services-to-v2'"
                ).fetchone()

            self.assertEqual(completed.returncode, 2)
            self.assertTrue(output["validationFailed"])
            self.assertFalse(output["completed"])
            self.assertEqual(len(output["foreignKeyViolationsSample"]), 20)
            self.assertFalse(output["foreignKeyViolationsTruncated"])
            self.assertEqual(state[0], 0)

    def test_migration_foreign_key_sample_marks_more_than_twenty_as_truncated(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.row_factory = sqlite3.Row
                create_legacy_tables(conn)
                initialize_v2_schema(conn)
                conn.commit()
                conn.execute("PRAGMA foreign_keys=OFF")
                conn.executemany(
                    """
                    INSERT INTO train_raw_payloads (
                        service_date, train_key, observed_at, payload,
                        payload_format, payload_quality
                    ) VALUES ('2026-07-12', ?, '2026-07-13T10:35:00Z',
                              X'00', 'zlib-json-v1', 1)
                    """,
                    [(f"missing-parent-{index}",) for index in range(21)],
                )
                conn.commit()

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--apply",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            output = json.loads(completed.stdout)
            with closing(sqlite3.connect(database)) as conn:
                state = conn.execute(
                    "SELECT completed FROM statistics_migration_state "
                    "WHERE name='legacy-services-to-v2'"
                ).fetchone()

            self.assertEqual(completed.returncode, 2)
            self.assertEqual(len(output["foreignKeyViolationsSample"]), 20)
            self.assertTrue(output["foreignKeyViolationsTruncated"])
            self.assertEqual(state[0], 0)

    def test_migration_cli_resumes_fixed_high_water_with_cumulative_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statistics.db"
            with closing(sqlite3.connect(database)) as conn:
                conn.row_factory = sqlite3.Row
                create_legacy_tables(conn)
                for index in range(3):
                    insert_legacy_train(
                        conn,
                        service_row(
                            train_key=f"{1954 + index}-S01700-{1783890000000 + index}",
                            train_number=str(1954 + index),
                            departure_epoch_ms=str(1783890000000 + index),
                        ),
                    )
                conn.commit()

            first = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--apply",
                    "--batch-size",
                    "1",
                    "--max-batches",
                    "1",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            first_output = json.loads(first.stdout)
            resumed = subprocess.run(
                [
                    sys.executable,
                    str(MIGRATION_SCRIPT),
                    "--database",
                    str(database),
                    "--apply",
                    "--batch-size",
                    "1",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            resumed_output = json.loads(resumed.stdout)

            self.assertFalse(first_output["completed"])
            self.assertEqual(first_output["highWaterLegacyRowid"], 3)
            self.assertEqual(first_output["processed"], 1)
            self.assertEqual(first_output["runTotals"]["processed"], 1)
            self.assertTrue(resumed_output["completed"])
            self.assertEqual(resumed_output["highWaterLegacyRowid"], 3)
            self.assertEqual(resumed_output["processed"], 3)
            self.assertEqual(resumed_output["runTotals"]["processed"], 2)


if __name__ == "__main__":
    unittest.main()
