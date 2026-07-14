from __future__ import annotations

import json
import sqlite3
import zlib
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

from statistics_core.normalizers import service_date_from_epoch_ms


SCHEMA_VERSION = 2
RAW_PAYLOAD_MAGIC = b"BTZ1"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def encode_raw_json(value: Any) -> bytes:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return RAW_PAYLOAD_MAGIC + zlib.compress(payload, level=6)


def decode_raw_json(value: Any) -> Any:
    if value is None or value == "":
        return {}
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, bytes):
        if value.startswith(RAW_PAYLOAD_MAGIC):
            value = zlib.decompress(value[len(RAW_PAYLOAD_MAGIC) :])
        return json.loads(value.decode("utf-8"))
    if isinstance(value, str):
        return json.loads(value)
    raise TypeError(f"unsupported raw JSON value: {type(value).__name__}")


def resolve_train_raw_payload(
    conn: sqlite3.Connection,
    *,
    collection_date: str,
    service_date: str,
    train_key: str,
    legacy_payload: Any = None,
) -> Any:
    """Prefer collection-date legacy raw and never leak a later service snapshot."""
    if legacy_payload not in (None, "", b""):
        return legacy_payload
    row = conn.execute(
        """
        SELECT p.payload
        FROM train_raw_payloads p
        JOIN train_services s
          ON s.service_date=p.service_date AND s.train_key=p.train_key
        WHERE p.service_date=? AND p.train_key=?
          AND s.detail_collection_date=?
        """,
        (service_date, train_key, collection_date),
    ).fetchone()
    return row[0] if row else None


