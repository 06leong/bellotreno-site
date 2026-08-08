from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import uuid
from calendar import monthrange
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SNAPSHOT_FORMAT_VERSION = 1
DEFAULT_HANDOFF_ROOT = "/snapshot-handoff"
DEFAULT_SOURCE_DB = "/data/statistics.db"
DEFAULT_TIMEZONE = "Europe/Rome"
DEFAULT_MAX_AGE_HOURS = 48
GIB = 1024**3
SNAPSHOT_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{12}$")
UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FINALIZE_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

ProgressCallback = Callable[[int, int], None]
StageHook = Callable[[str], None]


@dataclass(frozen=True)
class SnapshotPolicy:
    as_of_date: date
    dimension_snapshot_date: date
    retention_reference_date: date
    timezone_name: str
    ended_day_ready_hour: int
    active_service_ttl_days: int
    cadence_minutes: int
    schedule_offset_minutes: int
    finalize_time: str
    observation_retention_days: int
    legacy_retention_days: int
    service_retention_days: int
    raw_payload_retention_days: int

    @classmethod
    def from_environment(
        cls,
        *,
        created_at: datetime,
        as_of_date: date | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> "SnapshotPolicy":
        env = os.environ if environment is None else environment
        timezone_name = env.get("SNAPSHOT_TIMEZONE", env.get("TZ", DEFAULT_TIMEZONE))
        if timezone_name != DEFAULT_TIMEZONE:
            raise ValueError(
                f"SNAPSHOT_TIMEZONE must be {DEFAULT_TIMEZONE!r} to match the collector"
            )
        ready_hour = _bounded_int(
            env.get("SNAPSHOT_ENDED_DAY_READY_HOUR", "2"),
            name="SNAPSHOT_ENDED_DAY_READY_HOUR",
            minimum=0,
            maximum=23,
        )
        local_now = _rome_local_datetime(created_at)
        maximum_as_of = local_now.date()
        if local_now.hour < ready_hour:
            maximum_as_of -= timedelta(days=1)
        selected_as_of = as_of_date or maximum_as_of
        if selected_as_of > maximum_as_of:
            raise ValueError(
                f"snapshot as-of date {selected_as_of} is not ready; latest safe date is "
                f"{maximum_as_of}"
            )

        active_ttl = _bounded_int(
            env.get("COLLECTOR_ACTIVE_SERVICE_TTL_DAYS", "7"),
            name="COLLECTOR_ACTIVE_SERVICE_TTL_DAYS",
            minimum=1,
            maximum=31,
        )
        observation_retention = _bounded_int(
            env.get("V2_OBSERVATION_RETENTION_DAYS", "30"),
            name="V2_OBSERVATION_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        legacy_retention = _bounded_int(
            env.get("RETENTION_DAYS", "30"),
            name="RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        raw_retention = _bounded_int(
            env.get("RAW_PAYLOAD_RETENTION_DAYS", "7"),
            name="RAW_PAYLOAD_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        configured_service_retention = _bounded_int(
            env.get("V2_SERVICE_RETENTION_DAYS", "90"),
            name="V2_SERVICE_RETENTION_DAYS",
            minimum=1,
            maximum=3650,
        )
        service_retention = max(
            configured_service_retention,
            observation_retention,
            raw_retention,
            active_ttl,
        )
        policy = cls(
            as_of_date=selected_as_of,
            dimension_snapshot_date=local_now.date(),
            retention_reference_date=local_now.date(),
            timezone_name=timezone_name,
            ended_day_ready_hour=ready_hour,
            active_service_ttl_days=active_ttl,
            cadence_minutes=_bounded_int(
                env.get("COLLECTOR_INTERVAL_MINUTES", "30"),
                name="COLLECTOR_INTERVAL_MINUTES",
                minimum=1,
                maximum=1440,
            ),
            schedule_offset_minutes=_bounded_int(
                env.get("COLLECTOR_SCHEDULE_OFFSET_MINUTES", "5"),
                name="COLLECTOR_SCHEDULE_OFFSET_MINUTES",
                minimum=0,
                maximum=59,
            ),
            finalize_time=env.get("COLLECTOR_FINALIZE_TIME", "23:55"),
            observation_retention_days=observation_retention,
            legacy_retention_days=legacy_retention,
            service_retention_days=service_retention,
            raw_payload_retention_days=raw_retention,
        )
        _validate_policy(policy)
        return policy


@dataclass(frozen=True)
class PreparedSnapshot:
    snapshot_id: str
    database_path: Path
    receipt_path: Path
    receipt_sha256: str
    created_at: str
    database_bytes: int
    page_size: int
    page_count: int
    device: int
    inode: int
    mtime_ns: int
    policy: SnapshotPolicy


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def utc_timestamp(value: datetime) -> str:
    return _as_utc(value).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def generate_snapshot_id(created_at: datetime) -> str:
    prefix = _as_utc(created_at).replace(microsecond=0).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def create_prepared_snapshot(
    source_db: Path,
    handoff_root: Path,
    policy: SnapshotPolicy,
    *,
    snapshot_id: str | None = None,
    created_at: datetime | None = None,
    progress: ProgressCallback | None = None,
    stage_hook: StageHook | None = None,
    minimum_free_bytes: int = 0,
) -> PreparedSnapshot:
    created = _as_utc(created_at or utc_now()).replace(microsecond=0)
    selected_id = snapshot_id or generate_snapshot_id(created)
    _validate_snapshot_id(selected_id)
    _validate_policy_clock(policy, created)

    source = Path(source_db)
    _require_regular_file(source, label="source database")
    root, snapshots_root, receipts_root = _prepare_handoff_directories(handoff_root)
    database_path = snapshots_root / f"{selected_id}.db"
    receipt_path = receipts_root / f"{selected_id}.ready.json"

    database_partial = snapshots_root / (
        f".{selected_id}.{uuid.uuid4().hex}.db.partial"
    )
    receipt_partial = receipts_root / (
        f".{selected_id}.{uuid.uuid4().hex}.ready.json.partial"
    )
    database_published = False
    receipt_published = False

    lock_handle = _acquire_snapshot_lock(root)
    try:
        _assert_handoff_available_for_create(snapshots_root, receipts_root)
        if database_path.exists() or receipt_path.exists():
            raise FileExistsError(f"snapshot {selected_id!r} already exists")
        _copy_pinned_snapshot(
            source,
            database_partial,
            capacity_root=root,
            minimum_free_bytes=minimum_free_bytes,
            progress=progress,
            stage_hook=stage_hook,
        )
        _call_stage(stage_hook, "backup_complete")
        _fsync_file(database_partial)
        os.replace(database_partial, database_path)
        database_published = True
        _fsync_directory(snapshots_root)
        _call_stage(stage_hook, "database_published")

        page_size, page_count = _validate_immutable_database(database_path)
        database_stat = _require_regular_file(
            database_path, label="snapshot database", single_link=True
        )
        database_bytes = database_stat.st_size
        if database_bytes != page_size * page_count:
            raise RuntimeError(
                "snapshot database size does not match its SQLite page metadata"
            )
        _reject_database_sidecars(database_path)
        _call_stage(stage_hook, "database_validated")

        receipt = _receipt_payload(
            snapshot_id=selected_id,
            created_at=created,
            database_path=database_path,
            handoff_root=root,
            database_stat=database_stat,
            page_size=page_size,
            page_count=page_count,
            policy=policy,
        )
        receipt_bytes = (
            json.dumps(
                receipt,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")
        _call_stage(stage_hook, "before_receipt_publish")
        _write_exclusive_fsynced(receipt_partial, receipt_bytes)
        os.replace(receipt_partial, receipt_path)
        receipt_published = True
        _fsync_directory(receipts_root)
        return load_prepared_snapshot(
            root,
            selected_id,
            max_age_hours=DEFAULT_MAX_AGE_HOURS,
            now=created,
        )
    except BaseException:
        database_partial.unlink(missing_ok=True)
        receipt_partial.unlink(missing_ok=True)
        if database_published and not receipt_published:
            database_path.unlink(missing_ok=True)
            _fsync_directory(snapshots_root)
        raise
    finally:
        _release_snapshot_lock(lock_handle)


@contextmanager
def snapshot_lock(root: Path):
    """Hold the non-blocking, cross-process snapshot producer lock."""
    handoff_root, _, _ = _prepare_handoff_directories(root)
    handle = _acquire_snapshot_lock(handoff_root)
    try:
        yield
    finally:
        _release_snapshot_lock(handle)


@contextmanager
def snapshot_consumer_lock(root: Path):
    """Hold a shared lock while a prepared snapshot is being consumed."""

    handoff_root, _, _ = _existing_handoff_directories(root)
    handle = _acquire_snapshot_lock(handoff_root, shared=True)
    try:
        yield
    finally:
        _release_snapshot_lock(handle)


def load_prepared_snapshot(
    root: Path,
    snapshot_id: str,
    *,
    max_age_hours: int = DEFAULT_MAX_AGE_HOURS,
    now: datetime | None = None,
) -> PreparedSnapshot:
    if isinstance(max_age_hours, bool) or not isinstance(max_age_hours, int):
        raise TypeError("max_age_hours must be an integer")
    if max_age_hours < 1 or max_age_hours > 24 * 365:
        raise ValueError("max_age_hours must be between 1 and 8760")
    return _load_prepared_snapshot(
        Path(root),
        snapshot_id,
        max_age=timedelta(hours=max_age_hours),
        now=_as_utc(now or utc_now()),
        enforce_freshness=True,
    )


def list_prepared_snapshots(
    root: Path,
    *,
    max_age_hours: int = DEFAULT_MAX_AGE_HOURS,
    now: datetime | None = None,
) -> list[PreparedSnapshot]:
    handoff_root = Path(root)
    _require_directory(handoff_root, label="snapshot handoff root")
    snapshots_candidate = handoff_root / "snapshots"
    receipts_candidate = handoff_root / "receipts"
    if (
        not snapshots_candidate.exists()
        and not snapshots_candidate.is_symlink()
        and not receipts_candidate.exists()
        and not receipts_candidate.is_symlink()
    ):
        unexpected = sorted(item.name for item in handoff_root.iterdir())
        if unexpected:
            raise RuntimeError(
                "snapshot handoff root has unexpected artifacts before initialization: "
                + ", ".join(unexpected)
            )
        return []
    handoff_root, _, receipts_root = _existing_handoff_directories(root)
    identifiers: list[str] = []
    for receipt_path in receipts_root.iterdir():
        if not receipt_path.name.endswith(".ready.json"):
            continue
        identifiers.append(receipt_path.name.removesuffix(".ready.json"))
    snapshots = [
        load_prepared_snapshot(
            handoff_root,
            identifier,
            max_age_hours=max_age_hours,
            now=now,
        )
        for identifier in identifiers
    ]
    return sorted(snapshots, key=lambda item: (item.created_at, item.snapshot_id), reverse=True)


def assert_prepared_snapshot_unchanged(snapshot: PreparedSnapshot) -> None:
    _validate_snapshot_id(snapshot.snapshot_id)
    receipt_stat = _require_regular_file(
        snapshot.receipt_path, label="snapshot receipt", single_link=True
    )
    if receipt_stat.st_size > 64 * 1024:
        raise RuntimeError("snapshot receipt is unexpectedly large")
    if _sha256_file(snapshot.receipt_path) != snapshot.receipt_sha256:
        raise RuntimeError("snapshot receipt changed after it was loaded")
    database_stat = _require_regular_file(
        snapshot.database_path, label="snapshot database", single_link=True
    )
    actual_identity = (
        database_stat.st_dev,
        database_stat.st_ino,
        database_stat.st_mtime_ns,
        database_stat.st_size,
    )
    expected_identity = (
        snapshot.device,
        snapshot.inode,
        snapshot.mtime_ns,
        snapshot.database_bytes,
    )
    if actual_identity != expected_identity:
        raise RuntimeError("snapshot database changed after it was loaded")
    _reject_database_sidecars(snapshot.database_path)
    page_size, page_count = _validate_immutable_database(snapshot.database_path)
    if page_size != snapshot.page_size or page_count != snapshot.page_count:
        raise RuntimeError("snapshot SQLite page metadata changed after it was loaded")


def release_prepared_snapshot(root: Path, snapshot_id: str) -> PreparedSnapshot:
    handoff_root = Path(root)
    _existing_handoff_directories(handoff_root)
    lock_handle = _acquire_snapshot_lock(handoff_root)
    try:
        prepared = _load_prepared_snapshot(
            handoff_root,
            snapshot_id,
            max_age=None,
            now=utc_now(),
            enforce_freshness=False,
        )
        assert_prepared_snapshot_unchanged(prepared)

        # Revoke the publication boundary first. A crash after this unlink can only
        # leave an unreachable database file, never a receipt pointing at no file.
        prepared.receipt_path.unlink()
        _fsync_directory(prepared.receipt_path.parent)
        database_stat = _require_regular_file(
            prepared.database_path, label="snapshot database", single_link=True
        )
        if (
            database_stat.st_dev,
            database_stat.st_ino,
            database_stat.st_mtime_ns,
            database_stat.st_size,
        ) != (
            prepared.device,
            prepared.inode,
            prepared.mtime_ns,
            prepared.database_bytes,
        ):
            raise RuntimeError("snapshot database changed while it was being released")
        prepared.database_path.unlink()
        _fsync_directory(prepared.database_path.parent)
        return prepared
    finally:
        _release_snapshot_lock(lock_handle)


def _load_prepared_snapshot(
    root: Path,
    snapshot_id: str,
    *,
    max_age: timedelta | None,
    now: datetime,
    enforce_freshness: bool,
) -> PreparedSnapshot:
    _validate_snapshot_id(snapshot_id)
    handoff_root, snapshots_root, receipts_root = _existing_handoff_directories(root)
    receipt_path = receipts_root / f"{snapshot_id}.ready.json"
    receipt_stat = _require_regular_file(
        receipt_path, label="snapshot receipt", single_link=True
    )
    if receipt_stat.st_size <= 0 or receipt_stat.st_size > 64 * 1024:
        raise RuntimeError("snapshot receipt size is invalid")
    receipt_bytes = receipt_path.read_bytes()
    receipt_after = _require_regular_file(
        receipt_path, label="snapshot receipt", single_link=True
    )
    if _stat_identity(receipt_stat) != _stat_identity(receipt_after):
        raise RuntimeError("snapshot receipt changed while it was being read")
    try:
        value = json.loads(receipt_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("snapshot receipt is not valid UTF-8 JSON") from exc
    receipt = _require_object(value, label="snapshot receipt")
    _require_exact_keys(
        receipt,
        {"formatVersion", "snapshotId", "createdAt", "database", "policy"},
        label="snapshot receipt",
    )
    if _require_int(receipt["formatVersion"], label="formatVersion", minimum=1) != SNAPSHOT_FORMAT_VERSION:
        raise RuntimeError("unsupported snapshot receipt format version")
    if receipt["snapshotId"] != snapshot_id:
        raise RuntimeError("snapshot receipt ID does not match the requested ID")

    created_text = _require_string(receipt["createdAt"], label="createdAt")
    created = _parse_utc_timestamp(created_text)
    now_utc = _as_utc(now)
    if enforce_freshness:
        if created > now_utc:
            raise RuntimeError("snapshot receipt was created in the future")
        if max_age is None or now_utc - created > max_age:
            raise RuntimeError("snapshot receipt is stale")

    policy = _policy_from_receipt(receipt["policy"])
    _validate_policy_clock(policy, created)
    database = _require_object(receipt["database"], label="database")
    _require_exact_keys(
        database,
        {"path", "bytes", "pageSize", "pageCount", "device", "inode", "mtimeNs"},
        label="database",
    )
    expected_relative = f"snapshots/{snapshot_id}.db"
    relative = _require_string(database["path"], label="database.path")
    if relative != expected_relative:
        raise RuntimeError("snapshot database path is not the canonical relative path")
    database_path = snapshots_root / f"{snapshot_id}.db"
    database_stat = _require_regular_file(
        database_path, label="snapshot database", single_link=True
    )
    resolved_path = database_path.resolve(strict=True)
    if resolved_path.parent != snapshots_root.resolve(strict=True):
        raise RuntimeError("snapshot database path escapes the handoff directory")
    database_bytes = _require_int(database["bytes"], label="database.bytes", minimum=1)
    page_size = _require_int(database["pageSize"], label="database.pageSize", minimum=512)
    page_count = _require_int(database["pageCount"], label="database.pageCount", minimum=1)
    device = _require_int(database["device"], label="database.device", minimum=0)
    inode = _require_int(database["inode"], label="database.inode", minimum=0)
    mtime_ns = _require_int(database["mtimeNs"], label="database.mtimeNs", minimum=0)
    if database_bytes != page_size * page_count:
        raise RuntimeError("snapshot receipt contains inconsistent database size metadata")
    expected_identity = (device, inode, mtime_ns, database_bytes)
    if _stat_identity(database_stat) != expected_identity:
        raise RuntimeError("snapshot database identity differs from its receipt")
    _reject_database_sidecars(database_path)
    actual_page_size, actual_page_count = _validate_immutable_database(database_path)
    if (actual_page_size, actual_page_count) != (page_size, page_count):
        raise RuntimeError("snapshot SQLite page metadata differs from its receipt")

    return PreparedSnapshot(
        snapshot_id=snapshot_id,
        database_path=database_path,
        receipt_path=receipt_path,
        receipt_sha256=hashlib.sha256(receipt_bytes).hexdigest(),
        created_at=created_text,
        database_bytes=database_bytes,
        page_size=page_size,
        page_count=page_count,
        device=device,
        inode=inode,
        mtime_ns=mtime_ns,
        policy=policy,
    )


def _copy_pinned_snapshot(
    source_path: Path,
    destination: Path,
    *,
    capacity_root: Path,
    minimum_free_bytes: int,
    progress: ProgressCallback | None,
    stage_hook: StageHook | None,
) -> None:
    source_uri = _sqlite_uri(source_path, "mode=ro")
    source = sqlite3.connect(source_uri, uri=True, timeout=60, isolation_level=None)
    target: sqlite3.Connection | None = None
    try:
        source.execute("PRAGMA query_only=ON")
        source.execute("PRAGMA busy_timeout=60000")
        source.execute("BEGIN")
        # A BEGIN alone is deferred. This real read is deliberately performed
        # before the Backup API starts so WAL commits made afterwards are not
        # folded into the snapshot while ordinary writers remain unblocked.
        source.execute("SELECT COUNT(*) FROM sqlite_schema").fetchone()
        page_size = int(source.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(source.execute("PRAGMA page_count").fetchone()[0])
        if page_size < 512 or page_count <= 0:
            raise RuntimeError("source database has invalid SQLite page metadata")
        _validate_snapshot_capacity(
            capacity_root,
            snapshot_bytes=page_size * page_count,
            minimum_free_bytes=minimum_free_bytes,
        )
        _call_stage(stage_hook, "source_pinned")
        _create_exclusive_empty_file(destination)
        target = sqlite3.connect(destination, timeout=60)

        def report(_status: int, remaining: int, total: int) -> None:
            if progress is not None:
                progress(total - remaining, total)

        source.backup(target, pages=16384, progress=report, sleep=0.1)
        target.commit()
    finally:
        if target is not None:
            target.close()
        if source.in_transaction:
            source.rollback()
        source.close()

    # SQLite Backup API copies the source header, including its persistent WAL
    # journal mode. DuckDB's SQLite extension uses ordinary SQLite locking, but
    # the consumer intentionally mounts this handoff read-only. Normalize the
    # private copy before publication so readers never need -wal/-shm sidecars.
    with closing(sqlite3.connect(destination, timeout=60)) as copied:
        journal_mode = copied.execute("PRAGMA journal_mode=DELETE").fetchone()
    if journal_mode is None or str(journal_mode[0]).lower() != "delete":
        raise RuntimeError("snapshot database could not leave WAL journal mode")
    _reject_database_sidecars(destination)


def _validate_immutable_database(path: Path) -> tuple[int, int]:
    uri = _sqlite_uri(path, "mode=ro&immutable=1")
    with closing(sqlite3.connect(uri, uri=True, timeout=60)) as connection:
        connection.execute("PRAGMA query_only=ON")
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
        schema_version = connection.execute("PRAGMA schema_version").fetchone()
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()
        connection.execute("SELECT COUNT(*) FROM sqlite_schema").fetchone()
    if page_size < 512 or page_count <= 0 or schema_version is None:
        raise RuntimeError("snapshot database has invalid SQLite metadata")
    if journal_mode is None or str(journal_mode[0]).lower() != "delete":
        raise RuntimeError("snapshot database must use DELETE journal mode")
    return page_size, page_count


def _assert_handoff_available_for_create(
    snapshots_root: Path, receipts_root: Path
) -> None:
    artifacts = sorted(
        [f"snapshots/{path.name}" for path in snapshots_root.iterdir()]
        + [f"receipts/{path.name}" for path in receipts_root.iterdir()]
    )
    if artifacts:
        preview = ", ".join(artifacts[:5])
        suffix = " ..." if len(artifacts) > 5 else ""
        raise RuntimeError(
            "snapshot handoff is not empty; release the existing exact snapshot or "
            f"inspect interrupted artifacts before creating another: {preview}{suffix}"
        )


def _validate_snapshot_capacity(
    root: Path, *, snapshot_bytes: int, minimum_free_bytes: int
) -> None:
    if isinstance(minimum_free_bytes, bool) or not isinstance(minimum_free_bytes, int):
        raise TypeError("minimum_free_bytes must be an integer")
    if minimum_free_bytes < 0:
        raise ValueError("minimum_free_bytes cannot be negative")
    free_bytes = shutil.disk_usage(root).free
    required_bytes = snapshot_bytes + minimum_free_bytes
    if free_bytes < required_bytes:
        raise RuntimeError(
            "insufficient free space for snapshot: "
            f"need {required_bytes} bytes ({snapshot_bytes} snapshot + "
            f"{minimum_free_bytes} reserve), have {free_bytes} bytes"
        )


def _receipt_payload(
    *,
    snapshot_id: str,
    created_at: datetime,
    database_path: Path,
    handoff_root: Path,
    database_stat: os.stat_result,
    page_size: int,
    page_count: int,
    policy: SnapshotPolicy,
) -> dict[str, Any]:
    return {
        "formatVersion": SNAPSHOT_FORMAT_VERSION,
        "snapshotId": snapshot_id,
        "createdAt": utc_timestamp(created_at),
        "database": {
            "path": database_path.relative_to(handoff_root).as_posix(),
            "bytes": database_stat.st_size,
            "pageSize": page_size,
            "pageCount": page_count,
            "device": database_stat.st_dev,
            "inode": database_stat.st_ino,
            "mtimeNs": database_stat.st_mtime_ns,
        },
        "policy": {
            "asOfDate": policy.as_of_date.isoformat(),
            "dimensionSnapshotDate": policy.dimension_snapshot_date.isoformat(),
            "retentionReferenceDate": policy.retention_reference_date.isoformat(),
            "timezoneName": policy.timezone_name,
            "endedDayReadyHour": policy.ended_day_ready_hour,
            "activeServiceTtlDays": policy.active_service_ttl_days,
            "cadenceMinutes": policy.cadence_minutes,
            "scheduleOffsetMinutes": policy.schedule_offset_minutes,
            "finalizeTime": policy.finalize_time,
            "observationRetentionDays": policy.observation_retention_days,
            "legacyRetentionDays": policy.legacy_retention_days,
            "serviceRetentionDays": policy.service_retention_days,
            "rawPayloadRetentionDays": policy.raw_payload_retention_days,
        },
    }


def _policy_from_receipt(value: Any) -> SnapshotPolicy:
    policy = _require_object(value, label="policy")
    expected = {
        "asOfDate",
        "dimensionSnapshotDate",
        "retentionReferenceDate",
        "timezoneName",
        "endedDayReadyHour",
        "activeServiceTtlDays",
        "cadenceMinutes",
        "scheduleOffsetMinutes",
        "finalizeTime",
        "observationRetentionDays",
        "legacyRetentionDays",
        "serviceRetentionDays",
        "rawPayloadRetentionDays",
    }
    _require_exact_keys(policy, expected, label="policy")
    result = SnapshotPolicy(
        as_of_date=_parse_date(policy["asOfDate"], label="policy.asOfDate"),
        dimension_snapshot_date=_parse_date(
            policy["dimensionSnapshotDate"], label="policy.dimensionSnapshotDate"
        ),
        retention_reference_date=_parse_date(
            policy["retentionReferenceDate"], label="policy.retentionReferenceDate"
        ),
        timezone_name=_require_string(
            policy["timezoneName"], label="policy.timezoneName"
        ),
        ended_day_ready_hour=_require_int(
            policy["endedDayReadyHour"],
            label="policy.endedDayReadyHour",
            minimum=0,
            maximum=23,
        ),
        active_service_ttl_days=_require_int(
            policy["activeServiceTtlDays"],
            label="policy.activeServiceTtlDays",
            minimum=1,
            maximum=31,
        ),
        cadence_minutes=_require_int(
            policy["cadenceMinutes"],
            label="policy.cadenceMinutes",
            minimum=1,
            maximum=1440,
        ),
        schedule_offset_minutes=_require_int(
            policy["scheduleOffsetMinutes"],
            label="policy.scheduleOffsetMinutes",
            minimum=0,
            maximum=59,
        ),
        finalize_time=_require_string(
            policy["finalizeTime"], label="policy.finalizeTime"
        ),
        observation_retention_days=_require_int(
            policy["observationRetentionDays"],
            label="policy.observationRetentionDays",
            minimum=1,
            maximum=3650,
        ),
        legacy_retention_days=_require_int(
            policy["legacyRetentionDays"],
            label="policy.legacyRetentionDays",
            minimum=1,
            maximum=3650,
        ),
        service_retention_days=_require_int(
            policy["serviceRetentionDays"],
            label="policy.serviceRetentionDays",
            minimum=1,
            maximum=3650,
        ),
        raw_payload_retention_days=_require_int(
            policy["rawPayloadRetentionDays"],
            label="policy.rawPayloadRetentionDays",
            minimum=1,
            maximum=3650,
        ),
    )
    _validate_policy(result)
    return result


def _validate_policy(policy: SnapshotPolicy) -> None:
    if policy.timezone_name != DEFAULT_TIMEZONE:
        raise ValueError(f"snapshot timezone must be {DEFAULT_TIMEZONE!r}")
    if not FINALIZE_TIME.fullmatch(policy.finalize_time):
        raise ValueError("snapshot finalize_time must use HH:MM")
    for name, value, minimum, maximum in (
        ("ended_day_ready_hour", policy.ended_day_ready_hour, 0, 23),
        ("active_service_ttl_days", policy.active_service_ttl_days, 1, 31),
        ("cadence_minutes", policy.cadence_minutes, 1, 1440),
        ("schedule_offset_minutes", policy.schedule_offset_minutes, 0, 59),
        ("observation_retention_days", policy.observation_retention_days, 1, 3650),
        ("legacy_retention_days", policy.legacy_retention_days, 1, 3650),
        ("service_retention_days", policy.service_retention_days, 1, 3650),
        ("raw_payload_retention_days", policy.raw_payload_retention_days, 1, 3650),
    ):
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"snapshot {name} must be an integer")
        if value < minimum or value > maximum:
            raise ValueError(
                f"snapshot {name} must be between {minimum} and {maximum}"
            )
    if policy.service_retention_days < max(
        policy.observation_retention_days,
        policy.raw_payload_retention_days,
        policy.active_service_ttl_days,
    ):
        raise ValueError("service retention cannot be shorter than dependent retention")
    if policy.as_of_date > policy.dimension_snapshot_date:
        raise ValueError("as-of date cannot follow the dimension snapshot date")
    if policy.as_of_date > policy.retention_reference_date:
        raise ValueError("as-of date cannot follow the retention reference date")


def _validate_policy_clock(policy: SnapshotPolicy, created_at: datetime) -> None:
    _validate_policy(policy)
    local_created = _rome_local_datetime(created_at)
    clock_date = local_created.date()
    maximum_as_of = clock_date
    if local_created.hour < policy.ended_day_ready_hour:
        maximum_as_of -= timedelta(days=1)
    if policy.as_of_date > maximum_as_of:
        raise ValueError("snapshot policy as-of date is not ready at receipt creation time")
    if policy.dimension_snapshot_date != clock_date:
        raise ValueError("snapshot policy dimension date does not match its creation clock")
    if policy.retention_reference_date != clock_date:
        raise ValueError("snapshot retention date does not match its creation clock")


def _prepare_handoff_directories(root: Path) -> tuple[Path, Path, Path]:
    handoff_root = Path(root)
    handoff_root.mkdir(parents=True, exist_ok=True)
    _require_directory(handoff_root, label="snapshot handoff root")
    snapshots_root = handoff_root / "snapshots"
    receipts_root = handoff_root / "receipts"
    snapshots_root.mkdir(exist_ok=True)
    receipts_root.mkdir(exist_ok=True)
    _require_directory(snapshots_root, label="snapshot database directory")
    _require_directory(receipts_root, label="snapshot receipt directory")
    return handoff_root, snapshots_root, receipts_root


def _acquire_snapshot_lock(root: Path, *, shared: bool = False):
    lock_path = root / "snapshot.lock"
    handle = lock_path.open("rb" if shared else "a+b")
    try:
        if not shared:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
                os.fsync(handle.fileno())
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            try:
                mode = msvcrt.LK_NBRLCK if shared else msvcrt.LK_NBLCK
                msvcrt.locking(handle.fileno(), mode, 1)
            except OSError as exc:
                raise RuntimeError("another statistics snapshot is active") from exc
        else:
            import fcntl

            try:
                mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
                fcntl.flock(handle.fileno(), mode | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("another statistics snapshot is active") from exc
        return handle
    except BaseException:
        handle.close()
        raise


def _release_snapshot_lock(handle) -> None:
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
    finally:
        handle.close()


def _existing_handoff_directories(root: Path) -> tuple[Path, Path, Path]:
    handoff_root = Path(root)
    _require_directory(handoff_root, label="snapshot handoff root")
    snapshots_root = handoff_root / "snapshots"
    receipts_root = handoff_root / "receipts"
    _require_directory(snapshots_root, label="snapshot database directory")
    _require_directory(receipts_root, label="snapshot receipt directory")
    return handoff_root, snapshots_root, receipts_root


def _require_directory(path: Path, *, label: str) -> os.stat_result:
    try:
        value = path.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise RuntimeError(f"{label} is not a real directory: {path}")
    return value


def _require_regular_file(
    path: Path, *, label: str, single_link: bool = False
) -> os.stat_result:
    try:
        value = path.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
        raise RuntimeError(f"{label} is not a regular file: {path}")
    if single_link and value.st_nlink != 1:
        raise RuntimeError(f"{label} must have exactly one filesystem link: {path}")
    return value


def _reject_database_sidecars(path: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(f"{path}{suffix}")
        if sidecar.exists() or sidecar.is_symlink():
            raise RuntimeError(f"snapshot database has a forbidden sidecar: {sidecar.name}")


def _create_exclusive_empty_file(path: Path) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)


def _write_exclusive_fsynced(path: Path, payload: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _fsync_file(path: Path) -> None:
    with path.open("r+b") as handle:
        handle.flush()
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sqlite_uri(path: Path, parameters: str) -> str:
    encoded = quote(path.resolve().as_posix(), safe="/:")
    return f"file:{encoded}?{parameters}"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_mtime_ns, value.st_size


def _call_stage(stage_hook: StageHook | None, stage: str) -> None:
    if stage_hook is not None:
        stage_hook(stage)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("snapshot timestamps must be timezone-aware")
    return value.astimezone(timezone.utc)


def _rome_local_datetime(value: datetime) -> datetime:
    """Convert UTC to Rome time, with a modern EU-rule fallback for Windows."""
    utc_value = _as_utc(value)
    try:
        return utc_value.astimezone(ZoneInfo(DEFAULT_TIMEZONE))
    except ZoneInfoNotFoundError:
        pass
    year = utc_value.year
    march_last_sunday = 31 - ((date(year, 3, 31).weekday() + 1) % 7)
    october_last_day = monthrange(year, 10)[1]
    october_last_sunday = october_last_day - (
        (date(year, 10, october_last_day).weekday() + 1) % 7
    )
    summer_start = datetime(
        year, 3, march_last_sunday, 1, tzinfo=timezone.utc
    )
    summer_end = datetime(
        year, 10, october_last_sunday, 1, tzinfo=timezone.utc
    )
    offset_hours = 2 if summer_start <= utc_value < summer_end else 1
    return utc_value.astimezone(timezone(timedelta(hours=offset_hours)))


def _parse_utc_timestamp(value: str) -> datetime:
    if not UTC_TIMESTAMP.fullmatch(value):
        raise RuntimeError("snapshot createdAt must use UTC YYYY-MM-DDTHH:MM:SSZ")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as exc:
        raise RuntimeError("snapshot createdAt is not a valid timestamp") from exc


def _parse_date(value: Any, *, label: str) -> date:
    text = _require_string(value, label=label)
    if not ISO_DATE.fullmatch(text):
        raise RuntimeError(f"{label} must use YYYY-MM-DD")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise RuntimeError(f"{label} is not a valid date") from exc


def _validate_snapshot_id(value: str) -> None:
    if not isinstance(value, str) or not SNAPSHOT_ID.fullmatch(value):
        raise ValueError("invalid snapshot ID")


def _bounded_int(value: Any, *, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _require_object(value: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be a JSON object")
    if not all(isinstance(key, str) for key in value):
        raise RuntimeError(f"{label} has a non-string key")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], *, label: str
) -> None:
    if set(value) != expected:
        raise RuntimeError(f"{label} has unexpected or missing fields")


def _require_string(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{label} must be a non-empty string")
    return value


def _require_int(
    value: Any,
    *,
    label: str,
    minimum: int,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"{label} must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        raise RuntimeError(f"{label} is outside the permitted range")
    return value
