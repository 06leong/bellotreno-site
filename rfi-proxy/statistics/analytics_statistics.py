from __future__ import annotations

import argparse
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
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


ANALYTICS_SCHEMA_VERSION = 2
METRIC_DEFINITION_VERSION = "2026-08-11-v2"
DEFAULT_ARCHIVE_ROOT = "/archive"
DEFAULT_ANALYTICS_ROOT = "/analytics"
DEFAULT_WINDOWS = (7, 28, 90)
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class AnalyticsConfig:
    archive_root: Path
    analytics_root: Path
    as_of_date: date | None
    memory_limit: str
    threads: int
    max_history_days: int
    minimum_ranking_sample: int
    window_batch_days: int = 1
    fact_batch_days: int = 1
    max_temp_directory_size: str = "4GB"

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "AnalyticsConfig":
        as_of = date.fromisoformat(args.as_of_date) if args.as_of_date else None
        return cls(
            archive_root=Path(args.archive_root or os.environ.get("ARCHIVE_ROOT", DEFAULT_ARCHIVE_ROOT)),
            analytics_root=Path(
                args.analytics_root
                or os.environ.get("ANALYTICS_ROOT", DEFAULT_ANALYTICS_ROOT)
            ),
            as_of_date=as_of,
            memory_limit=os.environ.get("ANALYTICS_DUCKDB_MEMORY_LIMIT", "128MB"),
            threads=_bounded_int(
                os.environ.get("ANALYTICS_DUCKDB_THREADS", "1"),
                name="ANALYTICS_DUCKDB_THREADS",
                minimum=1,
                maximum=16,
            ),
            max_history_days=_bounded_int(
                os.environ.get("ANALYTICS_HISTORY_DAYS", "730"),
                name="ANALYTICS_HISTORY_DAYS",
                minimum=90,
                maximum=3650,
            ),
            minimum_ranking_sample=_bounded_int(
                os.environ.get("ANALYTICS_MIN_RANKING_SAMPLE", "100"),
                name="ANALYTICS_MIN_RANKING_SAMPLE",
                minimum=1,
                maximum=10000,
            ),
            window_batch_days=_bounded_int(
                os.environ.get("ANALYTICS_WINDOW_BATCH_DAYS", "1"),
                name="ANALYTICS_WINDOW_BATCH_DAYS",
                minimum=1,
                maximum=31,
            ),
            fact_batch_days=_bounded_int(
                os.environ.get("ANALYTICS_FACT_BATCH_DAYS", "1"),
                name="ANALYTICS_FACT_BATCH_DAYS",
                minimum=1,
                maximum=7,
            ),
            max_temp_directory_size=os.environ.get(
                "ANALYTICS_DUCKDB_MAX_TEMP_DIRECTORY_SIZE", "4GB"
            ),
        )


@dataclass(frozen=True)
class ArchiveIndex:
    manifests: tuple[str, ...]
    latest_created_at: str
    latest_as_of_date: str
    files: dict[str, tuple[Path, ...]]
    quality_days: tuple[dict[str, Any], ...]


def _bounded_int(value: Any, *, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= parsed <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    print(f"[statistics-analytics] {message}", file=sys.stderr, flush=True)


def remove_abandoned_work_roots(root: Path) -> int:
    """Remove work directories left behind when a build is killed abruptly."""
    removed = 0
    for candidate in sorted(root.glob("analytics-*")):
        if candidate.is_symlink() or not candidate.is_dir():
            raise RuntimeError(
                f"unexpected Analytics work-root entry requires review: {candidate}"
            )
        shutil.rmtree(candidate)
        removed += 1
    return removed


def analytics_cleanup(config: AnalyticsConfig) -> dict[str, Any]:
    config.analytics_root.mkdir(parents=True, exist_ok=True)
    with analytics_lock(config.analytics_root):
        removed = remove_abandoned_work_roots(config.analytics_root)
    return {
        "mode": "cleanup",
        "status": "success",
        "removedWorkRoots": removed,
    }


@contextmanager
def analytics_lock(root: Path):
    """Hold a non-blocking publication lock in the writable analytics root."""
    root.mkdir(parents=True, exist_ok=True)
    handle = (root / "analytics.lock").open("a+b")
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
                raise RuntimeError("another statistics analytics build is active") from exc
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("another statistics analytics build is active") from exc
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


def _safe_archive_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    try:
        candidate.relative_to(resolved_root)
    except ValueError as exc:
        raise RuntimeError(f"archive path escapes root: {relative!r}") from exc
    return candidate


def load_archive_index(root: Path) -> ArchiveIndex:
    manifest_root = root / "manifests"
    manifests = sorted(manifest_root.glob("*.complete.json"))
    if not manifests:
        raise RuntimeError("no completed archive manifests found")

    files: dict[str, list[Path]] = {}
    identities: set[tuple[str, str]] = set()
    quality_by_date: dict[str, tuple[str, dict[str, Any]]] = {}
    manifest_ids: list[str] = []
    latest_created_at = ""
    latest_as_of_date = ""

    for manifest_path in manifests:
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot read manifest {manifest_path}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError(f"manifest root must be an object: {manifest_path}")
        run_id = str(payload.get("runId") or manifest_path.name.removesuffix(".complete.json"))
        created_at = str(payload.get("createdAt") or "")
        as_of_date = str(payload.get("asOfDate") or "")
        if as_of_date and not ISO_DATE.fullmatch(as_of_date):
            raise RuntimeError(f"invalid asOfDate in {manifest_path}")
        latest_created_at = max(latest_created_at, created_at)
        latest_as_of_date = max(latest_as_of_date, as_of_date)
        manifest_ids.append(run_id)

        datasets = payload.get("datasets")
        if not isinstance(datasets, list):
            raise RuntimeError(f"manifest has no dataset list: {manifest_path}")
        for item in datasets:
            if not isinstance(item, dict):
                raise RuntimeError(f"invalid dataset item in {manifest_path}")
            dataset = str(item.get("dataset") or "")
            partition = item.get("partition")
            relative = str(item.get("path") or "")
            if not dataset or not isinstance(partition, dict) or len(partition) != 1 or not relative:
                raise RuntimeError(f"invalid dataset metadata in {manifest_path}")
            _, partition_value = next(iter(partition.items()))
            partition_value = str(partition_value)
            identity = (dataset, partition_value)
            if identity in identities:
                raise RuntimeError(f"dataset partition published more than once: {identity!r}")
            identities.add(identity)
            path = _safe_archive_path(root, relative)
            if not path.is_file():
                raise RuntimeError(f"published Parquet file is missing: {path}")
            files.setdefault(dataset, []).append(path)

        coverage = payload.get("coverage") if isinstance(payload.get("coverage"), dict) else {}
        collection_quality = (
            coverage.get("collectionDayQuality")
            if isinstance(coverage.get("collectionDayQuality"), dict)
            else {}
        )
        quality_items = collection_quality.get("items")
        if isinstance(quality_items, list):
            for item in quality_items:
                if not isinstance(item, dict):
                    continue
                value = str(item.get("date") or "")
                if ISO_DATE.fullmatch(value):
                    previous = quality_by_date.get(value)
                    if previous is None or created_at >= previous[0]:
                        quality_by_date[value] = (created_at, dict(item))

    required = {"train_services", "train_observations", "train_stop_events"}
    missing = sorted(required - files.keys())
    if missing:
        raise RuntimeError(f"archive is missing required datasets: {', '.join(missing)}")

    return ArchiveIndex(
        manifests=tuple(manifest_ids),
        latest_created_at=latest_created_at,
        latest_as_of_date=latest_as_of_date,
        files={name: tuple(sorted(paths)) for name, paths in files.items()},
        quality_days=tuple(quality_by_date[key][1] for key in sorted(quality_by_date)),
    )


def _import_duckdb():
    try:
        import duckdb  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("duckdb is required in the statistics archive image") from exc
    return duckdb


def _duckdb_file_list(paths: Iterable[Path]) -> str:
    values = []
    for path in paths:
        values.append("'" + str(path.resolve()).replace("'", "''") + "'")
    if not values:
        raise RuntimeError("cannot create a Parquet view without files")
    return "[" + ",".join(values) + "]"


def _create_archive_views(connection: Any, index: ArchiveIndex) -> None:
    for dataset, paths in index.files.items():
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW {dataset} AS "
            f"SELECT * FROM read_parquet({_duckdb_file_list(paths)}, "
            "union_by_name=true, hive_partitioning=false)"
        )