def initialize_v2_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS statistics_schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS train_services (
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
            detail_attempted_at TEXT,
            detail_failure_count INTEGER NOT NULL DEFAULT 0,
            detail_next_retry_at TEXT,
            detail_last_error TEXT,
            PRIMARY KEY (service_date, train_key),
            CHECK (identity_quality IN ('canonical', 'provisional'))
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_train_services_date_delay
            ON train_services(service_date, delay DESC);
        CREATE INDEX IF NOT EXISTS idx_train_services_latest
            ON train_services(latest_collection_date, last_seen);

        CREATE TABLE IF NOT EXISTS train_observations (
            service_date TEXT NOT NULL,
            train_key TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            collection_date TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT,
            departure_delay INTEGER DEFAULT 0,
            arrival_delay INTEGER DEFAULT 0,
            delay INTEGER DEFAULT 0,
            cancelled INTEGER DEFAULT 0,
            rescheduled INTEGER DEFAULT 0,
            not_departed INTEGER DEFAULT 0,
            has_details INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            quality_score INTEGER NOT NULL DEFAULT 0,
            quality_flags TEXT NOT NULL DEFAULT '[]',
            evidence_station_code TEXT,
            evidence_expected_at TEXT,
            evidence_actual_at TEXT,
            evidence_delay INTEGER,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY (service_date, train_key, observed_at, collection_date),
            FOREIGN KEY (service_date, train_key)
                REFERENCES train_services(service_date, train_key) ON DELETE CASCADE
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_train_observations_collection
            ON train_observations(collection_date, observed_at);
        CREATE INDEX IF NOT EXISTS idx_train_observations_service_status
            ON train_observations(service_date, status);

        CREATE TABLE IF NOT EXISTS train_stop_events (
            service_date TEXT NOT NULL,
            train_key TEXT NOT NULL,
            stop_number INTEGER NOT NULL,
            train_number TEXT,
            category TEXT,
            station_code TEXT,
            station_name TEXT,
            stop_type TEXT,
            platform TEXT,
            arrival_expected TEXT,
            arrival_expected_date TEXT,
            arrival_actual TEXT,
            arrival_actual_date TEXT,
            arrival_delay INTEGER,
            departure_expected TEXT,
            departure_expected_date TEXT,
            departure_actual TEXT,
            departure_actual_date TEXT,
            departure_delay INTEGER,
            cancelled INTEGER DEFAULT 0,
            detail_observed_at TEXT NOT NULL,
            detail_quality INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (service_date, train_key, stop_number),
            FOREIGN KEY (service_date, train_key)
                REFERENCES train_services(service_date, train_key) ON DELETE CASCADE
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_train_stop_events_station_arrival
            ON train_stop_events(station_code, arrival_expected_date);
        CREATE INDEX IF NOT EXISTS idx_train_stop_events_station_departure
            ON train_stop_events(station_code, departure_expected_date);

        CREATE TABLE IF NOT EXISTS train_raw_payloads (
            service_date TEXT NOT NULL,
            train_key TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            payload BLOB NOT NULL,
            payload_format TEXT NOT NULL DEFAULT 'zlib-json-v1',
            payload_quality INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (service_date, train_key),
            FOREIGN KEY (service_date, train_key)
                REFERENCES train_services(service_date, train_key) ON DELETE CASCADE
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS statistics_migration_state (
            name TEXT PRIMARY KEY,
            last_legacy_rowid INTEGER NOT NULL DEFAULT 0,
            high_water_rowid INTEGER NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            details TEXT
        );
        """
    )
    service_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(train_services)").fetchall()
    }
    if "detail_collection_date" not in service_columns:
        conn.execute("ALTER TABLE train_services ADD COLUMN detail_collection_date TEXT")
    for column in ("latest_state_quality", "detail_quality", "detail_failure_count"):
        if column not in service_columns:
            conn.execute(
                f"ALTER TABLE train_services ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
            )
    for column in ("detail_attempted_at", "detail_next_retry_at", "detail_last_error"):
        if column not in service_columns:
            conn.execute(f"ALTER TABLE train_services ADD COLUMN {column} TEXT")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_train_services_detail_retry
        ON train_services(completed, detail_next_retry_at, service_date)
        """
    )
    observation_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(train_observations)").fetchall()
    }
    for column, definition in (
        ("quality_score", "INTEGER NOT NULL DEFAULT 0"),
        ("evidence_station_code", "TEXT"),
        ("evidence_expected_at", "TEXT"),
        ("evidence_actual_at", "TEXT"),
        ("evidence_delay", "INTEGER"),
    ):
        if column not in observation_columns:
            conn.execute(f"ALTER TABLE train_observations ADD COLUMN {column} {definition}")
    stop_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(train_stop_events)").fetchall()
    }
    if "detail_observed_at" not in stop_columns:
        conn.execute("ALTER TABLE train_stop_events ADD COLUMN detail_observed_at TEXT")
    if "detail_quality" not in stop_columns:
        conn.execute(
            "ALTER TABLE train_stop_events ADD COLUMN detail_quality INTEGER NOT NULL DEFAULT 0"
        )
    raw_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(train_raw_payloads)").fetchall()
    }
    if "payload_quality" not in raw_columns:
        conn.execute(
            "ALTER TABLE train_raw_payloads ADD COLUMN payload_quality INTEGER NOT NULL DEFAULT 0"
        )
    migration_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(statistics_migration_state)").fetchall()
    }
    if "high_water_rowid" not in migration_columns:
        conn.execute(
            "ALTER TABLE statistics_migration_state ADD COLUMN high_water_rowid INTEGER NOT NULL DEFAULT 0"
        )

    required_columns = {
        "train_services": {
            "service_date",
            "train_key",
            "identity_quality",
            "train_number",
            "departure_epoch_ms",
            "category",
            "operator",
            "status",
            "origin",
            "destination",
            "origin_code",
            "destination_code",
            "relation_key",
            "departure_delay",
            "arrival_delay",
            "delay",
            "cancelled",
            "rescheduled",
            "not_departed",
            "scheduled_departure",
            "scheduled_arrival",
            "first_seen",
            "last_seen",
            "latest_collection_date",
            "latest_state_quality",
            "detail_last_seen",
            "detail_collection_date",
            "detail_quality",
            "has_details",
            "completed",
            "detail_attempted_at",
            "detail_failure_count",
            "detail_next_retry_at",
            "detail_last_error",
        },
        "train_observations": {
            "service_date",
            "train_key",
            "observed_at",
            "collection_date",
            "source",
            "status",
            "departure_delay",
            "arrival_delay",
            "delay",
            "cancelled",
            "rescheduled",
            "not_departed",
            "has_details",
            "completed",
            "quality_score",
            "quality_flags",
            "evidence_station_code",
            "evidence_expected_at",
            "evidence_actual_at",
            "evidence_delay",
            "recorded_at",
        },
        "train_stop_events": {
            "service_date",
            "train_key",
            "stop_number",
            "train_number",
            "category",
            "station_code",
            "station_name",
            "stop_type",
            "platform",
            "arrival_expected",
            "arrival_expected_date",
            "arrival_actual",
            "arrival_actual_date",
            "arrival_delay",
            "departure_expected",
            "departure_expected_date",
            "departure_actual",
            "departure_actual_date",
            "departure_delay",
            "cancelled",
            "detail_observed_at",
            "detail_quality",
        },
        "train_raw_payloads": {
            "service_date",
            "train_key",
            "observed_at",
            "payload",
            "payload_format",
            "payload_quality",
        },
        "statistics_schema_migrations": {"name", "applied_at"},
        "statistics_migration_state": {
            "name",
            "last_legacy_rowid",
            "high_water_rowid",
            "completed",
            "updated_at",
            "details",
        },
    }
    for table, expected in required_columns.items():
        table_info = conn.execute(f"PRAGMA table_info({table})").fetchall()
        actual = {row[1] for row in table_info}
        missing = expected - actual
        if missing:
            raise RuntimeError(
                f"statistics v2 table {table!r} is incompatible; missing columns: "
                + ", ".join(sorted(missing))
            )

    expected_primary_keys = {
        "train_services": ["service_date", "train_key"],
        "train_observations": [
            "service_date",
            "train_key",
            "observed_at",
            "collection_date",
        ],
        "train_stop_events": ["service_date", "train_key", "stop_number"],
        "train_raw_payloads": ["service_date", "train_key"],
    }
    for table, expected in expected_primary_keys.items():
        table_info = conn.execute(f"PRAGMA table_info({table})").fetchall()
        actual = [
            row[1]
            for row in sorted((row for row in table_info if row[5]), key=lambda row: row[5])
        ]
        if actual != expected:
            raise RuntimeError(
                f"statistics v2 table {table!r} has incompatible primary key: "
                f"expected {expected}, found {actual}"
            )
        table_sql_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if not table_sql_row or "WITHOUT ROWID" not in _text(table_sql_row[0]).upper():
            raise RuntimeError(
                f"statistics v2 table {table!r} must use WITHOUT ROWID"
            )

    for table in ("statistics_schema_migrations", "statistics_migration_state"):
        table_info = conn.execute(f"PRAGMA table_info({table})").fetchall()
        actual_primary_key = [
            row[1]
            for row in sorted((row for row in table_info if row[5]), key=lambda row: row[5])
        ]
        if actual_primary_key != ["name"]:
            raise RuntimeError(
                f"statistics v2 table {table!r} has incompatible primary key: "
                f"expected ['name'], found {actual_primary_key}"
            )

    for table in ("train_observations", "train_stop_events", "train_raw_payloads"):
        foreign_key_groups: dict[int, list[Any]] = {}
        for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall():
            foreign_key_groups.setdefault(row[0], []).append(row)
        expected = [
            ("train_services", "service_date", "service_date", "CASCADE"),
            ("train_services", "train_key", "train_key", "CASCADE"),
        ]
        has_service_foreign_key = any(
            [
                (row[2], row[3], row[4], _text(row[6]).upper())
                for row in sorted(group, key=lambda item: item[1])
            ]
            == expected
            for group in foreign_key_groups.values()
        )
        if not has_service_foreign_key:
            raise RuntimeError(
                f"statistics v2 table {table!r} has incompatible service foreign key"
            )
    conn.execute(
        """
        INSERT OR IGNORE INTO statistics_schema_migrations (name, applied_at)
        VALUES (?, ?)
        """,
        (f"v{SCHEMA_VERSION}-additive-storage", utc_now_iso()),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO statistics_schema_migrations (name, applied_at)
        VALUES (?, ?)
        """,
        (f"v{SCHEMA_VERSION}-quality-ranking", utc_now_iso()),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO statistics_schema_migrations (name, applied_at)
        VALUES (?, ?)
        """,
        (f"v{SCHEMA_VERSION}-detail-retry-state", utc_now_iso()),
    )


