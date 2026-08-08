from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from zoneinfo import ZoneInfo

from statistics_snapshot import (
    PreparedSnapshot,
    assert_prepared_snapshot_unchanged,
    load_prepared_snapshot,
    snapshot_consumer_lock,
)


ARCHIVE_FORMAT_VERSION = 1
DATASET_SCHEMA_VERSION = 1
DEFAULT_SOURCE_DB = "/source/statistics.db"
DEFAULT_ARCHIVE_ROOT = "/archive"
DEFAULT_SNAPSHOT_HANDOFF_ROOT = "/snapshot-handoff"
DEFAULT_TIMEZONE = "Europe/Rome"
V2_ROLLOUT_DATE_STATE = "v2_collection_rollout_date"
GIB = 1024**3
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
DUCKDB_MEMORY = re.compile(r"^\d+(?:\.\d+)?(?:KB|MB|GB|TB)$", re.IGNORECASE)


@dataclass(frozen=True)
class DatasetSpec:
    name: str
    table: str
    partition_key: str
    source_partition_column: str | None
    primary_key: tuple[str, ...]
    policy: str


DATASETS: tuple[DatasetSpec, ...] = (
    DatasetSpec(
        "train_observations",
        "train_observations",
        "collection_date",
        "collection_date",
        ("service_date", "train_key", "observed_at", "collection_date"),
        "ended_day",
    ),
    DatasetSpec(
        "train_services",
        "train_services",
        "service_date",
        "service_date",
        ("service_date", "train_key"),
        "stable_service",
    ),
    DatasetSpec(
        "train_stop_events",
        "train_stop_events",
        "service_date",
        "service_date",
        ("service_date", "train_key", "stop_number"),
        "stable_service",
    ),
    DatasetSpec(
        "train_raw_payloads",
        "train_raw_payloads",
        "service_date",
        "service_date",
        ("service_date", "train_key"),
        "stable_service",
    ),
    DatasetSpec(
        "collector_runs",
        "collector_runs",
        "collection_date",
        "date",
        ("slot_at",),
        "ended_day",
    ),
    DatasetSpec(
        "snapshots",
        "snapshots",
        "collection_date",
        "date",
        ("id",),
        "ended_day",
    ),
    DatasetSpec(
        "station_stats",
        "station_stats",
        "collection_date",
        "date",
        ("date", "station_code"),
        "ended_day",
    ),
    DatasetSpec(
        "station_board_stats",
        "station_board_stats",
        "collection_date",
        "date",
        ("date", "station_code", "board_type"),
        "ended_day",
    ),
    DatasetSpec(
        "relation_stats",
        "relation_stats",
        "collection_date",
        "date",
        ("date", "relation_key"),
        "ended_day",
    ),
    DatasetSpec(
        "station_registry",
        "station_registry",
        "snapshot_date",
        None,
        ("station_code",),
        "dimension_snapshot",
    ),
)
DATASET_BY_NAME = {spec.name: spec for spec in DATASETS}


@dataclass(frozen=True)
class PublishedState:
    partitions: frozenset[tuple[int, str, str, str]]
    schema_fingerprints: dict[str, str]
    row_counts: dict[tuple[int, str, str, str], int]


@dataclass(frozen=True)
class ArchiveConfig:
    source_db: Path
    archive_root: Path
    as_of_date: date
    active_service_ttl_days: int
    safety_gib: float
    duckdb_memory_limit: str
    duckdb_threads: int
    ended_day_ready_hour: int = 2
    dimension_snapshot_date: date | None = None
    duckdb_max_temp_directory_size: str = "4GB"
    timezone_name: str = DEFAULT_TIMEZONE
    cadence_minutes: int = 30
    schedule_offset_minutes: int = 5
    finalize_time: str = "23:55"
    observation_retention_days: int = 30
    legacy_retention_days: int = 30
    service_retention_days: int = 90
    raw_payload_retention_days: int = 7
    include_raw_payloads: bool = False
    retention_reference_date: date | None = None
    prepared_snapshot: PreparedSnapshot | None = None

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace,
        *,
        prepared_snapshot: PreparedSnapshot | None = None,
    ) -> "ArchiveConfig":
        snapshot_policy = prepared_snapshot.policy if prepared_snapshot else None
        timezone_name = (
            snapshot_policy.timezone_name
            if snapshot_policy
            else os.environ.get("ARCHIVE_TIMEZONE", DEFAULT_TIMEZONE)
        )
        if timezone_name != DEFAULT_TIMEZONE and prepared_snapshot is None:
            raise ValueError(
                f"ARCHIVE_TIMEZONE must be {DEFAULT_TIMEZONE!r} to match the collector"
            )
        local_now: datetime | None = None
        if prepared_snapshot is None:
            try:
                local_now = datetime.now(ZoneInfo(timezone_name))
            except Exception as exc:
                raise ValueError(
                    f"invalid archive timezone {timezone_name!r}: {exc}"
                ) from exc
        ready_hour = _bounded_int(
            snapshot_policy.ended_day_ready_hour
            if snapshot_policy
            else os.environ.get("ARCHIVE_ENDED_DAY_READY_HOUR", "2"),
            name="ARCHIVE_ENDED_DAY_READY_HOUR",
            minimum=0,
            maximum=23,
        )
        explicit_as_of_text = args.as_of_date
        as_of_text = (
            explicit_as_of_text
            if snapshot_policy
            else explicit_as_of_text or os.environ.get("ARCHIVE_AS_OF_DATE")
        )
        if snapshot_policy:
            as_of_date = snapshot_policy.as_of_date
            if explicit_as_of_text and _parse_date(explicit_as_of_text) != as_of_date:
                raise ValueError(
                    "archive as-of date differs from the prepared snapshot receipt: "
                    f"{explicit_as_of_text!r} != {as_of_date.isoformat()!r}"
                )
        else:
            assert local_now is not None
            maximum_as_of_date = local_now.date()
            if local_now.hour < ready_hour:
                maximum_as_of_date -= timedelta(days=1)
            as_of_date = _parse_date(as_of_text) if as_of_text else maximum_as_of_date
            if as_of_date > maximum_as_of_date:
                raise ValueError(
                    f"archive as-of date {as_of_date} is not ready; latest safe date is "
                    f"{maximum_as_of_date}"
                )
        ttl_days = _bounded_int(
            snapshot_policy.active_service_ttl_days
            if snapshot_policy
            else os.environ.get("ARCHIVE_ACTIVE_SERVICE_TTL_DAYS", "7"),
            name="ARCHIVE_ACTIVE_SERVICE_TTL_DAYS",
            minimum=1,
            maximum=31,
        )
        safety_gib = _bounded_float(
            os.environ.get("ARCHIVE_SAFETY_GIB", "5"),
            name="ARCHIVE_SAFETY_GIB",
            minimum=1,
            maximum=100,
        )
        memory_limit = os.environ.get("ARCHIVE_DUCKDB_MEMORY_LIMIT", "256MB").upper()
        if not DUCKDB_MEMORY.fullmatch(memory_limit):
            raise ValueError(
                "ARCHIVE_DUCKDB_MEMORY_LIMIT must be a positive DuckDB size such as 384MB"
            )
        threads = _bounded_int(
            os.environ.get("ARCHIVE_DUCKDB_THREADS", "1"),
            name="ARCHIVE_DUCKDB_THREADS",
            minimum=1,
            maximum=8,
        )
        max_temp_size = os.environ.get(
            "ARCHIVE_DUCKDB_MAX_TEMP_DIRECTORY_SIZE", "4GB"
        ).upper()
        if not DUCKDB_MEMORY.fullmatch(max_temp_size):
            raise ValueError(
                "ARCHIVE_DUCKDB_MAX_TEMP_DIRECTORY_SIZE must be a positive DuckDB "
                "size such as 4GB"
            )
        cadence_minutes = _bounded_int(
            snapshot_policy.cadence_minutes
            if snapshot_policy
            else os.environ.get("ARCHIVE_CADENCE_MINUTES", "30"),
            name="ARCHIVE_CADENCE_MINUTES",
            minimum=1,
            maximum=1440,
        )
        schedule_offset = _bounded_int(
            snapshot_policy.schedule_offset_minutes
            if snapshot_policy
            else os.environ.get("ARCHIVE_SCHEDULE_OFFSET_MINUTES", "5"),
            name="ARCHIVE_SCHEDULE_OFFSET_MINUTES",
            minimum=0,
            maximum=59,
        )
        finalize_time = _parse_time(
            snapshot_policy.finalize_time
            if snapshot_policy
            else os.environ.get("ARCHIVE_FINALIZE_TIME", "23:55"),
            name="ARCHIVE_FINALIZE_TIME",
        )
        observation_retention_days = _bounded_int(
            snapshot_policy.observation_retention_days
            if snapshot_policy
            else os.environ.get("ARCHIVE_OBSERVATION_RETENTION_DAYS", "30"),
            name="ARCHIVE_OBSERVATION_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        legacy_retention_days = _bounded_int(
            snapshot_policy.legacy_retention_days
            if snapshot_policy
            else os.environ.get("ARCHIVE_LEGACY_RETENTION_DAYS", "30"),
            name="ARCHIVE_LEGACY_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        configured_service_retention_days = _bounded_int(
            snapshot_policy.service_retention_days
            if snapshot_policy
            else os.environ.get("ARCHIVE_SERVICE_RETENTION_DAYS", "90"),
            name="ARCHIVE_SERVICE_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        raw_payload_retention_days = _bounded_int(
            snapshot_policy.raw_payload_retention_days
            if snapshot_policy
            else os.environ.get("ARCHIVE_RAW_PAYLOAD_RETENTION_DAYS", "7"),
            name="ARCHIVE_RAW_PAYLOAD_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        include_raw_payloads = _strict_bool(
            os.environ.get("ARCHIVE_INCLUDE_RAW_PAYLOADS", "false"),
            name="ARCHIVE_INCLUDE_RAW_PAYLOADS",
        )
        service_retention_days = (
            configured_service_retention_days
            if snapshot_policy
            else max(
                configured_service_retention_days,
                observation_retention_days,
                raw_payload_retention_days,
                ttl_days,
            )
        )
        return cls(
            source_db=(
                prepared_snapshot.database_path
                if prepared_snapshot
                else Path(args.source_db or os.environ.get("SQLITE_PATH", DEFAULT_SOURCE_DB))
            ),
            archive_root=Path(
                args.archive_root or os.environ.get("ARCHIVE_ROOT", DEFAULT_ARCHIVE_ROOT)
            ),
            as_of_date=as_of_date,
            active_service_ttl_days=ttl_days,
            safety_gib=safety_gib,
            duckdb_memory_limit=memory_limit,
            duckdb_threads=threads,
            ended_day_ready_hour=ready_hour,
            dimension_snapshot_date=(
                snapshot_policy.dimension_snapshot_date
                if snapshot_policy
                else local_now.date() if local_now else as_of_date
            ),
            duckdb_max_temp_directory_size=max_temp_size,
            timezone_name=timezone_name,
            cadence_minutes=cadence_minutes,
            schedule_offset_minutes=schedule_offset,
            finalize_time=finalize_time,
            observation_retention_days=observation_retention_days,
            legacy_retention_days=legacy_retention_days,
            service_retention_days=service_retention_days,
            raw_payload_retention_days=raw_payload_retention_days,
            include_raw_payloads=include_raw_payloads,
            retention_reference_date=(
                snapshot_policy.retention_reference_date
                if snapshot_policy
                else local_now.date() if local_now else as_of_date
            ),
            prepared_snapshot=prepared_snapshot,
        )