SERVICE_FACT_SELECT_SQL = """
WITH stop_endpoints AS (
    SELECT e.service_date, e.train_key,
           first(e.arrival_delay ORDER BY e.stop_number DESC) AS terminal_arrival_delay,
           first(e.arrival_actual ORDER BY e.stop_number DESC) AS terminal_arrival_actual,
           first(e.departure_delay ORDER BY e.stop_number ASC) AS origin_departure_delay,
           first(e.departure_actual ORDER BY e.stop_number ASC) AS origin_departure_actual
    FROM train_stop_events e
    JOIN analytics_service_date_batch b ON b.service_date=e.service_date
    GROUP BY e.service_date, e.train_key
),
observations AS (
    SELECT o.service_date, o.train_key, COUNT(*) AS observation_count,
           MIN(o.observed_at) AS first_observed_at,
           MAX(o.observed_at) AS last_observed_at,
           MAX(o.quality_score) AS observation_quality
    FROM train_observations o
    JOIN analytics_service_date_batch b ON b.service_date=o.service_date
    GROUP BY o.service_date, o.train_key
),
base AS (
    SELECT
        s.service_date,
        s.train_key,
        s.train_number,
        s.identity_quality,
        NULLIF(TRIM(s.operator), '') AS operator,
        NULLIF(TRIM(s.category), '') AS category,
        s.origin,
        s.destination,
        s.origin_code,
        s.destination_code,
        s.relation_key,
        s.status,
        CAST(COALESCE(s.cancelled, 0) AS INTEGER) AS cancelled,
        CAST(COALESCE(s.completed, 0) AS INTEGER) AS completed,
        CAST(COALESCE(s.rescheduled, 0) AS INTEGER) AS rescheduled,
        CAST(COALESCE(s.not_departed, 0) AS INTEGER) AS not_departed,
        s.scheduled_departure,
        s.scheduled_arrival,
        s.first_seen,
        s.last_seen,
        s.detail_last_seen,
        CAST(COALESCE(s.has_details, 0) AS INTEGER) AS has_details,
        CAST(COALESCE(s.latest_state_quality, 0) AS INTEGER) AS latest_state_quality,
        CAST(COALESCE(s.detail_quality, 0) AS INTEGER) AS detail_quality,
        CAST(COALESCE(o.observation_count, 0) AS BIGINT) AS observation_count,
        o.first_observed_at,
        o.last_observed_at,
        CAST(COALESCE(o.observation_quality, 0) AS INTEGER) AS observation_quality,
        CASE
            WHEN COALESCE(s.cancelled, 0)=0 AND COALESCE(s.completed, 0)=1
            THEN COALESCE(p.terminal_arrival_delay,
                 CASE WHEN COALESCE(s.has_details, 0)=1 THEN s.arrival_delay END)
        END AS final_arrival_delay,
        CASE
            WHEN COALESCE(s.cancelled, 0)=0 AND COALESCE(s.completed, 0)=1
            THEN COALESCE(p.origin_departure_delay,
                 CASE WHEN COALESCE(s.has_details, 0)=1 THEN s.departure_delay END)
        END AS final_departure_delay,
        p.terminal_arrival_actual,
        p.origin_departure_actual
    FROM train_services s
    JOIN analytics_service_date_batch b ON b.service_date=s.service_date
    LEFT JOIN stop_endpoints p
      ON p.service_date=s.service_date AND p.train_key=s.train_key
    LEFT JOIN observations o
      ON o.service_date=s.service_date AND o.train_key=s.train_key
)
SELECT *,
       CASE WHEN identity_quality='canonical' AND (cancelled=1 OR completed=1)
            THEN 1 ELSE 0 END AS outcome_eligible,
       CASE WHEN identity_quality='canonical' AND cancelled=0 AND completed=1
                  AND final_arrival_delay IS NOT NULL
            THEN 1 ELSE 0 END AS arrival_eligible,
       CASE WHEN cancelled=1 THEN 'cancelled'
            WHEN completed=1 THEN 'completed'
            ELSE 'incomplete' END AS outcome_status
FROM base
"""


STOP_FACT_SELECT_SQL = """
WITH stops AS (
    SELECT
        e.service_date,
        e.train_key,
        e.stop_number,
        e.station_code,
        e.station_name,
        e.stop_type,
        e.platform,
        e.arrival_expected,
        e.arrival_expected_date,
        e.arrival_actual,
        e.arrival_actual_date,
        e.arrival_delay,
        e.departure_expected,
        e.departure_expected_date,
        e.departure_actual,
        e.departure_actual_date,
        e.departure_delay,
        CAST(COALESCE(e.cancelled, 0) AS INTEGER) AS stop_cancelled,
        e.detail_observed_at,
        CAST(COALESCE(e.detail_quality, 0) AS INTEGER) AS stop_detail_quality,
        COALESCE(e.departure_delay, e.arrival_delay) AS event_delay,
        ROW_NUMBER() OVER (
            PARTITION BY e.service_date, e.train_key ORDER BY e.stop_number DESC
        ) AS reverse_position
    FROM train_stop_events e
    JOIN analytics_service_date_batch b ON b.service_date=e.service_date
)
SELECT
    s.*,
    f.train_number,
    f.operator,
    f.category,
    f.origin,
    f.destination,
    f.origin_code,
    f.destination_code,
    f.relation_key,
    f.cancelled AS service_cancelled,
    f.completed AS service_completed,
    f.identity_quality,
    CASE WHEN s.reverse_position=1 THEN 1 ELSE 0 END AS terminal_stop,
    s.event_delay - LAG(s.event_delay) OVER (
        PARTITION BY s.service_date, s.train_key ORDER BY s.stop_number
    ) AS delay_change
FROM stops s
JOIN (
    SELECT f.* FROM fact_service_outcome f
    JOIN analytics_service_date_batch b ON b.service_date=f.service_date
) f
  ON f.service_date=s.service_date AND f.train_key=s.train_key
"""