def _text(value: Any) -> str:
    return str(value or "").strip()


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _utc_datetime(value: Any) -> datetime:
    text = _text(value)
    if text:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_active_service_keys(
    conn: sqlite3.Connection,
    *,
    earliest_service_date: str,
    collection_date: str,
) -> set[str]:
    """Merge v2 and legacy state while an additive migration is in progress."""
    rows = conn.execute(
        """
        WITH candidates AS (
            SELECT train_key, COALESCE(completed, 0) AS completed
            FROM train_services
            WHERE service_date BETWEEN ? AND ?
            UNION ALL
            SELECT train_key, COALESCE(completed, 0) AS completed
            FROM trains
            WHERE date BETWEEN ? AND ?
              AND COALESCE(NULLIF(service_date, ''), date) BETWEEN ? AND ?
        )
        SELECT train_key
        FROM candidates
        WHERE train_key IS NOT NULL AND train_key<>''
        GROUP BY train_key
        HAVING MAX(completed)=0
        """,
        (
            earliest_service_date,
            collection_date,
            earliest_service_date,
            collection_date,
            earliest_service_date,
            collection_date,
        ),
    ).fetchall()
    return {_text(row[0]) for row in rows if _text(row[0])}


def detail_retry_due(next_retry_at: Any, as_of: Any) -> bool:
    if not _text(next_retry_at):
        return True
    return _utc_datetime(next_retry_at) <= _utc_datetime(as_of)


