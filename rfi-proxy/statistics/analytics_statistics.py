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


ANALYTICS_SCHEMA_VERSION = 1
METRIC_DEFINITION_VERSION = "2026-08-09-v1"
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
            memory_limit=os.environ.get("ANALYTICS_DUCKDB_MEMORY_LIMIT", "384MB"),
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


SERVICE_FACT_SQL = """
CREATE OR REPLACE TEMP TABLE fact_service_outcome AS
WITH terminal AS (
    SELECT service_date, train_key, arrival_delay, arrival_actual,
           ROW_NUMBER() OVER (
               PARTITION BY service_date, train_key
               ORDER BY stop_number DESC
           ) AS position
    FROM train_stop_events
),
origin_stop AS (
    SELECT service_date, train_key, departure_delay, departure_actual,
           ROW_NUMBER() OVER (
               PARTITION BY service_date, train_key
               ORDER BY stop_number ASC
           ) AS position
    FROM train_stop_events
),
observations AS (
    SELECT service_date, train_key, COUNT(*) AS observation_count,
           MIN(observed_at) AS first_observed_at,
           MAX(observed_at) AS last_observed_at,
           MAX(quality_score) AS observation_quality
    FROM train_observations
    GROUP BY service_date, train_key
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
            THEN COALESCE(t.arrival_delay,
                 CASE WHEN COALESCE(s.has_details, 0)=1 THEN s.arrival_delay END)
        END AS final_arrival_delay,
        CASE
            WHEN COALESCE(s.cancelled, 0)=0 AND COALESCE(s.completed, 0)=1
            THEN COALESCE(p.departure_delay,
                 CASE WHEN COALESCE(s.has_details, 0)=1 THEN s.departure_delay END)
        END AS final_departure_delay,
        t.arrival_actual AS terminal_arrival_actual,
        p.departure_actual AS origin_departure_actual
    FROM train_services s
    LEFT JOIN terminal t
      ON t.service_date=s.service_date AND t.train_key=s.train_key AND t.position=1
    LEFT JOIN origin_stop p
      ON p.service_date=s.service_date AND p.train_key=s.train_key AND p.position=1
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


STOP_FACT_SQL = """
CREATE OR REPLACE TEMP TABLE fact_stop_outcome AS
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
JOIN fact_service_outcome f
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
        CREATE OR REPLACE TEMP TABLE quality_manifest (
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


def build_semantic_tables(connection: Any, index: ArchiveIndex, config: AnalyticsConfig) -> str:
    log("building stabilized service and stop facts")
    connection.execute(SERVICE_FACT_SQL)
    connection.execute(STOP_FACT_SQL)
    _create_quality_manifest(connection, index.quality_days)

    max_date_value = connection.execute(
        "SELECT MAX(CAST(service_date AS DATE)) FROM fact_service_outcome"
    ).fetchone()[0]
    if max_date_value is None:
        raise RuntimeError("archive contains no stabilized train services")
    max_date = max_date_value.isoformat()
    if config.as_of_date and config.as_of_date.isoformat() < max_date:
        max_date = config.as_of_date.isoformat()

    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE network_day AS
        SELECT service_date, {METRIC_COLUMNS}
        FROM fact_service_outcome
        WHERE CAST(service_date AS DATE) <= DATE '{max_date}'
        GROUP BY service_date
        ORDER BY service_date
        """
    )

    log("building collection quality mart")
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE quality_day AS
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
        CREATE OR REPLACE TEMP TABLE dimension_fact AS
        SELECT service_date, train_key, 'operator' AS dimension_type,
               COALESCE(operator, 'unknown') AS dimension_key,
               COALESCE(operator, 'unknown') AS dimension_label,
               outcome_eligible, arrival_eligible, cancelled, completed,
               final_arrival_delay
        FROM fact_service_outcome
        UNION ALL
        SELECT service_date, train_key, 'category',
               COALESCE(category, 'unknown'), COALESCE(category, 'unknown'),
               outcome_eligible, arrival_eligible, cancelled, completed,
               final_arrival_delay
        FROM fact_service_outcome
        UNION ALL
        SELECT service_date, train_key, 'relation',
               COALESCE(NULLIF(relation_key, ''), train_key),
               COALESCE(NULLIF(relation_key, ''), train_key),
               outcome_eligible, arrival_eligible, cancelled, completed,
               final_arrival_delay
        FROM fact_service_outcome
        UNION ALL
        SELECT service_date, train_key, 'station',
               COALESCE(NULLIF(station_code, ''), 'unknown'),
               COALESCE(NULLIF(station_name, ''), NULLIF(station_code, ''), 'unknown'),
               CASE WHEN stop_cancelled=1 OR arrival_delay IS NOT NULL THEN 1 ELSE 0 END,
               CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL THEN 1 ELSE 0 END,
               stop_cancelled,
               CASE WHEN stop_cancelled=0 AND arrival_delay IS NOT NULL THEN 1 ELSE 0 END,
               CASE WHEN stop_cancelled=0 THEN arrival_delay END
        FROM fact_stop_outcome
        WHERE station_code IS NOT NULL
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE dimension_day AS
        SELECT service_date, dimension_type, dimension_key,
               MAX(dimension_label) AS dimension_label,
               {METRIC_COLUMNS}
        FROM dimension_fact
        WHERE CAST(service_date AS DATE) <= DATE '{max_date}'
        GROUP BY service_date, dimension_type, dimension_key
        """
    )
    windows_sql = ",".join(f"({value})" for value in DEFAULT_WINDOWS)
    history_start = f"DATE '{max_date}' - INTERVAL {config.max_history_days - 1} DAY"
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE network_window AS
        WITH as_of_dates AS (
            SELECT DISTINCT CAST(service_date AS DATE) AS as_of_date
            FROM fact_service_outcome
            WHERE CAST(service_date AS DATE) BETWEEN {history_start} AND DATE '{max_date}'
        ), windows(window_days) AS (VALUES {windows_sql})
        SELECT CAST(a.as_of_date AS VARCHAR) AS as_of_date,
               w.window_days,
               CAST(a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY AS DATE) AS window_start,
               {METRIC_COLUMNS}
        FROM as_of_dates a CROSS JOIN windows w
        JOIN fact_service_outcome f
          ON CAST(f.service_date AS DATE)
             BETWEEN a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY
                 AND a.as_of_date
        GROUP BY a.as_of_date, w.window_days
        ORDER BY a.as_of_date, w.window_days
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE dimension_window AS
        WITH as_of_dates AS (
            SELECT DISTINCT CAST(service_date AS DATE) AS as_of_date
            FROM fact_service_outcome
            WHERE CAST(service_date AS DATE) BETWEEN {history_start} AND DATE '{max_date}'
        ), windows(window_days) AS (VALUES {windows_sql})
        SELECT CAST(a.as_of_date AS VARCHAR) AS as_of_date,
               w.window_days,
               CAST(a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY AS DATE) AS window_start,
               f.dimension_type,
               f.dimension_key,
               MAX(f.dimension_label) AS dimension_label,
               {METRIC_COLUMNS}
        FROM as_of_dates a CROSS JOIN windows w
        JOIN dimension_fact f
          ON CAST(f.service_date AS DATE)
             BETWEEN a.as_of_date - (w.window_days - 1) * INTERVAL 1 DAY
                 AND a.as_of_date
        WHERE f.dimension_type IN ('operator', 'category') OR a.as_of_date=DATE '{max_date}'
        GROUP BY a.as_of_date, w.window_days, f.dimension_type, f.dimension_key
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE outlier_service AS
        WITH candidates AS (
            SELECT *,
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
        FROM candidates
        WHERE global_rank <= 5000 OR operator_rank <= 250
           OR category_rank <= 250 OR operator_category_rank <= 100
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
    cursor = duck.execute(f"SELECT * FROM {table}")
    columns = [item[0] for item in cursor.description]
    types = [item[1] for item in cursor.description]
    definitions = ", ".join(
        f'"{name}" {_sqlite_type(kind)}' for name, kind in zip(columns, types)
    )
    sqlite.execute(f'CREATE TABLE "{table}" ({definitions})')
    placeholders = ",".join("?" for _ in columns)
    inserted = 0
    while True:
        rows = cursor.fetchmany(5000)
        if not rows:
            break
        sqlite.executemany(
            f'INSERT INTO "{table}" VALUES ({placeholders})',
            [tuple(_sqlite_value(value) for value in row) for row in rows],
        )
        inserted += len(rows)
    return inserted


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
    )
    rows: dict[str, int] = {}
    with closing(sqlite3.connect(destination)) as output:
        output.execute("PRAGMA journal_mode=DELETE")
        output.execute("PRAGMA synchronous=FULL")
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
            rows[table] = _copy_table(connection, output, table)

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
                config={
                    "memory_limit": config.memory_limit,
                    "threads": str(config.threads),
                    "temp_directory": str(temp_root),
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
    result.add_argument("command", choices=("build",))
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = analytics_build(AnalyticsConfig.from_args(args))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        log(f"failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