METRIC_COLUMNS = """
    COUNT(DISTINCT service_date) AS service_days,
    COUNT(*) AS observed_services,
    SUM(outcome_eligible) AS outcome_eligible_services,
    SUM(CASE WHEN outcome_eligible=1 AND cancelled=1 THEN 1 ELSE 0 END) AS cancelled_services,
    SUM(CASE WHEN outcome_eligible=1 AND completed=1 THEN 1 ELSE 0 END) AS completed_services,
    SUM(arrival_eligible) AS arrival_sample,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay <= 5 THEN 1 ELSE 0 END) AS within_5,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay <= 15 THEN 1 ELSE 0 END) AS within_15,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay > 30 THEN 1 ELSE 0 END) AS over_30,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay > 60 THEN 1 ELSE 0 END) AS over_60,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay > 120 THEN 1 ELSE 0 END) AS over_120,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay < 0 THEN 1 ELSE 0 END) AS bucket_early,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay BETWEEN 0 AND 5 THEN 1 ELSE 0 END) AS bucket_0_5,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay BETWEEN 6 AND 15 THEN 1 ELSE 0 END) AS bucket_6_15,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay BETWEEN 16 AND 30 THEN 1 ELSE 0 END) AS bucket_16_30,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay BETWEEN 31 AND 60 THEN 1 ELSE 0 END) AS bucket_31_60,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay BETWEEN 61 AND 120 THEN 1 ELSE 0 END) AS bucket_61_120,
    SUM(CASE WHEN arrival_eligible=1 AND final_arrival_delay > 120 THEN 1 ELSE 0 END) AS bucket_over_120,
    quantile_cont(final_arrival_delay, 0.5) FILTER (WHERE arrival_eligible=1) AS delay_p50,
    quantile_cont(final_arrival_delay, 0.75) FILTER (WHERE arrival_eligible=1) AS delay_p75,
    quantile_cont(final_arrival_delay, 0.9) FILTER (WHERE arrival_eligible=1) AS delay_p90,
    quantile_cont(final_arrival_delay, 0.95) FILTER (WHERE arrival_eligible=1) AS delay_p95,
    AVG(final_arrival_delay) FILTER (WHERE arrival_eligible=1) AS delay_mean
"""


def _create_quality_manifest(connection: Any, quality_days: Sequence[dict[str, Any]]) -> None:
    connection.execute(
        """
        CREATE OR REPLACE TABLE quality_manifest (
            collection_date VARCHAR,
            coverage_status VARCHAR,
            comparison_eligible INTEGER,
            schedule_complete INTEGER,
            scheduled_slot_count INTEGER,
            required_slot_count INTEGER,
            missing_run_slots INTEGER,
            missing_snapshot_slots INTEGER,
            observation_rows BIGINT,
            reason VARCHAR
        )
        """
    )
    rows = []
    for item in quality_days:
        rows.append(
            (
                str(item.get("date") or ""),
                str(item.get("coverageStatus") or "unknown"),
                int(bool(item.get("comparisonEligible"))),
                int(bool(item.get("scheduleComplete"))),
                int(item.get("scheduledSlotCount") or 0),
                int(item.get("requiredSlotCount") or 0),
                len(item.get("missingCollectorRunSlots") or []),
                len(item.get("missingSnapshotSlots") or []),
                int(item.get("observationRows") or 0),
                str(item.get("reason") or "") or None,
            )
        )
    if rows:
        connection.executemany(
            "INSERT INTO quality_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows
        )


def _build_stabilized_facts(
    connection: Any,
    *,
    max_date: str,
    max_history_days: int,
    batch_days: int,
) -> None:
    """Build service and stop facts in fixed service-date batches."""
    history_start = f"DATE '{max_date}' - INTERVAL {max_history_days - 1} DAY"
    service_dates = [
        row[0]
        for row in connection.execute(
            f"""
            SELECT DISTINCT service_date
            FROM train_services
            WHERE CAST(service_date AS DATE)
                  BETWEEN {history_start} AND DATE '{max_date}'
            ORDER BY service_date
            """
        ).fetchall()
    ]
    if not service_dates:
        raise RuntimeError("archive contains no stabilized train services")

    batch_count = (len(service_dates) + batch_days - 1) // batch_days
    first_batch = True
    for offset in range(0, len(service_dates), batch_days):
        batch = service_dates[offset : offset + batch_days]
        batch_number = offset // batch_days + 1
        log(
            "building stabilized fact batch "
            f"{batch_number}/{batch_count} ({batch[0]} through {batch[-1]})"
        )
        connection.execute(
            "CREATE OR REPLACE TABLE analytics_service_date_batch(service_date VARCHAR)"
        )
        connection.executemany(
            "INSERT INTO analytics_service_date_batch VALUES (?)",
            [(value,) for value in batch],
        )

        service_operation = (
            "CREATE OR REPLACE TABLE fact_service_outcome AS"
            if first_batch
            else "INSERT INTO fact_service_outcome"
        )
        connection.execute(f"{service_operation}\n{SERVICE_FACT_SELECT_SQL}")

        stop_operation = (
            "CREATE OR REPLACE TABLE fact_stop_outcome AS"
            if first_batch
            else "INSERT INTO fact_stop_outcome"
        )
        connection.execute(f"{stop_operation}\n{STOP_FACT_SELECT_SQL}")
        # Persist completed batches so their buffers can be evicted before the
        # next day's joins. The work database is disposable, never the live DB.
        connection.execute("CHECKPOINT")
        first_batch = False

    connection.execute("DROP TABLE analytics_service_date_batch")


def _build_rolling_windows(
    connection: Any,
    *,
    max_date: str,
    max_history_days: int,
    batch_days: int,
) -> None:
    """Build exact rolling metrics without one unbounded history cross join."""
    history_start = f"DATE '{max_date}' - INTERVAL {max_history_days - 1} DAY"
    as_of_dates = [
        row[0]
        for row in connection.execute(
            f"""
            SELECT DISTINCT CAST(service_date AS DATE) AS as_of_date
            FROM fact_service_outcome
            WHERE CAST(service_date AS DATE) BETWEEN {history_start} AND DATE '{max_date}'
            ORDER BY as_of_date
            """
        ).fetchall()
    ]
    if not as_of_dates:
        raise RuntimeError("archive contains no service dates for rolling Analytics windows")

    windows_sql = ",".join(f"({value})" for value in DEFAULT_WINDOWS)
    batch_count = (len(as_of_dates) + batch_days - 1) // batch_days
    first_batch = True
    for offset in range(0, len(as_of_dates), batch_days):
        batch = as_of_dates[offset : offset + batch_days]
        batch_number = offset // batch_days + 1
        log(
            "building rolling window batch "
            f"{batch_number}/{batch_count} ({batch[0]} through {batch[-1]})"
        )
        connection.execute(
            "CREATE OR REPLACE TABLE analytics_as_of_batch(as_of_date DATE)"
        )
        connection.executemany(
            "INSERT INTO analytics_as_of_batch VALUES (?)",
            [(value,) for value in batch],
        )

        network_operation = (
            "CREATE OR REPLACE TABLE network_window AS"
            if first_batch
            else "INSERT INTO network_window"
        )
        connection.execute(
            f"""
            {network_operation}
            WITH windows(window_days) AS (VALUES {windows_sql})
            SELECT CAST(a.as_of_date AS VARCHAR) AS as_of_date,
                   w.window_days,
                   CAST(a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY AS DATE)
                       AS window_start,
                   {METRIC_COLUMNS}
            FROM analytics_as_of_batch a CROSS JOIN windows w
            JOIN fact_service_outcome f
              ON CAST(f.service_date AS DATE)
                 BETWEEN a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY
                     AND a.as_of_date
            GROUP BY a.as_of_date, w.window_days
            """
        )

        dimension_operation = (
            "CREATE OR REPLACE TABLE dimension_window AS"
            if first_batch
            else "INSERT INTO dimension_window"
        )
        connection.execute(
            f"""
            {dimension_operation}
            WITH windows(window_days) AS (VALUES {windows_sql})
            SELECT CAST(a.as_of_date AS VARCHAR) AS as_of_date,
                   w.window_days,
                   CAST(a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY AS DATE)
                       AS window_start,
                   f.dimension_type,
                   f.dimension_key,
                   MAX(f.dimension_label) AS dimension_label,
                   {METRIC_COLUMNS}
            FROM analytics_as_of_batch a CROSS JOIN windows w
            JOIN rolling_dimension_fact f
              ON CAST(f.service_date AS DATE)
                 BETWEEN a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY
                     AND a.as_of_date
            GROUP BY a.as_of_date, w.window_days, f.dimension_type, f.dimension_key
            """
        )
        first_batch = False

    connection.execute("DROP TABLE analytics_as_of_batch")