def record_detail_attempt(
    conn: sqlite3.Connection,
    *,
    service_date: str,
    train_key: str,
    attempted_at: str,
    succeeded: bool,
    completed: bool = False,
    error: str | None = None,
    retry_base_minutes: int = 60,
    retry_max_minutes: int = 720,
    success_refresh_minutes: int = 120,
) -> dict[str, Any]:
    """Persist a detail attempt and return the resulting retry state."""
    current = conn.execute(
        """
        SELECT detail_failure_count
        FROM train_services
        WHERE service_date=? AND train_key=?
        """,
        (service_date, train_key),
    ).fetchone()
    if not current:
        return {"updated": False, "failure_count": 0, "next_retry_at": None}

    attempt_dt = _utc_datetime(attempted_at)
    attempted_iso = _utc_iso(attempt_dt)
    if succeeded:
        failure_count = 0
        next_retry_at = (
            None
            if completed
            else _utc_iso(attempt_dt + timedelta(minutes=max(1, success_refresh_minutes)))
        )
        last_error = None
    else:
        previous_failures = max(0, _int(current[0]))
        failure_count = previous_failures + 1
        base_minutes = max(1, retry_base_minutes)
        maximum_minutes = max(base_minutes, retry_max_minutes)
        delay_minutes = min(
            maximum_minutes,
            base_minutes * (2 ** min(previous_failures, 30)),
        )
        next_retry_at = _utc_iso(attempt_dt + timedelta(minutes=delay_minutes))
        last_error = _text(error or "detail_fetch_failed")[:500]

    conn.execute(
        """
        UPDATE train_services
        SET detail_attempted_at=?, detail_failure_count=?, detail_next_retry_at=?,
            detail_last_error=?
        WHERE service_date=? AND train_key=?
        """,
        (
            attempted_iso,
            failure_count,
            next_retry_at,
            last_error,
            service_date,
            train_key,
        ),
    )
    return {
        "updated": True,
        "failure_count": failure_count,
        "next_retry_at": next_retry_at,
    }


def identity_quality(row: Mapping[str, Any]) -> str:
    explicit = _text(row.get("identity_quality"))
    if explicit in {"canonical", "provisional"}:
        return explicit
    key = _text(row.get("train_key"))
    complete = all(
        _text(row.get(name))
        for name in ("train_number", "origin_code", "departure_epoch_ms")
    )
    return "canonical" if complete and not key.startswith("unknown-") else "provisional"


def delay_quality_flags(row: Mapping[str, Any]) -> list[str]:
    magnitude = max(
        abs(_int(row.get("delay"))),
        abs(_int(row.get("departure_delay"))),
        abs(_int(row.get("arrival_delay"))),
    )
    flags: list[str] = []
    if magnitude >= 12 * 60:
        flags.append("extreme_delay_12h")
    if magnitude >= 24 * 60:
        flags.append("extreme_delay_24h")
    return flags


def observation_quality(row: Mapping[str, Any], source: str = "") -> int:
    """Rank equal-time observations without treating every detail as equally complete."""
    explicit = row.get("observation_quality")
    if explicit is not None:
        return max(0, _int(explicit))
    has_details = bool(_int(row.get("has_details")))
    score = 1000 if has_details else 100
    score += 50 if identity_quality(row) == "canonical" else 0
    score += min(max(_int(row.get("detail_stop_count")), 0), 250) * 2
    score += sum(
        5
        for name in (
            "status",
            "category",
            "operator",
            "origin_code",
            "destination_code",
            "scheduled_departure",
            "scheduled_arrival",
            "evidence_station_code",
            "evidence_expected_at",
            "evidence_actual_at",
        )
        if _text(row.get(name))
    )
    return score


def stop_snapshot_quality(stops: Sequence[Mapping[str, Any]]) -> int:
    score = len(stops) * 100
    for stop in stops:
        score += sum(
            1
            for name in (
                "station_code",
                "station_name",
                "arrival_expected",
                "arrival_actual",
                "departure_expected",
                "departure_actual",
            )
            if _text(stop.get(name))
        )
    return score