def _parse_date(value: str) -> date:
    if not ISO_DATE.fullmatch(str(value or "")):
        raise ValueError(f"invalid date {value!r}; expected YYYY-MM-DD")
    return date.fromisoformat(value)


def _parse_time(value: str, *, name: str) -> str:
    try:
        hour_text, minute_text = str(value).split(":", 1)
        hour = int(hour_text)
        minute = int(minute_text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must use HH:MM") from exc
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError(f"{name} must use HH:MM")
    return f"{hour:02d}:{minute:02d}"


def _bounded_int(value: Any, *, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _bounded_float(value: Any, *, name: str, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
    return parsed


def _strict_bool(value: Any, *, name: str) -> bool:
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def configured_datasets(config: ArchiveConfig) -> tuple[DatasetSpec, ...]:
    if not config.include_raw_payloads:
        return tuple(spec for spec in DATASETS if spec.name != "train_raw_payloads")
    if config.raw_payload_retention_days <= config.active_service_ttl_days:
        raise ValueError(
            "ARCHIVE_INCLUDE_RAW_PAYLOADS requires raw payload retention to exceed "
            "the active service TTL so D+8 partitions remain recoverable"
        )
    return DATASETS


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    print(f"[statistics-archive] {message}", file=sys.stderr, flush=True)


@contextmanager
def archive_lock(root: Path):
    """Hold a non-blocking process lock for the archive publication boundary."""
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "archive.lock"
    handle = lock_path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("another statistics archive run is active") from exc
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("another statistics archive run is active") from exc
        yield
    finally:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def quote_literal(value: str | Path) -> str:
    text = str(value).replace("\\", "/")
    return "'" + text.replace("'", "''") + "'"


def open_source(path: Path, *, immutable: bool = False) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(f"statistics database does not exist: {path}")
    immutable_query = "&immutable=1" if immutable else ""
    uri = f"file:{path.resolve().as_posix()}?mode=ro{immutable_query}"
    conn = sqlite3.connect(uri, uri=True, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA busy_timeout=60000")
    return conn


@contextmanager
def open_archive_source(config: ArchiveConfig):
    prepared = config.prepared_snapshot
    if prepared is not None:
        assert_prepared_snapshot_unchanged(prepared)
    try:
        with closing(
            open_source(config.source_db, immutable=prepared is not None)
        ) as connection:
            yield connection
    finally:
        if prepared is not None:
            assert_prepared_snapshot_unchanged(prepared)


@contextmanager
def prepared_snapshot_consumer(snapshot: PreparedSnapshot | None):
    if snapshot is None:
        yield
        return
    handoff_root = snapshot.database_path.parent.parent
    with snapshot_consumer_lock(handoff_root):
        assert_prepared_snapshot_unchanged(snapshot)
        try:
            yield
        finally:
            assert_prepared_snapshot_unchanged(snapshot)


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({quote_identifier(table)})")}


def table_primary_key(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    columns = [
        (int(row[5]), str(row[1]))
        for row in conn.execute(f"PRAGMA table_info({quote_identifier(table)})")
        if int(row[5]) > 0
    ]
    return tuple(name for _, name in sorted(columns))


def validate_source_schema(conn: sqlite3.Connection) -> list[str]:
    tables = {
        str(row[0])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    required_tables = {spec.table for spec in DATASETS} | {
        "statistics_coverage_state",
        "statistics_schema_migrations",
    }
    missing_tables = sorted(required_tables - tables)
    if missing_tables:
        raise RuntimeError("source database is missing required tables: " + ", ".join(missing_tables))
    for spec in DATASETS:
        required_columns = set(spec.primary_key)
        if spec.source_partition_column:
            required_columns.add(spec.source_partition_column)
        missing_columns = required_columns - table_columns(conn, spec.table)
        if missing_columns:
            raise RuntimeError(
                f"source table {spec.table!r} is missing required columns: "
                + ", ".join(sorted(missing_columns))
            )
        actual_primary_key = table_primary_key(conn, spec.table)
        if actual_primary_key != spec.primary_key:
            raise RuntimeError(
                f"source table {spec.table!r} primary key is {actual_primary_key!r}; "
                f"expected {spec.primary_key!r}"
            )
    extra_required_columns = {
        "collector_runs": {"date", "slot_at", "status"},
        "snapshots": {"date", "captured_at", "status"},
        "statistics_coverage_state": {"name", "value"},
    }
    for table, required_columns in extra_required_columns.items():
        missing_columns = required_columns - table_columns(conn, table)
        if missing_columns:
            raise RuntimeError(
                f"source table {table!r} is missing required columns: "
                + ", ".join(sorted(missing_columns))
            )
    migrations = [
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM statistics_schema_migrations ORDER BY name"
        ).fetchall()
    ]
    if "v2-additive-storage" not in migrations:
        raise RuntimeError("source database has not applied v2-additive-storage")
    return migrations


def source_sizes(path: Path) -> dict[str, int]:
    return {
        "databaseBytes": path.stat().st_size,
        "walBytes": Path(f"{path}-wal").stat().st_size if Path(f"{path}-wal").exists() else 0,
        "shmBytes": Path(f"{path}-shm").stat().st_size if Path(f"{path}-shm").exists() else 0,
    }


def snapshot_provenance(snapshot: PreparedSnapshot | None) -> dict[str, Any]:
    if snapshot is None:
        return {}
    return {
        "snapshotId": snapshot.snapshot_id,
        "snapshotReceipt": {
            "receiptFile": snapshot.receipt_path.name,
            "receiptSha256": snapshot.receipt_sha256,
            "createdAt": snapshot.created_at,
            "databaseBytes": snapshot.database_bytes,
            "pageSize": snapshot.page_size,
            "pageCount": snapshot.page_count,
            "device": snapshot.device,
            "inode": snapshot.inode,
            "mtimeNs": snapshot.mtime_ns,
        },
    }


def assert_config_matches_prepared_snapshot(config: ArchiveConfig) -> None:
    snapshot = config.prepared_snapshot
    if snapshot is None:
        return
    policy = snapshot.policy
    expected = {
        "source_db": snapshot.database_path,
        "as_of_date": policy.as_of_date,
        "dimension_snapshot_date": policy.dimension_snapshot_date,
        "retention_reference_date": policy.retention_reference_date,
        "timezone_name": policy.timezone_name,
        "ended_day_ready_hour": policy.ended_day_ready_hour,
        "active_service_ttl_days": policy.active_service_ttl_days,
        "cadence_minutes": policy.cadence_minutes,
        "schedule_offset_minutes": policy.schedule_offset_minutes,
        "finalize_time": policy.finalize_time,
        "observation_retention_days": policy.observation_retention_days,
        "legacy_retention_days": policy.legacy_retention_days,
        "service_retention_days": policy.service_retention_days,
        "raw_payload_retention_days": policy.raw_payload_retention_days,
    }
    mismatches = [
        name for name, value in expected.items() if getattr(config, name) != value
    ]
    if mismatches:
        raise RuntimeError(
            "archive configuration differs from the prepared snapshot receipt: "
            + ", ".join(mismatches)
        )


def duckdb_size_bytes(value: str) -> int:
    match = DUCKDB_MEMORY.fullmatch(value)
    if match is None:
        raise ValueError(f"invalid DuckDB size {value!r}")
    unit = re.search(r"[A-Za-z]+$", value)
    if unit is None:
        raise ValueError(f"invalid DuckDB size {value!r}")
    number = float(value[: unit.start()])
    multiplier = {
        "KB": 1024,
        "MB": 1024**2,
        "GB": 1024**3,
        "TB": 1024**4,
    }[unit.group(0).upper()]
    return int(number * multiplier)


def required_free_bytes(config: ArchiveConfig, database_bytes: int) -> int:
    return int(
        database_bytes
        + duckdb_size_bytes(config.duckdb_max_temp_directory_size)
        + config.safety_gib * GIB
    )


def partition_cutoff(config: ArchiveConfig, spec: DatasetSpec) -> str | None:
    if spec.policy == "ended_day":
        return config.as_of_date.isoformat()
    if spec.policy == "stable_service":
        return (config.as_of_date - timedelta(days=config.active_service_ttl_days)).isoformat()
    return None


def coverage_rollout(conn: sqlite3.Connection) -> tuple[date | None, str | None]:
    row = conn.execute(
        "SELECT value FROM statistics_coverage_state WHERE name=?",
        (V2_ROLLOUT_DATE_STATE,),
    ).fetchone()
    value = str(row[0]) if row and row[0] else None
    if value is not None:
        return _parse_date(value), "statistics_coverage_state"
    fallback = conn.execute(
        "SELECT MIN(collection_date) FROM train_observations"
    ).fetchone()[0]
    if not fallback:
        return None, None
    return _parse_date(str(fallback)), "train_observations_min_fallback"


def coverage_rollout_date(conn: sqlite3.Connection) -> date | None:
    return coverage_rollout(conn)[0]


def date_range(start: date, end_exclusive: date) -> list[str]:
    if start >= end_exclusive:
        return []
    return [
        (start + timedelta(days=offset)).isoformat()
        for offset in range((end_exclusive - start).days)
    ]


def recoverable_calendar(
    conn: sqlite3.Connection,
    config: ArchiveConfig,
    spec: DatasetSpec,
) -> list[str]:
    if spec.policy not in {"ended_day", "stable_service"}:
        return []
    rollout_date = coverage_rollout_date(conn)
    if rollout_date is None:
        return []
    if spec.policy == "stable_service":
        retention_days = (
            config.raw_payload_retention_days
            if spec.name == "train_raw_payloads"
            else config.service_retention_days
        )
        end_exclusive = config.as_of_date - timedelta(
            days=config.active_service_ttl_days
        )
    else:
        retention_days = (
            config.observation_retention_days
            if spec.name == "train_observations"
            else config.legacy_retention_days
        )
        end_exclusive = config.as_of_date
    retention_reference = config.retention_reference_date or config.as_of_date
    recoverable_from = max(
        rollout_date,
        retention_reference - timedelta(days=retention_days),
    )
    return date_range(recoverable_from, end_exclusive)


def candidate_partitions(
    conn: sqlite3.Connection,
    config: ArchiveConfig,
    spec: DatasetSpec,
) -> list[str]:
    if spec.policy == "dimension_snapshot":
        count = conn.execute(
            f"SELECT COUNT(*) FROM {quote_identifier(spec.table)}"
        ).fetchone()[0]
        snapshot_date = config.dimension_snapshot_date or config.as_of_date
        return [snapshot_date.isoformat()] if count else []
    column = quote_identifier(spec.source_partition_column or "")
    cutoff = partition_cutoff(config, spec)
    rows = conn.execute(
        f"""
        SELECT DISTINCT {column}
        FROM {quote_identifier(spec.table)}
        WHERE {column} IS NOT NULL AND {column} <> '' AND {column} < ?
        ORDER BY {column}
        """,
        (cutoff,),
    ).fetchall()
    result: set[str] = set(recoverable_calendar(conn, config, spec))
    for row in rows:
        value = str(row[0])
        _parse_date(value)
        result.add(value)
    return sorted(result)


def published_partition_values(
    published_state: PublishedState,
    spec: DatasetSpec,
) -> set[str]:
    return {
        partition_value
        for schema_version, dataset, partition_key, partition_value in (
            published_state.partitions
        )
        if schema_version == DATASET_SCHEMA_VERSION
        and dataset == spec.name
        and partition_key == spec.partition_key
    }


def compact_date_ranges(values: Sequence[str]) -> list[dict[str, Any]]:
    parsed = sorted({_parse_date(value) for value in values})
    if not parsed:
        return []
    ranges: list[dict[str, Any]] = []
    start = parsed[0]
    previous = parsed[0]
    for current in parsed[1:]:
        if current == previous + timedelta(days=1):
            previous = current
            continue
        ranges.append(
            {
                "from": start.isoformat(),
                "to": previous.isoformat(),
                "days": (previous - start).days + 1,
            }
        )
        start = current
        previous = current
    ranges.append(
        {
            "from": start.isoformat(),
            "to": previous.isoformat(),
            "days": (previous - start).days + 1,
        }
    )
    return ranges


def historical_partition_gaps(
    conn: sqlite3.Connection,
    config: ArchiveConfig,
    spec: DatasetSpec,
    published_state: PublishedState,
    candidate_values: Sequence[str] | None = None,
) -> list[str]:
    if spec.policy not in {"ended_day", "stable_service"}:
        return []
    rollout_date = coverage_rollout_date(conn)
    end_exclusive = (
        config.as_of_date - timedelta(days=config.active_service_ttl_days)
        if spec.policy == "stable_service"
        else config.as_of_date
    )
    if rollout_date is None or rollout_date >= end_exclusive:
        return []
    expected = set(date_range(rollout_date, end_exclusive))
    recoverable_or_present = set(
        candidate_values
        if candidate_values is not None
        else candidate_partitions(conn, config, spec)
    )
    published = published_partition_values(published_state, spec)
    return sorted(expected - recoverable_or_present - published)


def scheduled_minutes(config: ArchiveConfig) -> list[int]:
    minutes: set[int] = set()
    minute = config.schedule_offset_minutes
    while minute < 24 * 60:
        minutes.add(minute)
        minute += config.cadence_minutes
    final_hour, final_minute = (int(value) for value in config.finalize_time.split(":"))
    minutes.add(final_hour * 60 + final_minute)
    return sorted(minutes)


def slot_utc_iso(day: date, minute: int, timezone_name: str) -> str:
    local_timezone = ZoneInfo(timezone_name)
    midnight = datetime.combine(day, datetime.min.time(), tzinfo=local_timezone)
    slot = midnight + timedelta(minutes=minute)
    return (
        slot.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def required_completion_minutes(config: ArchiveConfig) -> list[int]:
    minutes = scheduled_minutes(config)
    first_cadence_minute = config.schedule_offset_minutes
    final_hour, final_minute = (int(value) for value in config.finalize_time.split(":"))
    final_total_minutes = final_hour * 60 + final_minute
    gap_after_final = (
        first_cadence_minute + 24 * 60 - final_total_minutes
    ) % (24 * 60)
    if (
        final_total_minutes > first_cadence_minute
        and 0 < gap_after_final < config.cadence_minutes
    ):
        minutes = [minute for minute in minutes if minute != first_cadence_minute]
    return minutes


def collection_day_quality(
    conn: sqlite3.Connection,
    config: ArchiveConfig,
    value: str,
) -> dict[str, Any]:
    collection_date = _parse_date(value)
    scheduled = {
        slot_utc_iso(collection_date, minute, config.timezone_name)
        for minute in scheduled_minutes(config)
    }
    required = {
        slot_utc_iso(collection_date, minute, config.timezone_name)
        for minute in required_completion_minutes(config)
    }
    overlap = scheduled - required
    query_dates = [value]
    bridge_candidates: set[str] = set()
    if overlap:
        previous_day = collection_date - timedelta(days=1)
        final_hour, final_minute = (
            int(part) for part in config.finalize_time.split(":")
        )
        bridge_candidates = {
            *overlap,
            slot_utc_iso(
                previous_day,
                final_hour * 60 + final_minute,
                config.timezone_name,
            ),
        }
        query_dates.append(previous_day.isoformat())
    placeholders = ",".join("?" for _ in query_dates)
    successful_runs = {
        str(row[0])
        for row in conn.execute(
            f"SELECT slot_at FROM collector_runs "
            f"WHERE date IN ({placeholders}) AND status='success'",
            query_dates,
        ).fetchall()
    }
    successful_snapshots = {
        str(row[0])
        for row in conn.execute(
            f"SELECT captured_at FROM snapshots "
            f"WHERE date IN ({placeholders}) AND status='success'",
            query_dates,
        ).fetchall()
    }
    successful_both = successful_runs & successful_snapshots
    missing_runs = sorted(required - successful_runs)
    missing_snapshots = sorted(required - successful_snapshots)
    bridge_satisfied_by = sorted(bridge_candidates & successful_both)
    schedule_complete = (
        not missing_runs
        and not missing_snapshots
        and (not bridge_candidates or bool(bridge_satisfied_by))
    )
    observation_rows = int(
        conn.execute(
            "SELECT COUNT(*) FROM train_observations WHERE collection_date=?",
            (value,),
        ).fetchone()[0]
    )
    rollout_date, rollout_source = coverage_rollout(conn)
    if observation_rows == 0 or rollout_date is None or collection_date < rollout_date:
        coverage_status = "unavailable"
        comparison_eligible = False
        reason = "v2_not_available"
    elif collection_date == rollout_date:
        coverage_status = "partial"
        comparison_eligible = False
        reason = "partial_rollout_day"
    elif not schedule_complete:
        coverage_status = "partial"
        comparison_eligible = False
        reason = "incomplete_collection_day"
    else:
        coverage_status = "complete"
        comparison_eligible = True
        reason = None
    return {
        "date": value,
        "v2Available": observation_rows > 0,
        "observationRows": observation_rows,
        "coverageStatus": coverage_status,
        "comparisonEligible": comparison_eligible,
        "reason": reason,
        "scheduleComplete": schedule_complete,
        "scheduledSlotCount": len(scheduled),
        "requiredSlotCount": len(required),
        "missingCollectorRunSlots": missing_runs,
        "missingSnapshotSlots": missing_snapshots,
        "bridgeCandidates": sorted(bridge_candidates),
        "bridgeSatisfiedBy": bridge_satisfied_by,
        "rolloutDate": rollout_date.isoformat() if rollout_date else None,
        "rolloutSource": rollout_source,
    }


def summarize_collection_quality(items: Sequence[dict[str, Any]]) -> dict[str, Any]:
    counts = {"complete": 0, "partial": 0, "unavailable": 0}
    for item in items:
        status = str(item["coverageStatus"])
        counts[status] = counts.get(status, 0) + 1
    return {
        "dates": len(items),
        "complete": counts.get("complete", 0),
        "partial": counts.get("partial", 0),
        "unavailable": counts.get("unavailable", 0),
    }


def expected_relative_path(spec: DatasetSpec, partition_value: str) -> Path:
    return (
        Path("datasets")
        / f"schema=v{DATASET_SCHEMA_VERSION}"
        / f"dataset={spec.name}"
        / f"{spec.partition_key}={partition_value}"
        / "part-00000.parquet"
    )


def validated_manifest_items(
    root: Path,
    manifest_path: Path,
    payload: Any,
) -> list[tuple[dict[str, Any], DatasetSpec, str, Path, str]]:
    if not isinstance(payload, dict):
        raise RuntimeError(f"manifest root must be an object in {manifest_path}")
    if payload.get("formatVersion") != ARCHIVE_FORMAT_VERSION:
        raise RuntimeError(f"unsupported manifest format in {manifest_path}")
    if payload.get("datasetSchemaVersion") != DATASET_SCHEMA_VERSION:
        raise RuntimeError(f"unsupported dataset schema version in {manifest_path}")
    raw_items = payload.get("datasets")
    if not isinstance(raw_items, list) or not raw_items:
        raise RuntimeError(f"completed manifest has no dataset partitions: {manifest_path}")
    parsed: list[tuple[dict[str, Any], DatasetSpec, str, Path, str]] = []
    identities: set[tuple[str, str]] = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            raise RuntimeError(f"invalid dataset item in {manifest_path}")
        item: dict[str, Any] = raw_item
        dataset = str(item.get("dataset", ""))
        spec = DATASET_BY_NAME.get(dataset)
        if spec is None:
            raise RuntimeError(f"unknown dataset {dataset!r} in {manifest_path}")
        if item.get("datasetSchemaVersion") != DATASET_SCHEMA_VERSION:
            raise RuntimeError(f"invalid dataset schema version in {manifest_path}")
        if item.get("primaryKey") != list(spec.primary_key):
            raise RuntimeError(f"invalid primary key for {dataset!r} in {manifest_path}")
        partition = item.get("partition")
        if not isinstance(partition, dict) or len(partition) != 1:
            raise RuntimeError(f"invalid partition metadata in {manifest_path}")
        key, value = next(iter(partition.items()))
        if str(key) != spec.partition_key:
            raise RuntimeError(f"invalid partition key for {dataset!r} in {manifest_path}")
        partition_value = str(value)
        _parse_date(partition_value)
        identity = (dataset, partition_value)
        if identity in identities:
            raise RuntimeError(f"duplicate partition {identity!r} in {manifest_path}")
        identities.add(identity)
        expected_path = expected_relative_path(spec, partition_value).as_posix()
        if str(item.get("path", "")) != expected_path:
            raise RuntimeError(f"unexpected archive path for {dataset!r} in {manifest_path}")
        archive_path = safe_archive_path(root, expected_path)
        if not archive_path.is_file():
            raise RuntimeError(f"published archive file is missing: {archive_path}")
        try:
            rows = int(item["rows"])
            source_rows = int(item["sourceRows"])
            file_bytes = int(item["bytes"])
            duplicate_groups = int(item["duplicateKeyGroups"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"invalid numeric metadata in {manifest_path}") from exc
        if rows < 0 or source_rows != rows or file_bytes <= 0 or duplicate_groups != 0:
            raise RuntimeError(f"invalid row or file metadata in {manifest_path}")
        if archive_path.stat().st_size != file_bytes:
            raise RuntimeError(
                f"published archive file size differs from manifest: {archive_path}"
            )
        if rows == 0:
            if item.get("partitionMin") is not None or item.get("partitionMax") is not None:
                raise RuntimeError(f"invalid empty partition bounds in {manifest_path}")
        elif (
            str(item.get("partitionMin")) != partition_value
            or str(item.get("partitionMax")) != partition_value
        ):
            raise RuntimeError(f"invalid partition bounds in {manifest_path}")
        checksum = str(item.get("sha256", ""))
        if re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
            raise RuntimeError(f"invalid checksum metadata in {manifest_path}")
        fingerprint = str(item.get("schemaFingerprint", ""))
        if re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
            raise RuntimeError(f"invalid schema fingerprint in {manifest_path}")
        parsed.append((item, spec, partition_value, archive_path, fingerprint))
    return parsed


def load_published_state(root: Path) -> PublishedState:
    published: set[tuple[int, str, str, str]] = set()
    fingerprints: dict[str, str] = {}
    row_counts: dict[tuple[int, str, str, str], int] = {}
    manifest_root = root / "manifests"
    if not manifest_root.exists():
        return PublishedState(frozenset(), {}, {})
    for path in sorted(manifest_root.glob("*.complete.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot read published manifest {path}: {exc}") from exc
        for item, spec, partition_value, _, fingerprint in validated_manifest_items(
            root,
            path,
            payload,
        ):
            dataset = spec.name
            existing = fingerprints.get(dataset)
            if existing is not None and existing != fingerprint:
                raise RuntimeError(
                    f"dataset {dataset!r} has incompatible schemas across manifests"
                )
            fingerprints[dataset] = fingerprint
            identity = (
                DATASET_SCHEMA_VERSION,
                dataset,
                spec.partition_key,
                partition_value,
            )
            if identity in published:
                raise RuntimeError(f"partition {identity!r} is published more than once")
            published.add(identity)
            row_counts[identity] = int(item["sourceRows"])
    return PublishedState(frozenset(published), fingerprints, row_counts)


def assert_published_row_counts_unchanged(
    conn: sqlite3.Connection,
    spec: DatasetSpec,
    candidates: Sequence[str],
    published_state: PublishedState,
) -> None:
    if spec.policy == "dimension_snapshot" or spec.source_partition_column is None:
        return
    column = quote_identifier(spec.source_partition_column)
    table = quote_identifier(spec.table)
    for partition_value in candidates:
        identity = (
            DATASET_SCHEMA_VERSION,
            spec.name,
            spec.partition_key,
            partition_value,
        )
        if identity not in published_state.partitions:
            continue
        expected_rows = published_state.row_counts[identity]
        current_rows = int(
            conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {column}=?",
                (partition_value,),
            ).fetchone()[0]
        )
        if current_rows != expected_rows:
            raise RuntimeError(
                f"published partition {spec.name} {partition_value} changed from "
                f"{expected_rows} to {current_rows} live rows; archive partitions are "
                "immutable and require an explicit revision"
            )


def build_plan(config: ArchiveConfig) -> dict[str, Any]:
    with prepared_snapshot_consumer(config.prepared_snapshot):
        return _build_plan_unlocked(config)


def _build_plan_unlocked(config: ArchiveConfig) -> dict[str, Any]:
    assert_config_matches_prepared_snapshot(config)
    selected_datasets = configured_datasets(config)
    sizes = source_sizes(config.source_db)
    config.archive_root.mkdir(parents=True, exist_ok=True)
    disk_free = shutil.disk_usage(config.archive_root).free
    base_required_free = required_free_bytes(config, sizes["databaseBytes"])
    with open_archive_source(config) as conn:
        migrations = validate_source_schema(conn)
        published_state = load_published_state(config.archive_root)
        rollout_date, rollout_source = coverage_rollout(conn)
        datasets: list[dict[str, Any]] = []
        total_pending = 0
        total_historical_gaps = 0
        raw_payload_pending_bytes = 0
        pending_collection_quality: list[dict[str, Any]] = []
        for spec in selected_datasets:
            candidates = candidate_partitions(conn, config, spec)
            assert_published_row_counts_unchanged(
                conn,
                spec,
                candidates,
                published_state,
            )
            pending = [
                value
                for value in candidates
                if (
                    DATASET_SCHEMA_VERSION,
                    spec.name,
                    spec.partition_key,
                    value,
                )
                not in published_state.partitions
            ]
            historical_gaps = historical_partition_gaps(
                conn,
                config,
                spec,
                published_state,
                candidates,
            )
            total_pending += len(pending)
            total_historical_gaps += len(historical_gaps)
            if spec.name == "train_observations":
                pending_collection_quality = [
                    collection_day_quality(conn, config, value) for value in pending
                ]
            if spec.name == "train_raw_payloads" and pending:
                placeholders = ",".join("?" for _ in pending)
                raw_payload_pending_bytes = int(
                    conn.execute(
                        "SELECT COALESCE(SUM(length(payload)), 0) "
                        f"FROM train_raw_payloads WHERE service_date IN ({placeholders})",
                        pending,
                    ).fetchone()[0]
                )
            datasets.append(
                {
                    "dataset": spec.name,
                    "policy": spec.policy,
                    "partitionKey": spec.partition_key,
                    "eligible": len(candidates),
                    "published": len(candidates) - len(pending),
                    "pending": len(pending),
                    "oldestPending": pending[0] if pending else None,
                    "newestPending": pending[-1] if pending else None,
                    "historicalGapCount": len(historical_gaps),
                    "historicalGapRanges": compact_date_ranges(historical_gaps),
                }
            )
        quality_plan_items = [
            {
                "date": item["date"],
                "coverageStatus": item["coverageStatus"],
                "comparisonEligible": item["comparisonEligible"],
                "reason": item["reason"],
                "scheduleComplete": item["scheduleComplete"],
                "observationRows": item["observationRows"],
                "missingCollectorRunSlotCount": len(
                    item["missingCollectorRunSlots"]
                ),
                "missingSnapshotSlotCount": len(item["missingSnapshotSlots"]),
                "bridgeComplete": bool(item["bridgeSatisfiedBy"])
                or not item["bridgeCandidates"],
            }
            for item in pending_collection_quality
        ]
    raw_payload_capacity_reserve = (
        max(1024**2, (raw_payload_pending_bytes * 11 + 9) // 10)
        if raw_payload_pending_bytes
        else 0
    )
    required_free = base_required_free + raw_payload_capacity_reserve
    return {
        "mode": "plan",
        "formatVersion": ARCHIVE_FORMAT_VERSION,
        "datasetSchemaVersion": DATASET_SCHEMA_VERSION,
        "asOfDate": config.as_of_date.isoformat(),
        "activeServiceTtlDays": config.active_service_ttl_days,
        "endedDayReadyHour": config.ended_day_ready_hour,
        "retentionReferenceDate": (
            config.retention_reference_date or config.as_of_date
        ).isoformat(),
        "legacyRetentionDays": config.legacy_retention_days,
        "observationRetentionDays": config.observation_retention_days,
        "serviceRetentionDays": config.service_retention_days,
        "rawPayloadRetentionDays": config.raw_payload_retention_days,
        "includeRawPayloads": config.include_raw_payloads,
        "rawPayloadPendingBytes": raw_payload_pending_bytes,
        "rawPayloadCapacityReserveBytes": raw_payload_capacity_reserve,
        "coverageRolloutDate": rollout_date.isoformat() if rollout_date else None,
        "coverageRolloutSource": rollout_source,
        "dimensionSnapshotDate": (
            config.dimension_snapshot_date or config.as_of_date
        ).isoformat(),
        **snapshot_provenance(config.prepared_snapshot),
        **sizes,
        "diskFreeBytes": disk_free,
        "duckdbMaxTempBytes": duckdb_size_bytes(
            config.duckdb_max_temp_directory_size
        ),
        "requiredFreeBytes": required_free,
        "capacityOk": disk_free >= required_free,
        "migrations": migrations,
        "pendingPartitions": total_pending,
        "continuityOk": total_historical_gaps == 0,
        "historicalPartitionGapCount": total_historical_gaps,
        "collectionDayQuality": {
            **summarize_collection_quality(pending_collection_quality),
            "items": quality_plan_items,
        },
        "datasets": datasets,
    }


def create_snapshot(source_path: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".partial")
    partial.unlink(missing_ok=True)
    seen = -1

    def progress(status: int, remaining: int, total: int) -> None:
        nonlocal seen
        if total <= 0:
            return
        bucket = min(10, int(10 * (total - remaining) / total))
        if bucket > seen or remaining == 0:
            seen = bucket
            log(f"snapshot {bucket * 10}% ({total - remaining}/{total} pages)")

    log("creating a consistent SQLite Backup API snapshot")
    with closing(open_source(source_path)) as source, closing(
        sqlite3.connect(partial, timeout=60)
    ) as target:
        source.backup(target, pages=16384, progress=progress, sleep=0.1)
        target.commit()
    fsync_file(partial)
    os.replace(partial, destination)
    fsync_directory(destination.parent)
    with closing(
        sqlite3.connect(
            f"file:{destination.resolve().as_posix()}?mode=ro&immutable=1", uri=True
        )
    ) as check:
        if check.execute("PRAGMA page_count").fetchone()[0] <= 0:
            raise RuntimeError("snapshot page count is zero")
        validate_source_schema(check)
    log("SQLite snapshot is readable")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_file(path: Path) -> None:
    with path.open("r+b") as handle:
        os.fsync(handle.fileno())


def fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def schema_fingerprint(
    description: Iterable[Sequence[Any]],
    spec: DatasetSpec,
) -> str:
    payload = {
        "datasetSchemaVersion": DATASET_SCHEMA_VERSION,
        "dataset": spec.name,
        "partitionKey": spec.partition_key,
        "primaryKey": list(spec.primary_key),
        "columns": [[str(value) for value in row] for row in description],
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def parquet_scan(path: Path) -> str:
    # The partition column is already present in every file. Disable DuckDB's
    # automatic Hive path inference so it cannot add or coerce the same column.
    return f"read_parquet({quote_literal(path.resolve())}, hive_partitioning=false)"


def _import_duckdb():
    try:
        import duckdb  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "DuckDB is not installed; run this command with the statistics archive image"
        ) from exc
    return duckdb


def open_duckdb(config: ArchiveConfig, work_root: Path):
    duckdb = _import_duckdb()
    temp_root = work_root / "duckdb-temp"
    temp_root.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(
        database=":memory:",
        config={
            "memory_limit": config.duckdb_memory_limit,
            "threads": str(config.duckdb_threads),
            "temp_directory": str(temp_root),
            "max_temp_directory_size": config.duckdb_max_temp_directory_size,
            "preserve_insertion_order": "false",
        },
    )
    try:
        connection.execute("LOAD sqlite")
    except Exception as exc:
        connection.close()
        raise RuntimeError(
            "DuckDB sqlite extension is unavailable; it must be installed in the archive image"
        ) from exc
    return duckdb, connection


def source_query(spec: DatasetSpec, partition_value: str) -> str:
    table = f"source.{quote_identifier(spec.table)}"
    if spec.source_partition_column:
        projection = "*"
        if spec.source_partition_column != spec.partition_key:
            projection += (
                f", {quote_identifier(spec.source_partition_column)} AS "
                f"{quote_identifier(spec.partition_key)}"
            )
        return (
            f"SELECT {projection} FROM {table} WHERE "
            f"{quote_identifier(spec.source_partition_column)}={quote_literal(partition_value)}"
        )
    return (
        f"SELECT *, {quote_literal(partition_value)} AS "
        f"{quote_identifier(spec.partition_key)} FROM {table}"
    )


def duplicate_group_count(connection: Any, parquet_path: Path, keys: Sequence[str]) -> int:
    key_list = ", ".join(quote_identifier(key) for key in keys)
    query = f"""
        SELECT COUNT(*)
        FROM (
            SELECT {key_list}
            FROM {parquet_scan(parquet_path)}
            GROUP BY {key_list}
            HAVING COUNT(*) > 1
        ) duplicates
    """
    return int(connection.execute(query).fetchone()[0])


def validate_export(
    connection: Any,
    spec: DatasetSpec,
    partition_value: str,
    parquet_path: Path,
    source_rows: int,
) -> dict[str, Any]:
    parquet_rows = int(
        connection.execute(f"SELECT COUNT(*) FROM {parquet_scan(parquet_path)}").fetchone()[0]
    )
    if parquet_rows != source_rows:
        raise RuntimeError(
            f"{spec.name} {partition_value}: source rows {source_rows} != parquet rows {parquet_rows}"
        )
    duplicates = duplicate_group_count(connection, parquet_path, spec.primary_key)
    if duplicates:
        raise RuntimeError(
            f"{spec.name} {partition_value}: found {duplicates} duplicate primary-key groups"
        )
    min_value, max_value = connection.execute(
        f"SELECT MIN({quote_identifier(spec.partition_key)}), "
        f"MAX({quote_identifier(spec.partition_key)}) FROM {parquet_scan(parquet_path)}"
    ).fetchone()
    if source_rows == 0:
        if min_value is not None or max_value is not None:
            raise RuntimeError(
                f"{spec.name} {partition_value}: empty partition has unexpected "
                f"values {min_value!r}..{max_value!r}"
            )
    elif str(min_value) != partition_value or str(max_value) != partition_value:
        raise RuntimeError(
            f"{spec.name} {partition_value}: partition values are {min_value!r}..{max_value!r}"
        )
    description = connection.execute(
        f"DESCRIBE SELECT * FROM {parquet_scan(parquet_path)}"
    ).fetchall()
    return {
        "rows": parquet_rows,
        "sourceRows": source_rows,
        "duplicateKeyGroups": duplicates,
        "partitionMin": str(min_value) if min_value is not None else None,
        "partitionMax": str(max_value) if max_value is not None else None,
        "bytes": parquet_path.stat().st_size,
        "sha256": sha256_file(parquet_path),
        "schemaFingerprint": schema_fingerprint(description, spec),
    }


def export_partition(
    connection: Any,
    work_root: Path,
    spec: DatasetSpec,
    partition_value: str,
) -> tuple[Path, dict[str, Any]]:
    query = source_query(spec, partition_value)
    source_rows = int(connection.execute(f"SELECT COUNT(*) FROM ({query}) source_rows").fetchone()[0])
    relative_path = expected_relative_path(spec, partition_value)
    output_path = work_root / relative_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    log(f"exporting {spec.name} {partition_value} ({source_rows} rows)")
    connection.execute(
        f"COPY ({query}) TO {quote_literal(output_path.resolve())} "
        "(FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    metadata = validate_export(
        connection,
        spec,
        partition_value,
        output_path,
        source_rows,
    )
    metadata.update(
        {
            "dataset": spec.name,
            "datasetSchemaVersion": DATASET_SCHEMA_VERSION,
            "partition": {spec.partition_key: partition_value},
            "path": relative_path.as_posix(),
            "primaryKey": list(spec.primary_key),
        }
    )
    return output_path, metadata


def orphan_count(connection: Any, table: str, partition_column: str, value: str) -> int:
    return int(
        connection.execute(
            f"""
            SELECT COUNT(*)
            FROM source.{quote_identifier(table)} child
            LEFT JOIN source.train_services service
              ON service.service_date=child.service_date
             AND service.train_key=child.train_key
            WHERE child.{quote_identifier(partition_column)}={quote_literal(value)}
              AND service.train_key IS NULL
            """
        ).fetchone()[0]
    )


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    with partial.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(partial, path)
    fsync_directory(path.parent)


def validate_output_schemas(
    outputs: Sequence[tuple[Path, dict[str, Any]]],
    published_state: PublishedState,
) -> None:
    expected = dict(published_state.schema_fingerprints)
    for _, metadata in outputs:
        dataset = str(metadata["dataset"])
        fingerprint = str(metadata["schemaFingerprint"])
        existing = expected.get(dataset)
        if existing is not None and existing != fingerprint:
            raise RuntimeError(
                f"dataset {dataset!r} schema changed; bump DATASET_SCHEMA_VERSION "
                "before publishing new partitions"
            )
        expected[dataset] = fingerprint


def archive_run(config: ArchiveConfig) -> dict[str, Any]:
    with prepared_snapshot_consumer(config.prepared_snapshot):
        with archive_lock(config.archive_root):
            return _archive_run_locked(config)


def _archive_run_locked(config: ArchiveConfig) -> dict[str, Any]:
    plan = _build_plan_unlocked(config)
    if not plan["capacityOk"]:
        raise RuntimeError(
            "insufficient free space: "
            f"need {plan['requiredFreeBytes']} bytes, have {plan['diskFreeBytes']} bytes"
        )
    if plan["pendingPartitions"] == 0:
        return {**plan, "mode": "run", "status": "noop", "publishedPartitions": 0}

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    work_root = config.archive_root / "work" / run_id
    work_root.mkdir(parents=True, exist_ok=False)
    prepared = config.prepared_snapshot
    if prepared is not None:
        assert_prepared_snapshot_unchanged(prepared)
        snapshot_path = prepared.database_path
    else:
        snapshot_path = work_root / "source.db"
        create_snapshot(config.source_db, snapshot_path)

    published_state = load_published_state(config.archive_root)
    selected_datasets = configured_datasets(config)
    duckdb, connection = open_duckdb(config, work_root)
    outputs: list[tuple[Path, dict[str, Any]]] = []
    snapshot_candidates: dict[str, list[str]] = {}
    try:
        connection.execute(
            f"ATTACH {quote_literal(snapshot_path.resolve())} AS source (TYPE sqlite, READ_ONLY)"
        )
        if prepared is not None:
            assert_prepared_snapshot_unchanged(prepared)
        with closing(
            sqlite3.connect(
                f"file:{snapshot_path.resolve().as_posix()}?mode=ro&immutable=1",
                uri=True,
            )
        ) as snapshot:
            for spec in selected_datasets:
                candidates = candidate_partitions(snapshot, config, spec)
                assert_published_row_counts_unchanged(
                    snapshot,
                    spec,
                    candidates,
                    published_state,
                )
                snapshot_candidates[spec.name] = candidates
                for partition_value in candidates:
                    identity = (
                        DATASET_SCHEMA_VERSION,
                        spec.name,
                        spec.partition_key,
                        partition_value,
                    )
                    if identity in published_state.partitions:
                        continue
                    if spec.name == "train_observations":
                        orphans = orphan_count(
                            connection, spec.table, "collection_date", partition_value
                        )
                        if orphans:
                            raise RuntimeError(
                                f"{spec.name} {partition_value}: found {orphans} orphan rows"
                            )
                    elif spec.name in {"train_stop_events", "train_raw_payloads"}:
                        orphans = orphan_count(
                            connection, spec.table, "service_date", partition_value
                        )
                        if orphans:
                            raise RuntimeError(
                                f"{spec.name} {partition_value}: found {orphans} orphan rows"
                            )
                    outputs.append(
                        export_partition(connection, work_root, spec, partition_value)
                    )
    finally:
        connection.close()
        if prepared is not None:
            assert_prepared_snapshot_unchanged(prepared)

    if not outputs:
        raise RuntimeError(
            "archive plan had pending partitions but the SQLite snapshot produced none"
        )

    snapshot_uri = f"file:{snapshot_path.resolve().as_posix()}?mode=ro&immutable=1"
    with closing(sqlite3.connect(snapshot_uri, uri=True)) as snapshot:
        page_size = int(snapshot.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(snapshot.execute("PRAGMA page_count").fetchone()[0])
        migrations = validate_source_schema(snapshot)
        rollout_date, rollout_source = coverage_rollout(snapshot)
        observation_dates = sorted(
            str(metadata["partition"]["collection_date"])
            for _, metadata in outputs
            if metadata["dataset"] == "train_observations"
        )
        collection_quality_items = [
            collection_day_quality(snapshot, config, value)
            for value in observation_dates
        ]
        historical_gap_items: list[dict[str, Any]] = []
        for spec in selected_datasets:
            historical_gaps = historical_partition_gaps(
                snapshot,
                config,
                spec,
                published_state,
                snapshot_candidates.get(spec.name),
            )
            if historical_gaps:
                historical_gap_items.append(
                    {
                        "dataset": spec.name,
                        "partitionKey": spec.partition_key,
                        "count": len(historical_gaps),
                        "ranges": compact_date_ranges(historical_gaps),
                    }
                )
    if prepared is not None:
        assert_prepared_snapshot_unchanged(prepared)

    validate_output_schemas(outputs, published_state)
    manifest_items: list[dict[str, Any]] = []
    for work_path, metadata in outputs:
        final_path = safe_archive_path(config.archive_root, str(metadata["path"]))
        final_path.parent.mkdir(parents=True, exist_ok=True)
        fsync_file(work_path)
        os.replace(work_path, final_path)
        fsync_directory(final_path.parent)
        manifest_items.append(metadata)

    source_metadata = source_sizes(config.source_db)
    if prepared is not None:
        assert_prepared_snapshot_unchanged(prepared)
    manifest = {
        "formatVersion": ARCHIVE_FORMAT_VERSION,
        "datasetSchemaVersion": DATASET_SCHEMA_VERSION,
        "runId": run_id,
        "createdAt": utc_now_iso(),
        "asOfDate": config.as_of_date.isoformat(),
        **snapshot_provenance(prepared),
        "sourceSchemaVersion": 2,
        "source": {
            **source_metadata,
            "snapshotBytes": snapshot_path.stat().st_size,
            "pageSize": page_size,
            "pageCount": page_count,
            "migrations": migrations,
        },
        "policy": {
            "activeServiceTtlDays": config.active_service_ttl_days,
            "endedDayExclusiveCutoff": config.as_of_date.isoformat(),
            "stableServiceExclusiveCutoff": (
                config.as_of_date - timedelta(days=config.active_service_ttl_days)
            ).isoformat(),
            "endedDayReadyHour": config.ended_day_ready_hour,
            "retentionReferenceDate": (
                config.retention_reference_date or config.as_of_date
            ).isoformat(),
            "legacyRetentionDays": config.legacy_retention_days,
            "observationRetentionDays": config.observation_retention_days,
            "serviceRetentionDays": config.service_retention_days,
            "rawPayloadRetentionDays": config.raw_payload_retention_days,
            "includeRawPayloads": config.include_raw_payloads,
            "timezone": config.timezone_name,
            "cadenceMinutes": config.cadence_minutes,
            "scheduleOffsetMinutes": config.schedule_offset_minutes,
            "finalizeTime": config.finalize_time,
        },
        "coverage": {
            "rolloutDate": rollout_date.isoformat() if rollout_date else None,
            "rolloutSource": rollout_source,
            "collectionDayQuality": {
                **summarize_collection_quality(collection_quality_items),
                "items": collection_quality_items,
            },
        },
        "continuity": {
            "ok": not historical_gap_items,
            "historicalPartitionGapCount": sum(
                int(item["count"]) for item in historical_gap_items
            ),
            "historicalPartitionGaps": historical_gap_items,
        },
        "duckdbVersion": duckdb.__version__,
        "datasets": manifest_items,
    }
    if prepared is not None:
        assert_prepared_snapshot_unchanged(prepared)
    manifest_path = config.archive_root / "manifests" / f"{run_id}.complete.json"
    atomic_json(manifest_path, manifest)
    shutil.rmtree(work_root)
    if historical_gap_items:
        log(
            "warning: published recoverable partitions but recorded "
            f"{sum(int(item['count']) for item in historical_gap_items)} "
            "historical partition gaps outside live retention"
        )
    log(f"published {len(manifest_items)} partitions in {manifest_path.name}")
    return {
        "mode": "run",
        "status": "success",
        "runId": run_id,
        "manifest": manifest_path.relative_to(config.archive_root).as_posix(),
        "publishedPartitions": len(manifest_items),
        "parquetBytes": sum(int(item["bytes"]) for item in manifest_items),
        "sourceRows": sum(int(item["sourceRows"]) for item in manifest_items),
        "continuityOk": not historical_gap_items,
        "historicalPartitionGapCount": sum(
            int(item["count"]) for item in historical_gap_items
        ),
        **snapshot_provenance(prepared),
    }


def safe_archive_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    try:
        candidate.relative_to(resolved_root)
    except ValueError as exc:
        raise RuntimeError(f"manifest path escapes archive root: {relative!r}") from exc
    return candidate


def manifest_snapshot_provenance(
    payload: dict[str, Any], manifest_path: Path
) -> dict[str, Any]:
    snapshot_id = payload.get("snapshotId")
    receipt = payload.get("snapshotReceipt")
    if snapshot_id is None and receipt is None:
        # Format-v1 manifests published before prepared snapshots remain valid.
        return {}
    if not isinstance(snapshot_id, str) or not snapshot_id:
        raise RuntimeError(f"invalid snapshot ID in {manifest_path}")
    if not isinstance(receipt, dict):
        raise RuntimeError(f"invalid snapshot receipt metadata in {manifest_path}")
    receipt_file = receipt.get("receiptFile")
    if (
        not isinstance(receipt_file, str)
        or receipt_file != f"{snapshot_id}.ready.json"
    ):
        raise RuntimeError(f"invalid snapshot receipt file in {manifest_path}")
    if re.fullmatch(r"[0-9a-f]{64}", str(receipt.get("receiptSha256", ""))) is None:
        raise RuntimeError(f"invalid snapshot receipt checksum in {manifest_path}")
    if not isinstance(receipt.get("createdAt"), str) or not UTC_TIMESTAMP.fullmatch(
        receipt["createdAt"]
    ):
        raise RuntimeError(f"invalid snapshot receipt creation time in {manifest_path}")
    for field in ("databaseBytes", "pageSize", "pageCount"):
        if not isinstance(receipt.get(field), int) or int(receipt[field]) <= 0:
            raise RuntimeError(
                f"invalid snapshot receipt {field} metadata in {manifest_path}"
            )
    for field in ("device", "inode", "mtimeNs"):
        if not isinstance(receipt.get(field), int) or int(receipt[field]) < 0:
            raise RuntimeError(
                f"invalid snapshot receipt {field} metadata in {manifest_path}"
            )
    if receipt["databaseBytes"] != receipt["pageSize"] * receipt["pageCount"]:
        raise RuntimeError(f"inconsistent snapshot receipt metadata in {manifest_path}")
    return {"snapshotId": snapshot_id, "snapshotReceipt": receipt}


def verify_manifest(config: ArchiveConfig, manifest_path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read published manifest {manifest_path}: {exc}") from exc
    provenance = manifest_snapshot_provenance(payload, manifest_path)
    parsed_items = validated_manifest_items(
        config.archive_root,
        manifest_path,
        payload,
    )
    checked = 0
    checked_bytes = 0
    # Verification must never mutate the archive it is proving. Keep DuckDB
    # spill outside archive_root so a restored copy can be mounted read-only.
    with tempfile.TemporaryDirectory(prefix="statistics-archive-verify-") as temporary:
        _, connection = open_duckdb(config, Path(temporary))
        try:
            for item, spec, _, path, _ in parsed_items:
                if sha256_file(path) != item["sha256"]:
                    raise RuntimeError(f"archive checksum differs from manifest: {path}")
                rows = int(
                    connection.execute(
                        f"SELECT COUNT(*) FROM {parquet_scan(path)}"
                    ).fetchone()[0]
                )
                if rows != int(item["rows"]):
                    raise RuntimeError(f"archive row count differs from manifest: {path}")
                duplicates = duplicate_group_count(connection, path, item["primaryKey"])
                if duplicates:
                    raise RuntimeError(f"archive contains duplicate primary keys: {path}")
                partition = item.get("partition") or {}
                if len(partition) != 1:
                    raise RuntimeError(f"invalid partition metadata in {manifest_path}")
                key, expected = next(iter(partition.items()))
                minimum, maximum = connection.execute(
                    f"SELECT MIN({quote_identifier(key)}), MAX({quote_identifier(key)}) "
                    f"FROM {parquet_scan(path)}"
                ).fetchone()
                if rows == 0:
                    if minimum is not None or maximum is not None:
                        raise RuntimeError(
                            f"empty archive partition contains partition values: {path}"
                        )
                    if (
                        item.get("partitionMin") is not None
                        or item.get("partitionMax") is not None
                    ):
                        raise RuntimeError(
                            f"empty archive partition metadata differs from manifest: {path}"
                        )
                else:
                    if str(minimum) != str(expected) or str(maximum) != str(expected):
                        raise RuntimeError(
                            f"archive partition value differs from manifest: {path}"
                        )
                    if str(item.get("partitionMin")) != str(expected) or str(
                        item.get("partitionMax")
                    ) != str(expected):
                        raise RuntimeError(
                            f"archive partition bounds differ from manifest: {path}"
                        )
                description = connection.execute(
                    f"DESCRIBE SELECT * FROM {parquet_scan(path)}"
                ).fetchall()
                if schema_fingerprint(description, spec) != item.get(
                    "schemaFingerprint"
                ):
                    raise RuntimeError(f"archive schema differs from manifest: {path}")
                checked += 1
                checked_bytes += path.stat().st_size
        finally:
            connection.close()
    return {
        "manifest": manifest_path.relative_to(config.archive_root).as_posix(),
        "runId": payload.get("runId"),
        "partitions": checked,
        "bytes": checked_bytes,
        **provenance,
    }


def verify_archives(config: ArchiveConfig, *, verify_all: bool = False) -> dict[str, Any]:
    manifest_root = config.archive_root / "manifests"
    manifests = sorted(manifest_root.glob("*.complete.json")) if manifest_root.exists() else []
    if not manifests:
        raise RuntimeError("no completed archive manifests found")
    # Parse every completed manifest before selecting checksum depth. This keeps
    # verify and plan aligned on path, partition, primary-key, and cross-run
    # schema invariants even when only the newest files are hashed.
    load_published_state(config.archive_root)
    selected = manifests if verify_all else manifests[-1:]
    results = [verify_manifest(config, path) for path in selected]
    return {
        "mode": "verify",
        "status": "success",
        "manifests": results,
        "verifiedManifests": len(results),
        "verifiedPartitions": sum(item["partitions"] for item in results),
        "verifiedBytes": sum(item["bytes"] for item in results),
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Create and verify read-only BelloTreno SQLite-to-Parquet archives."
    )
    result.add_argument("--source-db", help="SQLite database path")
    result.add_argument("--archive-root", help="archive output directory")
    result.add_argument("--as-of-date", help="policy date in YYYY-MM-DD")
    subparsers = result.add_subparsers(dest="command", required=True)
    plan = subparsers.add_parser("plan", help="show eligible and pending partitions")
    plan.add_argument("--snapshot-id", help="prepared snapshot receipt ID")
    run = subparsers.add_parser("run", help="export, validate, and publish a prepared snapshot")
    run.add_argument("--snapshot-id", help="prepared snapshot receipt ID")
    verify = subparsers.add_parser("verify", help="verify the latest completed manifest")
    verify.add_argument("--all", action="store_true", help="verify every completed manifest")
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        prepared_snapshot: PreparedSnapshot | None = None
        if args.command in {"plan", "run"}:
            snapshot_id = args.snapshot_id or os.environ.get("ARCHIVE_SNAPSHOT_ID")
            if not snapshot_id:
                raise ValueError(
                    "plan and run require --snapshot-id or ARCHIVE_SNAPSHOT_ID"
                )
            handoff_root = Path(
                os.environ.get(
                    "SNAPSHOT_HANDOFF_ROOT", DEFAULT_SNAPSHOT_HANDOFF_ROOT
                )
            )
            max_age_hours = _bounded_int(
                os.environ.get("ARCHIVE_SNAPSHOT_MAX_AGE_HOURS", "48"),
                name="ARCHIVE_SNAPSHOT_MAX_AGE_HOURS",
                minimum=1,
                maximum=8760,
            )
            prepared_snapshot = load_prepared_snapshot(
                handoff_root,
                snapshot_id,
                max_age_hours=max_age_hours,
            )
        config = ArchiveConfig.from_args(
            args,
            prepared_snapshot=prepared_snapshot,
        )
        if args.command == "plan":
            result = build_plan(config)
        elif args.command == "run":
            result = archive_run(config)
        else:
            result = verify_archives(config, verify_all=bool(args.all))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        log(f"failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