def _build_dashboard_window(
    connection: Any,
    table: str,
    select_sql: str,
    *,
    scope_column: str | None = None,
    shard_column: str | None = None,
    periods: Sequence[str] = ("current", "previous"),
) -> None:
    """Aggregate disjoint output groups without expanding all windows/scopes.

    Each query still sees its entire service-date window: exact quantiles and
    distinct-service counts must never be combined from daily summaries.
    SQL identifiers and templates here are internal constants only.
    """
    first = True
    for window in DEFAULT_WINDOWS:
        for period in periods:
            log(f"building {table}: {window}-day {period} period")
            for scope in ("all", "operator", "category") if scope_column else (None,):
                predicate = f"p.window_days={window} AND p.period='{period}'"
                if scope_column:
                    predicate += f" AND {scope_column}='{scope}'"
                for shard in range(16 if shard_column else 1):
                    shard_predicate = predicate
                    if shard_column:
                        shard_predicate += f" AND hash({shard_column}) % 16 = {shard}"
                    operation = f"CREATE OR REPLACE TABLE {table} AS" if first else f"INSERT INTO {table}"
                    connection.execute(f"{operation}\n{select_sql.format(batch_filter=shard_predicate)}")
                    first = False


def _append_dimension_windows(connection: Any, select_sql: str, *, shard_column: str | None = None) -> None:
    """Keep exact station/relation quantiles within one window and key shard."""
    for window in DEFAULT_WINDOWS:
        for shard in range(16 if shard_column else 1):
            predicate = f"w.window_days={window}"
            if shard_column:
                predicate += f" AND hash({shard_column}) % 16 = {shard}"
            connection.execute("INSERT INTO dimension_window\n" + select_sql.format(batch_filter=predicate))


def _build_daily_table(connection: Any, table: str, select_sql: str, *, append: bool = False) -> None:
    """Daily output groups do not require one all-history aggregate state."""
    dates = connection.execute(
        "SELECT DISTINCT CAST(service_date AS DATE) FROM fact_service_outcome ORDER BY 1"
    ).fetchall()
    for (service_date,) in dates:
        operation = f"INSERT INTO {table}" if append else f"CREATE OR REPLACE TABLE {table} AS"
        predicate = f"CAST(service_date AS DATE)=DATE '{service_date.isoformat()}'"
        connection.execute(f"{operation}\n{select_sql.format(batch_filter=predicate)}")
        append = True