def upsert_train_service(
    conn: sqlite3.Connection,
    row: Mapping[str, Any],
    *,
    collection_date: str,
    observed_at: str,
    source: str,
) -> None:
    service_date = _text(row.get("service_date")) or collection_date
    quality_score = observation_quality(row, source)
    detail_quality = quality_score if _int(row.get("has_details")) else 0
    values = {
        "service_date": service_date,
        "train_key": _text(row.get("train_key")),
        "identity_quality": identity_quality(row),
        "train_number": _text(row.get("train_number")),
        "departure_epoch_ms": _text(row.get("departure_epoch_ms")),
        "category": _text(row.get("category")),
        "operator": _text(row.get("operator")),
        "status": _text(row.get("status")),
        "origin": _text(row.get("origin")),
        "destination": _text(row.get("destination")),
        "origin_code": _text(row.get("origin_code")),
        "destination_code": _text(row.get("destination_code")),
        "relation_key": _text(row.get("relation_key")),
        "departure_delay": _int(row.get("departure_delay")),
        "arrival_delay": _int(row.get("arrival_delay")),
        "delay": _int(row.get("delay")),
        "cancelled": _int(row.get("cancelled")),
        "rescheduled": _int(row.get("rescheduled")),
        "not_departed": _int(row.get("not_departed")),
        "scheduled_departure": _text(row.get("scheduled_departure")),
        "scheduled_arrival": _text(row.get("scheduled_arrival")),
        "first_seen": observed_at,
        "last_seen": observed_at,
        "latest_collection_date": collection_date,
        "latest_state_quality": quality_score,
        "detail_last_seen": _text(row.get("detail_last_seen")),
        "detail_collection_date": collection_date if _int(row.get("has_details")) else "",
        "detail_quality": detail_quality,
        "has_details": _int(row.get("has_details")),
        "completed": _int(row.get("completed")),
    }
    if not values["train_key"]:
        raise ValueError("train_key is required for v2 storage")

    conn.execute(
        """
        INSERT INTO train_services (
            service_date, train_key, identity_quality, train_number, departure_epoch_ms,
            category, operator, status, origin, destination, origin_code, destination_code,
            relation_key, departure_delay, arrival_delay, delay, cancelled, rescheduled,
            not_departed, scheduled_departure, scheduled_arrival, first_seen, last_seen,
            latest_collection_date, latest_state_quality, detail_last_seen,
            detail_collection_date, detail_quality, has_details, completed
        ) VALUES (
            :service_date, :train_key, :identity_quality, :train_number, :departure_epoch_ms,
            :category, :operator, :status, :origin, :destination, :origin_code, :destination_code,
            :relation_key, :departure_delay, :arrival_delay, :delay, :cancelled, :rescheduled,
            :not_departed, :scheduled_departure, :scheduled_arrival, :first_seen, :last_seen,
            :latest_collection_date, :latest_state_quality, :detail_last_seen,
            :detail_collection_date, :detail_quality, :has_details, :completed
        )
        ON CONFLICT(service_date, train_key) DO UPDATE SET
            identity_quality=CASE
                WHEN train_services.identity_quality='canonical' THEN 'canonical'
                ELSE excluded.identity_quality
            END,
            train_number=COALESCE(NULLIF(excluded.train_number, ''), train_services.train_number),
            departure_epoch_ms=COALESCE(NULLIF(excluded.departure_epoch_ms, ''), train_services.departure_epoch_ms),
            category=CASE WHEN excluded.category<>'' AND (COALESCE(train_services.category, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.category ELSE train_services.category END,
            operator=CASE WHEN excluded.operator<>'' AND (COALESCE(train_services.operator, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.operator ELSE train_services.operator END,
            origin=CASE WHEN excluded.origin<>'' AND (COALESCE(train_services.origin, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.origin ELSE train_services.origin END,
            destination=CASE WHEN excluded.destination<>'' AND (COALESCE(train_services.destination, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.destination ELSE train_services.destination END,
            origin_code=CASE WHEN excluded.origin_code<>'' AND (COALESCE(train_services.origin_code, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.origin_code ELSE train_services.origin_code END,
            destination_code=CASE WHEN excluded.destination_code<>'' AND (COALESCE(train_services.destination_code, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.destination_code ELSE train_services.destination_code END,
            relation_key=CASE WHEN excluded.relation_key<>'' AND (COALESCE(train_services.relation_key, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.relation_key ELSE train_services.relation_key END,
            scheduled_departure=CASE WHEN excluded.scheduled_departure<>'' AND (COALESCE(train_services.scheduled_departure, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.scheduled_departure ELSE train_services.scheduled_departure END,
            scheduled_arrival=CASE WHEN excluded.scheduled_arrival<>'' AND (COALESCE(train_services.scheduled_arrival, '')='' OR (excluded.has_details=1 AND (excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality))) OR (train_services.has_details=0 AND excluded.has_details=0 AND (excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality)))) THEN excluded.scheduled_arrival ELSE train_services.scheduled_arrival END,
            status=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.status ELSE train_services.status END,
            departure_delay=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.departure_delay ELSE train_services.departure_delay END,
            arrival_delay=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.arrival_delay ELSE train_services.arrival_delay END,
            delay=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.delay ELSE train_services.delay END,
            cancelled=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.cancelled ELSE train_services.cancelled END,
            rescheduled=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.rescheduled ELSE train_services.rescheduled END,
            not_departed=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.not_departed ELSE train_services.not_departed END,
            latest_collection_date=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.latest_collection_date ELSE train_services.latest_collection_date END,
            latest_state_quality=CASE WHEN excluded.last_seen > COALESCE(train_services.last_seen, '') OR (excluded.last_seen = COALESCE(train_services.last_seen, '') AND excluded.latest_state_quality >= train_services.latest_state_quality) THEN excluded.latest_state_quality ELSE train_services.latest_state_quality END,
            first_seen=CASE WHEN COALESCE(train_services.first_seen, '')='' OR excluded.first_seen < train_services.first_seen THEN excluded.first_seen ELSE train_services.first_seen END,
            last_seen=CASE WHEN excluded.last_seen >= COALESCE(train_services.last_seen, '') THEN excluded.last_seen ELSE train_services.last_seen END,
            detail_collection_date=CASE
                WHEN excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') THEN excluded.detail_collection_date
                WHEN excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality AND excluded.detail_collection_date > COALESCE(train_services.detail_collection_date, '') THEN excluded.detail_collection_date
                ELSE train_services.detail_collection_date
            END,
            detail_last_seen=CASE WHEN excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality) THEN excluded.detail_last_seen ELSE train_services.detail_last_seen END,
            detail_quality=CASE WHEN excluded.detail_last_seen > COALESCE(train_services.detail_last_seen, '') OR (excluded.detail_last_seen = COALESCE(train_services.detail_last_seen, '') AND excluded.detail_quality >= train_services.detail_quality) THEN excluded.detail_quality ELSE train_services.detail_quality END,
            has_details=MAX(excluded.has_details, train_services.has_details),
            completed=MAX(excluded.completed, train_services.completed)
        """,
        values,
    )

    observation = {
        **values,
        "observed_at": observed_at,
        "collection_date": collection_date,
        "source": source,
        "quality_score": quality_score,
        "quality_flags": json.dumps(delay_quality_flags(row), separators=(",", ":")),
        "evidence_station_code": _text(row.get("evidence_station_code")),
        "evidence_expected_at": _text(row.get("evidence_expected_at")),
        "evidence_actual_at": _text(row.get("evidence_actual_at")),
        "evidence_delay": row.get("evidence_delay"),
        "recorded_at": utc_now_iso(),
    }
    conn.execute(
        """
        INSERT INTO train_observations (
            service_date, train_key, observed_at, collection_date, source, status,
            departure_delay, arrival_delay, delay, cancelled, rescheduled, not_departed,
            has_details, completed, quality_score, quality_flags, evidence_station_code,
            evidence_expected_at, evidence_actual_at, evidence_delay, recorded_at
        ) VALUES (
            :service_date, :train_key, :observed_at, :collection_date, :source, :status,
            :departure_delay, :arrival_delay, :delay, :cancelled, :rescheduled, :not_departed,
            :has_details, :completed, :quality_score, :quality_flags, :evidence_station_code,
            :evidence_expected_at, :evidence_actual_at, :evidence_delay, :recorded_at
        )
        ON CONFLICT(service_date, train_key, observed_at, collection_date) DO UPDATE SET
            source=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.source ELSE train_observations.source END,
            status=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.status ELSE train_observations.status END,
            departure_delay=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.departure_delay ELSE train_observations.departure_delay END,
            arrival_delay=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.arrival_delay ELSE train_observations.arrival_delay END,
            delay=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.delay ELSE train_observations.delay END,
            cancelled=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.cancelled ELSE train_observations.cancelled END,
            rescheduled=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.rescheduled ELSE train_observations.rescheduled END,
            not_departed=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.not_departed ELSE train_observations.not_departed END,
            has_details=MAX(excluded.has_details, train_observations.has_details),
            completed=MAX(excluded.completed, train_observations.completed),
            quality_score=MAX(excluded.quality_score, train_observations.quality_score),
            quality_flags=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.quality_flags ELSE train_observations.quality_flags END,
            evidence_station_code=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.evidence_station_code ELSE train_observations.evidence_station_code END,
            evidence_expected_at=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.evidence_expected_at ELSE train_observations.evidence_expected_at END,
            evidence_actual_at=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.evidence_actual_at ELSE train_observations.evidence_actual_at END,
            evidence_delay=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.evidence_delay ELSE train_observations.evidence_delay END,
            recorded_at=CASE WHEN excluded.quality_score >= train_observations.quality_score THEN excluded.recorded_at ELSE train_observations.recorded_at END
        """,
        observation,
    )


def _event_date(value: Any) -> str | None:
    text = _text(value)
    if len(text) >= 10:
        try:
            return date.fromisoformat(text[:10]).isoformat()
        except ValueError:
            return None
    return None


def replace_train_stop_events(
    conn: sqlite3.Connection,
    row: Mapping[str, Any],
    stops: Sequence[Mapping[str, Any]],
) -> bool:
    service_date = _text(row.get("service_date")) or _text(row.get("date"))
    train_key = _text(row.get("train_key"))
    detail_observed_at = _text(row.get("detail_last_seen")) or _text(row.get("last_seen"))
    if not stops or not detail_observed_at:
        return False
    detail_quality = stop_snapshot_quality(stops)
    current = conn.execute(
        """
        SELECT MAX(detail_observed_at), MAX(detail_quality)
        FROM train_stop_events
        WHERE service_date=? AND train_key=?
        """,
        (service_date, train_key),
    ).fetchone()
    current_observed_at = current[0]
    current_quality = _int(current[1])
    if current_observed_at and (
        detail_observed_at < current_observed_at
        or (detail_observed_at == current_observed_at and detail_quality < current_quality)
    ):
        return False
    conn.execute(
        "DELETE FROM train_stop_events WHERE service_date=? AND train_key=?",
        (service_date, train_key),
    )
    values = []
    for stop in stops:
        values.append(
            {
                "service_date": service_date,
                "train_key": train_key,
                "stop_number": _int(stop.get("stop_number")),
                "train_number": _text(stop.get("train_number")),
                "category": _text(stop.get("category")),
                "station_code": _text(stop.get("station_code")),
                "station_name": _text(stop.get("station_name")),
                "stop_type": _text(stop.get("stop_type")),
                "platform": _text(stop.get("platform")),
                "arrival_expected": stop.get("arrival_expected"),
                "arrival_expected_date": _event_date(stop.get("arrival_expected")),
                "arrival_actual": stop.get("arrival_actual"),
                "arrival_actual_date": _event_date(stop.get("arrival_actual")),
                "arrival_delay": stop.get("arrival_delay"),
                "departure_expected": stop.get("departure_expected"),
                "departure_expected_date": _event_date(stop.get("departure_expected")),
                "departure_actual": stop.get("departure_actual"),
                "departure_actual_date": _event_date(stop.get("departure_actual")),
                "departure_delay": stop.get("departure_delay"),
                "cancelled": _int(stop.get("cancelled")),
                "detail_observed_at": detail_observed_at,
                "detail_quality": detail_quality,
            }
        )
    conn.executemany(
        """
        INSERT INTO train_stop_events (
            service_date, train_key, stop_number, train_number, category, station_code,
            station_name, stop_type, platform, arrival_expected, arrival_expected_date,
            arrival_actual, arrival_actual_date, arrival_delay, departure_expected,
            departure_expected_date, departure_actual, departure_actual_date,
            departure_delay, cancelled, detail_observed_at, detail_quality
        ) VALUES (
            :service_date, :train_key, :stop_number, :train_number, :category, :station_code,
            :station_name, :stop_type, :platform, :arrival_expected, :arrival_expected_date,
            :arrival_actual, :arrival_actual_date, :arrival_delay, :departure_expected,
            :departure_expected_date, :departure_actual, :departure_actual_date,
            :departure_delay, :cancelled, :detail_observed_at, :detail_quality
        )
        """,
        values,
    )
    return True