def build_semantic_tables(connection: Any, index: ArchiveIndex, config: AnalyticsConfig) -> str:
    log("building stabilized service and stop facts")
    max_date_value = connection.execute(
        "SELECT MAX(CAST(service_date AS DATE)) FROM train_services"
    ).fetchone()[0]
    if max_date_value is None:
        raise RuntimeError("archive contains no stabilized train services")
    max_date = max_date_value.isoformat()
    if config.as_of_date and config.as_of_date.isoformat() < max_date:
        max_date = config.as_of_date.isoformat()

    _build_stabilized_facts(
        connection,
        max_date=max_date,
        max_history_days=config.max_history_days,
        batch_days=config.fact_batch_days,
    )
    _create_quality_manifest(connection, index.quality_days)

    _build_daily_table(
        connection, "network_day",
        f"""
        SELECT service_date, {METRIC_COLUMNS}
        FROM fact_service_outcome
        WHERE {{batch_filter}}
        GROUP BY service_date
        ORDER BY service_date
        """
    )

    log("building collection quality mart")
    connection.execute(
        """
        CREATE OR REPLACE TABLE quality_day AS
        WITH run_day AS (
            SELECT date AS collection_date,
                   COUNT(*) AS collector_runs,
                   SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful_runs,
                   SUM(COALESCE(detail_attempts, 0)) AS detail_attempts,
                   SUM(COALESCE(details, 0)) AS details,
                   SUM(COALESCE(detail_failures, 0)) AS detail_failures,
                   MAX(COALESCE(stations, 0)) AS stations,
                   MAX(finished_at) AS last_finished_at
            FROM collector_runs GROUP BY date
        ), snapshot_day AS (
            SELECT date AS collection_date,
                   COUNT(*) AS snapshots,
                   SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful_snapshots,
                   MAX(COALESCE(treni_giorno, 0)) AS circulated,
                   MAX(COALESCE(treni_circolanti, 0)) AS peak_running,
                   MAX(COALESCE(finished_at, captured_at)) AS last_snapshot_at
            FROM snapshots GROUP BY date
        ), dates AS (
            SELECT collection_date FROM run_day
            UNION SELECT collection_date FROM snapshot_day
            UNION SELECT collection_date FROM quality_manifest
        )
        SELECT d.collection_date,
               COALESCE(q.coverage_status, 'unknown') AS coverage_status,
               COALESCE(q.comparison_eligible, 0) AS comparison_eligible,
               COALESCE(q.schedule_complete, 0) AS schedule_complete,
               COALESCE(q.scheduled_slot_count, 0) AS scheduled_slot_count,
               COALESCE(q.required_slot_count, 0) AS required_slot_count,
               COALESCE(q.missing_run_slots, 0) AS missing_run_slots,
               COALESCE(q.missing_snapshot_slots, 0) AS missing_snapshot_slots,
               COALESCE(q.observation_rows, 0) AS observation_rows,
               q.reason,
               COALESCE(r.collector_runs, 0) AS collector_runs,
               COALESCE(r.successful_runs, 0) AS successful_runs,
               COALESCE(r.detail_attempts, 0) AS detail_attempts,
               COALESCE(r.details, 0) AS details,
               COALESCE(r.detail_failures, 0) AS detail_failures,
               COALESCE(r.stations, 0) AS stations,
               r.last_finished_at,
               COALESCE(s.snapshots, 0) AS snapshots,
               COALESCE(s.successful_snapshots, 0) AS successful_snapshots,
               COALESCE(s.circulated, 0) AS circulated,
               COALESCE(s.peak_running, 0) AS peak_running,
               s.last_snapshot_at
        FROM dates d
        LEFT JOIN quality_manifest q USING (collection_date)
        LEFT JOIN run_day r USING (collection_date)
        LEFT JOIN snapshot_day s USING (collection_date)
        ORDER BY d.collection_date
        """
    )

    log("building network and dimension windows")
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW rolling_dimension_fact AS
        SELECT service_date, 'operator' AS dimension_type,
               COALESCE(operator, 'unknown') AS dimension_key,
               COALESCE(operator, 'unknown') AS dimension_label,
               outcome_eligible, arrival_eligible, cancelled, completed,
               final_arrival_delay
        FROM fact_service_outcome
        UNION ALL
        SELECT service_date, 'category',
               COALESCE(category, 'unknown'), COALESCE(category, 'unknown'),
               outcome_eligible, arrival_eligible, cancelled, completed,
               final_arrival_delay
        FROM fact_service_outcome
        """
    )
    _build_daily_table(
        connection, "dimension_day",
        f"""
        SELECT service_date, dimension_type, dimension_key,
               MAX(dimension_label) AS dimension_label,
               {METRIC_COLUMNS}
        FROM rolling_dimension_fact
        WHERE {{batch_filter}}
        GROUP BY service_date, dimension_type, dimension_key
        """
    )
    _build_daily_table(
        connection, "dimension_day",
        f"""
        SELECT service_date, 'relation' AS dimension_type,
               COALESCE(NULLIF(relation_key, ''), train_key) AS dimension_key,
               MAX(COALESCE(NULLIF(relation_key, ''), train_key)) AS dimension_label,
               {METRIC_COLUMNS}
        FROM fact_service_outcome
        WHERE {{batch_filter}}
        GROUP BY service_date, COALESCE(NULLIF(relation_key, ''), train_key)
        """, append=True,
    )
    _build_daily_table(
        connection, "dimension_day",
        f"""
        SELECT service_date, 'station' AS dimension_type, dimension_key,
               MAX(dimension_label) AS dimension_label,
               {METRIC_COLUMNS}
        FROM (
            SELECT service_date,
                   COALESCE(NULLIF(station_code, ''), 'unknown') AS dimension_key,
                   COALESCE(
                       NULLIF(station_name, ''), NULLIF(station_code, ''), 'unknown'
                   ) AS dimension_label,
                   CASE WHEN stop_cancelled=1 OR arrival_delay IS NOT NULL
                        THEN 1 ELSE 0 END AS outcome_eligible,
                   CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL
                        THEN 1 ELSE 0 END AS arrival_eligible,
                   stop_cancelled AS cancelled,
                   CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL
                        THEN 1 ELSE 0 END AS completed,
                   CASE WHEN stop_cancelled=0 THEN arrival_delay END AS final_arrival_delay
            FROM fact_stop_outcome
            WHERE station_code IS NOT NULL
        ) AS station_fact
        WHERE {{batch_filter}}
        GROUP BY service_date, dimension_key
        """, append=True,
    )
    windows_sql = ",".join(f"({value})" for value in DEFAULT_WINDOWS)
    _build_rolling_windows(
        connection,
        max_date=max_date,
        max_history_days=config.max_history_days,
        batch_days=config.window_batch_days,
    )
    _append_dimension_windows(
        connection,
        f"""
        WITH windows(window_days) AS (VALUES {windows_sql})
        SELECT '{max_date}' AS as_of_date,
               w.window_days,
               CAST(DATE '{max_date}' - (w.window_days - 1) * INTERVAL 1 DAY AS DATE)
                   AS window_start,
               'relation' AS dimension_type,
               COALESCE(NULLIF(f.relation_key, ''), f.train_key) AS dimension_key,
               MAX(COALESCE(NULLIF(f.relation_key, ''), f.train_key)) AS dimension_label,
               {METRIC_COLUMNS}
        FROM windows w
        JOIN fact_service_outcome f
          ON CAST(f.service_date AS DATE)
             BETWEEN DATE '{max_date}' - (w.window_days - 1) * INTERVAL 1 DAY
                 AND DATE '{max_date}'
        WHERE {{batch_filter}}
        GROUP BY w.window_days, COALESCE(NULLIF(f.relation_key, ''), f.train_key)
        """
    )
    _append_dimension_windows(
        connection,
        f"""
        WITH windows(window_days) AS (VALUES {windows_sql}),
        station_fact AS (
            SELECT service_date,
                   COALESCE(NULLIF(station_code, ''), 'unknown') AS dimension_key,
                   COALESCE(
                       NULLIF(station_name, ''), NULLIF(station_code, ''), 'unknown'
                   ) AS dimension_label,
                   CASE WHEN stop_cancelled=1 OR arrival_delay IS NOT NULL
                        THEN 1 ELSE 0 END AS outcome_eligible,
                   CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL
                        THEN 1 ELSE 0 END AS arrival_eligible,
                   stop_cancelled AS cancelled,
                   CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL
                        THEN 1 ELSE 0 END AS completed,
                   CASE WHEN stop_cancelled=0 THEN arrival_delay END AS final_arrival_delay
            FROM fact_stop_outcome
            WHERE station_code IS NOT NULL
        )
        SELECT '{max_date}' AS as_of_date,
               w.window_days,
               CAST(DATE '{max_date}' - (w.window_days - 1) * INTERVAL 1 DAY AS DATE)
                   AS window_start,
               'station' AS dimension_type,
               f.dimension_key,
               MAX(f.dimension_label) AS dimension_label,
               {METRIC_COLUMNS}
        FROM windows w
        JOIN station_fact f
          ON CAST(f.service_date AS DATE)
             BETWEEN DATE '{max_date}' - (w.window_days - 1) * INTERVAL 1 DAY
                 AND DATE '{max_date}'
        WHERE {{batch_filter}}
        GROUP BY w.window_days, f.dimension_key
        """, shard_column="f.dimension_key",
    )
    connection.execute("DROP VIEW rolling_dimension_fact")
    connection.execute(
        f"""
        CREATE OR REPLACE TABLE outlier_service AS
        WITH candidates AS (
            SELECT service_date, train_key,
                   ROW_NUMBER() OVER (
                       ORDER BY cancelled DESC, final_arrival_delay DESC NULLS LAST,
                                service_date DESC, train_number
                   ) AS global_rank,
                   ROW_NUMBER() OVER (
                       PARTITION BY operator
                       ORDER BY cancelled DESC, final_arrival_delay DESC NULLS LAST,
                                service_date DESC, train_number
                   ) AS operator_rank,
                   ROW_NUMBER() OVER (
                       PARTITION BY category
                       ORDER BY cancelled DESC, final_arrival_delay DESC NULLS LAST,
                                service_date DESC, train_number
                   ) AS category_rank,
                   ROW_NUMBER() OVER (
                       PARTITION BY operator, category
                       ORDER BY cancelled DESC, final_arrival_delay DESC NULLS LAST,
                                service_date DESC, train_number
                   ) AS operator_category_rank
            FROM fact_service_outcome
            WHERE CAST(service_date AS DATE)
                  BETWEEN DATE '{max_date}' - INTERVAL 89 DAY AND DATE '{max_date}'
              AND (arrival_eligible=1 OR cancelled=1)
        )
        SELECT service_date, train_key, train_number, operator, category,
               origin, destination, origin_code, destination_code, relation_key,
               status, cancelled, completed, final_arrival_delay,
               final_departure_delay, scheduled_departure, scheduled_arrival,
               first_observed_at, last_observed_at, observation_count,
               latest_state_quality, detail_quality, observation_quality
        FROM fact_service_outcome JOIN candidates USING (service_date, train_key)
        WHERE global_rank <= 5000 OR operator_rank <= 250
           OR category_rank <= 250 OR operator_category_rank <= 100
        """
    )

    log("building dashboard composition, rhythm, station, and service marts")
    connection.execute(
        f"""
        CREATE OR REPLACE TABLE dashboard_periods AS
        WITH windows(window_days) AS (VALUES {windows_sql})
        SELECT window_days, 'current' AS period,
               DATE '{max_date}' - (window_days - 1) * INTERVAL 1 DAY AS window_start,
               DATE '{max_date}' AS window_end
        FROM windows
        UNION ALL
        SELECT window_days, 'previous' AS period,
               DATE '{max_date}' - (window_days * 2 - 1) * INTERVAL 1 DAY AS window_start,
               DATE '{max_date}' - window_days * INTERVAL 1 DAY AS window_end
        FROM windows
        """
    )
    _build_dashboard_window(
        connection, "operator_category_window",
        f"""
        SELECT '{max_date}' AS as_of_date, p.window_days, p.period,
               CAST(p.window_start AS VARCHAR) AS window_start,
               CAST(p.window_end AS VARCHAR) AS window_end,
               COALESCE(f.operator, 'unknown') AS operator,
               COALESCE(f.category, 'unknown') AS category,
               {METRIC_COLUMNS}
        FROM dashboard_periods p
        JOIN fact_service_outcome f
          ON CAST(f.service_date AS DATE) BETWEEN p.window_start AND p.window_end
        WHERE {{batch_filter}}
        GROUP BY p.window_days, p.period, p.window_start, p.window_end,
                 COALESCE(f.operator, 'unknown'), COALESCE(f.category, 'unknown')
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW rhythm_scope_fact AS
        WITH base AS (
            SELECT *,
                   CAST(EXTRACT(ISODOW FROM CAST(service_date AS DATE)) - 1 AS INTEGER) AS weekday,
                   TRY_CAST(SUBSTR(scheduled_departure, 12, 2) AS INTEGER) AS departure_hour
            FROM fact_service_outcome
            WHERE scheduled_departure IS NOT NULL
        )
        SELECT *, 'all' AS filter_type, 'all' AS filter_key FROM base
        UNION ALL
        SELECT *, 'operator', COALESCE(operator, 'unknown') FROM base
        UNION ALL
        SELECT *, 'category', COALESCE(category, 'unknown') FROM base
        """
    )
    _build_dashboard_window(
        connection, "rhythm_window",
        f"""
        SELECT '{max_date}' AS as_of_date, p.window_days, p.period,
               r.filter_type, r.filter_key, r.weekday, r.departure_hour AS hour,
               {METRIC_COLUMNS}
        FROM dashboard_periods p
        JOIN rhythm_scope_fact r
          ON CAST(r.service_date AS DATE) BETWEEN p.window_start AND p.window_end
        WHERE r.departure_hour BETWEEN 0 AND 23 AND {{batch_filter}}
        GROUP BY p.window_days, p.period, r.filter_type, r.filter_key,
                 r.weekday, r.departure_hour
        """, scope_column="r.filter_type",
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW station_scope_fact AS
        WITH base AS (
            SELECT *,
                   COALESCE(NULLIF(station_name, ''), station_code) AS station_label,
                   CASE WHEN LOWER(COALESCE(stop_type, '')) IN ('origine', 'origin') THEN 'departure'
                        WHEN LOWER(COALESCE(stop_type, '')) IN ('destinazione', 'destination') THEN 'arrival'
                        ELSE 'transit' END AS station_role,
                   COALESCE(departure_expected, arrival_expected) AS station_expected,
                   COALESCE(departure_expected_date, arrival_expected_date, service_date) AS station_expected_date,
                   CASE WHEN stop_cancelled=1 OR arrival_delay IS NOT NULL THEN 1 ELSE 0 END AS outcome_eligible,
                   CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL THEN 1 ELSE 0 END AS arrival_eligible,
                   stop_cancelled AS cancelled,
                   CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL THEN 1 ELSE 0 END AS completed,
                   CASE WHEN stop_cancelled=0 THEN arrival_delay END AS final_arrival_delay
            FROM fact_stop_outcome
            WHERE station_code IS NOT NULL AND identity_quality='canonical'
        )
        SELECT *, 'all' AS filter_type, 'all' AS filter_key FROM base
        UNION ALL
        SELECT *, 'operator', COALESCE(operator, 'unknown') FROM base
        UNION ALL
        SELECT *, 'category', COALESCE(category, 'unknown') FROM base
        """
    )
    _build_dashboard_window(
        connection, "station_window",
        f"""
        SELECT '{max_date}' AS as_of_date, p.window_days, p.period,
               s.filter_type, s.filter_key, s.station_code,
               MAX(s.station_label) AS station_label,
               COUNT(DISTINCT s.service_date || '|' || s.train_key) AS observed_services,
               COUNT(DISTINCT CASE WHEN s.station_role='arrival' THEN s.service_date || '|' || s.train_key END) AS arrivals,
               COUNT(DISTINCT CASE WHEN s.station_role='departure' THEN s.service_date || '|' || s.train_key END) AS departures,
               COUNT(DISTINCT CASE WHEN s.station_role='transit' THEN s.service_date || '|' || s.train_key END) AS transits,
               SUM(s.outcome_eligible) AS outcome_eligible_services,
               SUM(CASE WHEN s.outcome_eligible=1 AND s.cancelled=1 THEN 1 ELSE 0 END) AS cancelled_services,
               SUM(s.arrival_eligible) AS arrival_sample,
               SUM(CASE WHEN s.arrival_eligible=1 AND s.final_arrival_delay <= 5 THEN 1 ELSE 0 END) AS within_5,
               SUM(CASE WHEN s.arrival_eligible=1 AND s.final_arrival_delay <= 15 THEN 1 ELSE 0 END) AS within_15,
               SUM(CASE WHEN s.arrival_eligible=1 AND s.final_arrival_delay > 60 THEN 1 ELSE 0 END) AS over_60,
               quantile_cont(s.final_arrival_delay, 0.5) FILTER (WHERE s.arrival_eligible=1) AS delay_p50,
               quantile_cont(s.final_arrival_delay, 0.9) FILTER (WHERE s.arrival_eligible=1) AS delay_p90
        FROM dashboard_periods p
        JOIN station_scope_fact s
          ON CAST(s.service_date AS DATE) BETWEEN p.window_start AND p.window_end
        WHERE {{batch_filter}}
        GROUP BY p.window_days, p.period, s.filter_type, s.filter_key,
                 s.station_code
        """, scope_column="s.filter_type", shard_column="s.station_code",
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TABLE top_station AS
        SELECT station_code
        FROM station_window
        WHERE as_of_date='{max_date}' AND window_days=90 AND period='current'
          AND filter_type='all' AND filter_key='all'
        ORDER BY observed_services DESC, station_code
        LIMIT 250
        """
    )
    _build_dashboard_window(
        connection, "station_hour_window",
        f"""
        WITH timed AS (
            SELECT s.*,
                   CAST(EXTRACT(ISODOW FROM CAST(s.station_expected_date AS DATE)) - 1 AS INTEGER) AS weekday,
                   TRY_CAST(SUBSTR(s.station_expected, 12, 2) AS INTEGER) AS hour
            FROM station_scope_fact s
            JOIN top_station t USING (station_code)
            WHERE s.filter_type='all' AND s.filter_key='all'
              AND s.station_expected IS NOT NULL
        )
        SELECT '{max_date}' AS as_of_date, p.window_days,
               t.station_code, MAX(t.station_label) AS station_label,
               t.weekday, t.hour,
               COUNT(DISTINCT t.service_date || '|' || t.train_key) AS observed_services,
               COUNT(DISTINCT CASE WHEN t.station_role='arrival' THEN t.service_date || '|' || t.train_key END) AS arrivals,
               COUNT(DISTINCT CASE WHEN t.station_role='departure' THEN t.service_date || '|' || t.train_key END) AS departures,
               COUNT(DISTINCT CASE WHEN t.station_role='transit' THEN t.service_date || '|' || t.train_key END) AS transits
        FROM dashboard_periods p
        JOIN timed t ON CAST(t.service_date AS DATE) BETWEEN p.window_start AND p.window_end
        WHERE {{batch_filter}} AND t.hour BETWEEN 0 AND 23
        GROUP BY p.window_days, t.station_code, t.weekday, t.hour
        """, periods=("current",),
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW relation_scope_fact AS
        WITH base AS (
            SELECT *,
                   COALESCE(NULLIF(relation_key, ''), train_key) AS relation_id,
                   COALESCE(NULLIF(relation_key, ''), train_key) AS relation_label,
                   CASE WHEN arrival_eligible=1 AND final_departure_delay IS NOT NULL
                        THEN final_arrival_delay - final_departure_delay END AS delay_change,
                   CASE WHEN scheduled_departure IS NOT NULL AND scheduled_arrival IS NOT NULL
                        THEN CASE WHEN SUBSTR(scheduled_arrival, 1, 10) > SUBSTR(scheduled_departure, 1, 10)
                                  THEN 1 ELSE 0 END END AS cross_midnight,
                   CASE WHEN TRY_CAST(scheduled_departure AS TIMESTAMPTZ) IS NOT NULL
                             AND TRY_CAST(scheduled_arrival AS TIMESTAMPTZ) IS NOT NULL
                        THEN (EPOCH(TRY_CAST(scheduled_arrival AS TIMESTAMPTZ))
                            - EPOCH(TRY_CAST(scheduled_departure AS TIMESTAMPTZ))) / 60.0 END AS scheduled_duration_minutes
            FROM fact_service_outcome
            WHERE identity_quality='canonical'
        )
        SELECT *, 'all' AS filter_type, 'all' AS filter_key FROM base
        UNION ALL
        SELECT *, 'operator', COALESCE(operator, 'unknown') FROM base
        UNION ALL
        SELECT *, 'category', COALESCE(category, 'unknown') FROM base
        """
    )
    _build_dashboard_window(
        connection, "relation_feature_window",
        f"""
        SELECT '{max_date}' AS as_of_date, p.window_days, p.period,
               r.filter_type, r.filter_key, r.relation_id, MAX(r.relation_label) AS relation_label,
               {METRIC_COLUMNS},
               COUNT(*) FILTER (WHERE r.delay_change IS NOT NULL) AS recovery_sample,
               COUNT(*) FILTER (WHERE r.delay_change < 0) AS recovered_services,
               AVG(r.delay_change) FILTER (WHERE r.delay_change IS NOT NULL) AS delay_change_mean,
               quantile_cont(r.delay_change, 0.5) FILTER (WHERE r.delay_change IS NOT NULL) AS delay_change_p50,
               SUM(r.cross_midnight) AS cross_midnight_services,
               COUNT(*) FILTER (WHERE r.scheduled_duration_minutes >= 0) AS duration_sample,
               AVG(r.scheduled_duration_minutes) FILTER (WHERE r.scheduled_duration_minutes >= 0) AS duration_mean,
               MAX(r.scheduled_duration_minutes) FILTER (WHERE r.scheduled_duration_minutes >= 0) AS duration_max
        FROM dashboard_periods p
        JOIN relation_scope_fact r
          ON CAST(r.service_date AS DATE) BETWEEN p.window_start AND p.window_end
        WHERE {{batch_filter}}
        GROUP BY p.window_days, p.period, r.filter_type, r.filter_key,
                 r.relation_id
        """, scope_column="r.filter_type",
    )
    _build_dashboard_window(
        connection, "cross_midnight_window",
        f"""
        SELECT '{max_date}' AS as_of_date, p.window_days, p.period,
               r.filter_type, r.filter_key,
               COUNT(*) FILTER (WHERE r.cross_midnight IS NOT NULL) AS observed_services,
               SUM(r.cross_midnight) AS cross_midnight_services,
               COUNT(*) FILTER (WHERE r.scheduled_duration_minutes >= 0) AS duration_sample,
               AVG(r.scheduled_duration_minutes) FILTER (WHERE r.scheduled_duration_minutes >= 0) AS duration_mean,
               quantile_cont(r.scheduled_duration_minutes, 0.9)
                   FILTER (WHERE r.scheduled_duration_minutes >= 0) AS duration_p90
        FROM dashboard_periods p
        JOIN relation_scope_fact r
          ON CAST(r.service_date AS DATE) BETWEEN p.window_start AND p.window_end
        WHERE {{batch_filter}}
        GROUP BY p.window_days, p.period, r.filter_type, r.filter_key
        """, scope_column="r.filter_type",
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TABLE long_journey_service AS
        SELECT service_date, train_key, train_number, operator, category,
               origin, destination, origin_code, destination_code, relation_key,
               scheduled_departure, scheduled_arrival, scheduled_duration_minutes,
               cross_midnight, delay_change, final_departure_delay,
               final_arrival_delay, observation_count
        FROM relation_scope_fact
        WHERE filter_type='all' AND filter_key='all'
          AND CAST(service_date AS DATE)
              BETWEEN DATE '{max_date}' - INTERVAL 89 DAY AND DATE '{max_date}'
          AND scheduled_duration_minutes >= 0
        ORDER BY scheduled_duration_minutes DESC, service_date DESC, train_number
        LIMIT 1000
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TABLE outlier_stop AS
        SELECT s.service_date, s.train_key, s.stop_number, s.station_code,
               s.station_name, s.stop_type, s.platform,
               s.arrival_expected, s.arrival_actual, s.arrival_delay,
               s.departure_expected, s.departure_actual, s.departure_delay,
               s.stop_cancelled, s.delay_change
        FROM fact_stop_outcome s
        JOIN outlier_service o
          ON o.service_date=s.service_date AND o.train_key=s.train_key
        ORDER BY s.service_date, s.train_key, s.stop_number
        """
    )
    return max_date


def _sqlite_type(duckdb_type: Any) -> str:
    value = str(duckdb_type).upper()
    if any(token in value for token in ("INT", "BOOL")):
        return "INTEGER"
    if any(token in value for token in ("DOUBLE", "FLOAT", "REAL", "DECIMAL")):
        return "REAL"
    return "TEXT"


def _sqlite_value(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bool):
        return int(value)
    return value


def _copy_table(duck: Any, sqlite: sqlite3.Connection, table: str) -> int:
    cursor = duck.execute(f"SELECT * FROM {table} LIMIT 0")
    columns = [item[0] for item in cursor.description]
    types = [item[1] for item in cursor.description]
    definitions = ", ".join(
        f'"{name}" {_sqlite_type(kind)}' for name, kind in zip(columns, types)
    )
    sqlite.execute(f'CREATE TABLE "{table}" ({definitions})')
    placeholders = ",".join("?" for _ in columns)
    inserted = 0
    # fetchmany() alone only bounds Python tuples: execute() can retain the
    # entire native result. These finalized work tables are immutable, so
    # physical rowid ranges bound both sides of the DuckDB -> SQLite handoff.
    last_rowid = duck.execute(f"SELECT MAX(rowid) FROM {table}").fetchone()[0]
    for start in range(0, last_rowid + 1 if last_rowid is not None else 0, 5000):
        rows = duck.execute(
            f"SELECT * FROM {table} WHERE rowid >= ? AND rowid < ?",
            [start, start + 5000],
        ).fetchall()
        sqlite.executemany(
            f'INSERT INTO "{table}" VALUES ({placeholders})',
            [tuple(_sqlite_value(value) for value in row) for row in rows],
        )
        inserted += len(rows)
    return inserted


@contextmanager
def _sqlite_disk_temp(root: Path):
    """Route Unix SQLite index-sort spill off the container's small /tmp tmpfs.

    This builder is an offline, single-threaded process. Keep the process-wide
    environment override scoped to its SQLite connection and restore it even
    when export fails. Windows SQLite uses the OS disk temp directory instead.
    """
    with tempfile.TemporaryDirectory(prefix="sqlite-temp-", dir=root) as temporary:
        previous = os.environ.get("SQLITE_TMPDIR")
        os.environ["SQLITE_TMPDIR"] = str(Path(temporary).resolve())
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("SQLITE_TMPDIR", None)
            else:
                os.environ["SQLITE_TMPDIR"] = previous


def _write_read_model(
    connection: Any,
    destination: Path,
    *,
    config: AnalyticsConfig,
    index: ArchiveIndex,
    as_of_date: str,
    build_id: str,
    built_at: str,
) -> dict[str, int]:
    table_names = (
        "quality_day",
        "network_day",
        "dimension_day",
        "network_window",
        "dimension_window",
        "outlier_service",
        "operator_category_window",
        "rhythm_window",
        "station_window",
        "station_hour_window",
        "relation_feature_window",
        "cross_midnight_window",
        "long_journey_service",
        "outlier_stop",
    )
    rows: dict[str, int] = {}
    with _sqlite_disk_temp(destination.parent), closing(sqlite3.connect(destination)) as output:
        output.execute("PRAGMA journal_mode=DELETE")
        output.execute("PRAGMA synchronous=FULL")
        output.execute("PRAGMA temp_store=FILE")
        output.execute(
            "CREATE TABLE analytics_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        metadata = {
            "schemaVersion": str(ANALYTICS_SCHEMA_VERSION),
            "metricDefinitionVersion": METRIC_DEFINITION_VERSION,
            "buildId": build_id,
            "builtAt": built_at,
            "asOfDate": as_of_date,
            "sourceLatestCreatedAt": index.latest_created_at,
            "sourceLatestAsOfDate": index.latest_as_of_date,
            "sourceManifests": json.dumps(index.manifests, separators=(",", ":")),
            "windows": json.dumps(DEFAULT_WINDOWS),
            "minimumRankingSample": str(config.minimum_ranking_sample),
        }
        output.executemany(
            "INSERT INTO analytics_metadata VALUES (?, ?)", metadata.items()
        )
        for table in table_names:
            log(f"exporting SQLite table {table}")
            rows[table] = _copy_table(connection, output, table)

        log("building SQLite indexes with disk-backed temporary storage")
        output.execute("CREATE UNIQUE INDEX idx_quality_day ON quality_day(collection_date)")
        output.execute("CREATE UNIQUE INDEX idx_network_day ON network_day(service_date)")
        output.execute(
            "CREATE INDEX idx_dimension_day ON dimension_day(dimension_type, dimension_key, service_date)"
        )
        output.execute(
            "CREATE UNIQUE INDEX idx_network_window ON network_window(as_of_date, window_days)"
        )
        output.execute(
            "CREATE UNIQUE INDEX idx_dimension_window ON dimension_window(as_of_date, window_days, dimension_type, dimension_key)"
        )
        output.execute(
            "CREATE INDEX idx_outlier_window ON outlier_service(service_date, cancelled, final_arrival_delay DESC)"
        )
        output.execute(
            "CREATE INDEX idx_outlier_filter ON outlier_service(operator, category, service_date)"
        )
        output.execute(
            "CREATE INDEX idx_operator_category_window ON operator_category_window(as_of_date, window_days, period, operator, category)"
        )
        output.execute(
            "CREATE INDEX idx_rhythm_window ON rhythm_window(as_of_date, window_days, period, filter_type, filter_key, weekday, hour)"
        )
        output.execute(
            "CREATE INDEX idx_station_window ON station_window(as_of_date, window_days, period, filter_type, filter_key, observed_services DESC)"
        )
        output.execute(
            "CREATE INDEX idx_station_hour_window ON station_hour_window(as_of_date, window_days, station_code, weekday, hour)"
        )
        output.execute(
            "CREATE INDEX idx_relation_feature_window ON relation_feature_window(as_of_date, window_days, period, filter_type, filter_key, observed_services DESC)"
        )
        output.execute(
            "CREATE INDEX idx_cross_midnight_window ON cross_midnight_window(as_of_date, window_days, period, filter_type, filter_key)"
        )
        output.execute(
            "CREATE INDEX idx_long_journey_window ON long_journey_service(service_date, operator, category, scheduled_duration_minutes DESC)"
        )
        output.execute(
            "CREATE INDEX idx_outlier_stop ON outlier_stop(service_date, train_key, stop_number)"
        )
        log("analyzing and checking SQLite read model")
        output.execute("ANALYZE")
        output.commit()
        check = output.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"analytics SQLite quick_check failed: {check}")
    return rows


def analytics_build(config: AnalyticsConfig) -> dict[str, Any]:
    index = load_archive_index(config.archive_root)
    config.analytics_root.mkdir(parents=True, exist_ok=True)
    with analytics_lock(config.analytics_root):
        removed_work_roots = remove_abandoned_work_roots(config.analytics_root)
        if removed_work_roots:
            unit = "directory" if removed_work_roots == 1 else "directories"
            log(f"removed {removed_work_roots} abandoned Analytics working {unit}")
        build_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        built_at = utc_now_iso()
        work_root = Path(tempfile.mkdtemp(prefix="analytics-", dir=config.analytics_root))
        final_path = config.analytics_root / "analytics.db"
        partial_path = config.analytics_root / ".analytics.db.partial"
        partial_path.unlink(missing_ok=True)
        destination = work_root / "analytics.db"
        try:
            duckdb = _import_duckdb()
            temp_root = work_root / "duckdb-temp"
            temp_root.mkdir()
            connection = duckdb.connect(
                database=str(work_root / "work.duckdb"),
                config={
                    "memory_limit": config.memory_limit,
                    "threads": str(config.threads),
                    "temp_directory": str(temp_root),
                    "max_temp_directory_size": config.max_temp_directory_size,
                    "preserve_insertion_order": "false",
                }
            )
            try:
                _create_archive_views(connection, index)
                as_of_date = build_semantic_tables(connection, index, config)
                rows = _write_read_model(
                    connection,
                    destination,
                    config=config,
                    index=index,
                    as_of_date=as_of_date,
                    build_id=build_id,
                    built_at=built_at,
                )
            finally:
                connection.close()

            shutil.move(destination, partial_path)
            os.replace(partial_path, final_path)
            return {
                "mode": "build",
                "status": "success",
                "buildId": build_id,
                "builtAt": built_at,
                "asOfDate": as_of_date,
                "metricDefinitionVersion": METRIC_DEFINITION_VERSION,
                "sourceManifests": list(index.manifests),
                "database": str(final_path),
                "databaseBytes": final_path.stat().st_size,
                "rows": rows,
            }
        finally:
            partial_path.unlink(missing_ok=True)
            shutil.rmtree(work_root, ignore_errors=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Build BelloTreno professional analytics marts from verified Parquet."
    )
    result.add_argument("--archive-root", help="verified Parquet archive root")
    result.add_argument("--analytics-root", help="analytics read-model output root")
    result.add_argument("--as-of-date", help="optional maximum service date (YYYY-MM-DD)")
    result.add_argument("command", choices=("build", "cleanup"))
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        config = AnalyticsConfig.from_args(args)
        result = (
            analytics_build(config)
            if args.command == "build"
            else analytics_cleanup(config)
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        log(f"failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