def store_train_raw_payload(
    conn: sqlite3.Connection,
    row: Mapping[str, Any],
    payload: bytes | None,
) -> None:
    if not payload:
        return
    payload_quality = observation_quality(row, "detail")
    conn.execute(
        """
        INSERT INTO train_raw_payloads (
            service_date, train_key, observed_at, payload, payload_format, payload_quality
        ) VALUES (?, ?, ?, ?, 'zlib-json-v1', ?)
        ON CONFLICT(service_date, train_key) DO UPDATE SET
            observed_at=excluded.observed_at,
            payload=excluded.payload,
            payload_format=excluded.payload_format,
            payload_quality=excluded.payload_quality
        WHERE excluded.observed_at > train_raw_payloads.observed_at
           OR (
               excluded.observed_at = train_raw_payloads.observed_at
               AND excluded.payload_quality >= train_raw_payloads.payload_quality
           )
        """,
        (
            _text(row.get("service_date")) or _text(row.get("date")),
            _text(row.get("train_key")),
            _text(row.get("detail_last_seen")) or _text(row.get("last_seen")),
            payload,
            payload_quality,
        ),
    )


def cleanup_v2_rows(
    conn: sqlite3.Connection,
    *,
    service_cutoff: str,
    observation_cutoff: str,
    raw_cutoff: str,
) -> None:
    conn.execute("DELETE FROM train_raw_payloads WHERE observed_at < ?", (raw_cutoff,))
    conn.execute("DELETE FROM train_observations WHERE collection_date < ?", (observation_cutoff,))
    conn.execute(
        """
        DELETE FROM train_services
        WHERE service_date < ?
          AND NOT EXISTS (
              SELECT 1
              FROM train_observations o
              WHERE o.service_date=train_services.service_date
                AND o.train_key=train_services.train_key
          )
        """,
        (service_cutoff,),
    )


def migration_state(conn: sqlite3.Connection, name: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM statistics_migration_state WHERE name=?",
        (name,),
    ).fetchone()
    return dict(row) if row else {
        "name": name,
        "last_legacy_rowid": 0,
        "high_water_rowid": 0,
        "completed": 0,
        "updated_at": None,
        "details": None,
    }


def _legacy_stops_for_rows(
    conn: sqlite3.Connection,
    train_rows: Sequence[sqlite3.Row],
) -> dict[tuple[str, str], list[dict[str, Any]]]:
    keys_by_date: dict[str, set[str]] = {}
    for row in train_rows:
        if not _int(row["has_details"]):
            continue
        keys_by_date.setdefault(_text(row["date"]), set()).add(_text(row["train_key"]))

    result: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for collection_date, keys in keys_by_date.items():
        ordered_keys = sorted(keys)
        for offset in range(0, len(ordered_keys), 400):
            chunk = ordered_keys[offset : offset + 400]
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"""
                SELECT train_key, stop_number, train_number, category, station_code,
                       station_name, stop_type, platform, arrival_expected, arrival_actual,
                       arrival_delay, departure_expected, departure_actual, departure_delay,
                       cancelled
                FROM train_stops
                WHERE date=? AND train_key IN ({placeholders})
                ORDER BY train_key, stop_number
                """,
                [collection_date, *chunk],
            ).fetchall()
            for stop in rows:
                key = (collection_date, _text(stop["train_key"]))
                result.setdefault(key, []).append(dict(stop))
    return result


def backfill_legacy_batch(
    conn: sqlite3.Connection,
    *,
    last_rowid: int,
    high_water_rowid: int,
    batch_size: int,
    include_stops: bool = False,
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT rowid AS legacy_rowid, *
        FROM trains
        WHERE rowid > ? AND rowid <= ?
        ORDER BY rowid
        LIMIT ?
        """,
        (last_rowid, high_water_rowid, batch_size),
    ).fetchall()
    processed = 0
    observations = 0
    stop_events = 0
    current_rowid = last_rowid
    stops_by_legacy_key = _legacy_stops_for_rows(conn, rows) if include_stops else {}
    for raw_row in rows:
        row = dict(raw_row)
        current_rowid = int(row.pop("legacy_rowid"))
        collection_date = _text(row.get("date"))
        row["service_date"] = _text(row.get("service_date")) or service_date_from_epoch_ms(
            row.get("departure_epoch_ms"),
            collection_date,
        )
        observed_at = _text(row.get("last_seen")) or _text(row.get("detail_last_seen"))
        if not observed_at:
            observed_at = f"{collection_date}T00:00:00Z"
        upsert_train_service(
            conn,
            row,
            collection_date=collection_date,
            observed_at=observed_at,
            source="legacy_daily_state",
        )
        processed += 1
        observations += 1
        if include_stops and _int(row.get("has_details")):
            stops = stops_by_legacy_key.get((collection_date, row["train_key"]), [])
            if replace_train_stop_events(conn, row, stops):
                stop_events += len(stops)

    return {
        "processed": processed,
        "observations": observations,
        "stop_events": stop_events,
        "last_rowid": current_rowid,
        "done": len(rows) < batch_size or current_rowid >= high_water_rowid,
    }


def save_migration_state(
    conn: sqlite3.Connection,
    name: str,
    *,
    last_rowid: int,
    high_water_rowid: int,
    completed: bool,
    details: Mapping[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO statistics_migration_state (
            name, last_legacy_rowid, high_water_rowid, completed, updated_at, details
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            last_legacy_rowid=excluded.last_legacy_rowid,
            high_water_rowid=excluded.high_water_rowid,
            completed=excluded.completed,
            updated_at=excluded.updated_at,
            details=excluded.details
        """,
        (
            name,
            last_rowid,
            high_water_rowid,
            1 if completed else 0,
            utc_now_iso(),
            json.dumps(dict(details), separators=(",", ":")),
        ),
    )
