from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from statistics_storage import (
    backfill_legacy_batch,
    initialize_v2_schema,
    migration_state,
    save_migration_state,
)


def connect(path: str, *, read_only: bool) -> sqlite3.Connection:
    target = f"file:{path}?mode=ro" if read_only else path
    conn = sqlite3.connect(target, uri=read_only, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    if read_only:
        conn.execute("PRAGMA query_only=ON")
    else:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
    return conn


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone() is not None


def profile(conn: sqlite3.Connection, database_path: str) -> dict[str, Any]:
    path = Path(database_path).resolve()
    disk = shutil.disk_usage(path.parent)
    result: dict[str, Any] = {
        "databaseBytes": path.stat().st_size if path.exists() else 0,
        "walBytes": Path(f"{path}-wal").stat().st_size if Path(f"{path}-wal").exists() else 0,
        "diskFreeBytes": disk.free,
        "legacyTrains": conn.execute("SELECT COUNT(*) FROM trains").fetchone()[0],
        "legacyStops": conn.execute("SELECT COUNT(*) FROM train_stops").fetchone()[0],
        "collectionDateDiffersFromServiceDate": conn.execute(
            """
            SELECT COUNT(*)
            FROM trains
            WHERE service_date IS NOT NULL AND service_date<>'' AND date<>service_date
            """
        ).fetchone()[0],
        "legacyRowsMissingServiceDate": conn.execute(
            "SELECT COUNT(*) FROM trains WHERE service_date IS NULL OR service_date=''"
        ).fetchone()[0],
        "maxLegacyRowid": conn.execute("SELECT COALESCE(MAX(rowid), 0) FROM trains").fetchone()[0],
    }
    v2_tables = {
        "v2Services": "train_services",
        "v2Observations": "train_observations",
        "v2StopEvents": "train_stop_events",
        "v2RawPayloads": "train_raw_payloads",
    }
    missing_v2_tables = []
    for output_name, table in v2_tables.items():
        if table_exists(conn, table):
            result[output_name] = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        else:
            missing_v2_tables.append(table)
    result["missingV2Tables"] = missing_v2_tables
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill BelloTreno additive statistics v2 tables in bounded batches."
    )
    parser.add_argument(
        "--database",
        default=os.getenv("SQLITE_PATH", "/data/statistics.db"),
        help="SQLite database path (default: SQLITE_PATH or /data/statistics.db)",
    )
    parser.add_argument("--apply", action="store_true", help="Apply the backfill; default is read-only dry-run")
    parser.add_argument("--include-stops", action="store_true", help="Also backfill normalized stop events")
    parser.add_argument("--batch-size", type=int, default=500, help="Legacy train rows per transaction")
    parser.add_argument("--max-batches", type=int, default=0, help="Stop after this many batches; 0 means no limit")
    parser.add_argument("--pause-ms", type=int, default=100, help="Pause between committed batches")
    parser.add_argument(
        "--maintenance-window",
        action="store_true",
        help="Confirm the collector is paused before an optional stop-event backfill",
    )
    parser.add_argument(
        "--force-low-space",
        action="store_true",
        help="Override the free-space guard after external backup and capacity review",
    )
    parser.add_argument("--reset-progress", action="store_true", help="Restart this idempotent backfill from rowid 0")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.batch_size < 1 or args.batch_size > 5000:
        raise SystemExit("--batch-size must be between 1 and 5000")
    if args.pause_ms < 0 or args.pause_ms > 60000:
        raise SystemExit("--pause-ms must be between 0 and 60000")
    if args.max_batches < 0:
        raise SystemExit("--max-batches must be zero or greater")

    preflight_conn = connect(args.database, read_only=True)
    try:
        capacity = profile(preflight_conn, args.database)
    finally:
        preflight_conn.close()

    estimated_growth = int(capacity["legacyTrains"]) * 1024
    if args.include_stops:
        estimated_growth += int(capacity["legacyStops"]) * 768
    minimum_free = max(
        1024**3,
        estimated_growth * 2,
        int(capacity["databaseBytes"] * 0.1),
    )
    if args.include_stops:
        minimum_free = max(minimum_free, 2 * 1024**3)
    preflight = {
        **capacity,
        "estimatedV2GrowthBytes": estimated_growth,
        "estimateIncludesStops": bool(args.include_stops),
        "requiredFreeBytes": minimum_free,
    }

    if not args.apply:
        print(json.dumps({"mode": "dry-run", **preflight}, ensure_ascii=False, indent=2))
        return 0

    if args.include_stops and not args.maintenance_window:
        raise SystemExit(
            "--include-stops requires --maintenance-window after pausing the collector"
        )
    if capacity["diskFreeBytes"] < minimum_free and not args.force_low_space:
        raise SystemExit(
            "backfill refused: free space is below the estimated safety threshold; "
            "verify an external backup and use --force-low-space only after capacity review"
        )

    migration_name = "legacy-stops-to-v2" if args.include_stops else "legacy-services-to-v2"
    conn = connect(args.database, read_only=False)
    try:
        with conn:
            initialize_v2_schema(conn)
            if args.reset_progress:
                conn.execute("DELETE FROM statistics_migration_state WHERE name=?", (migration_name,))

        state = migration_state(conn, migration_name)
        last_rowid = int(state["last_legacy_rowid"] or 0)
        high_water_rowid = int(state["high_water_rowid"] or 0)
        if state["completed"] and not args.reset_progress:
            print(
                json.dumps(
                    {
                        "mode": "apply",
                        "migration": migration_name,
                        "alreadyCompleted": True,
                        **preflight,
                    },
                    indent=2,
                )
            )
            return 0

        totals = {"processed": 0, "observations": 0, "stop_events": 0}
        if state["details"]:
            try:
                saved_totals = json.loads(state["details"])
                for key in totals:
                    totals[key] = int(saved_totals.get(key, 0))
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        run_totals = {key: 0 for key in totals}
        if not high_water_rowid:
            high_water_rowid = int(capacity["maxLegacyRowid"])
            with conn:
                save_migration_state(
                    conn,
                    migration_name,
                    last_rowid=last_rowid,
                    high_water_rowid=high_water_rowid,
                    completed=False,
                    details=totals,
                )

        batches = 0
        foreign_key_violations: list[list[Any]] = []
        foreign_key_violations_truncated = False
        validation_failed = False
        while True:
            with conn:
                result = backfill_legacy_batch(
                    conn,
                    last_rowid=last_rowid,
                    high_water_rowid=high_water_rowid,
                    batch_size=args.batch_size,
                    include_stops=args.include_stops,
                )
                last_rowid = int(result["last_rowid"])
                for key in totals:
                    increment = int(result[key])
                    totals[key] += increment
                    run_totals[key] += increment
                if result["done"]:
                    violations = conn.execute("PRAGMA foreign_key_check").fetchmany(21)
                    foreign_key_violations = [list(row) for row in violations[:20]]
                    foreign_key_violations_truncated = len(violations) > 20
                    validation_failed = bool(violations)
                save_migration_state(
                    conn,
                    migration_name,
                    last_rowid=last_rowid,
                    high_water_rowid=high_water_rowid,
                    completed=bool(result["done"] and not validation_failed),
                    details=totals,
                )
            batches += 1
            if result["done"] or (args.max_batches and batches >= args.max_batches):
                break
            if args.pause_ms:
                time.sleep(args.pause_ms / 1000)

        print(
            json.dumps(
                {
                    "mode": "apply",
                    "migration": migration_name,
                    "batches": batches,
                    "lastLegacyRowid": last_rowid,
                    "highWaterLegacyRowid": high_water_rowid,
                    "completed": bool(result["done"] and not validation_failed),
                    "validationFailed": validation_failed,
                    "foreignKeyViolationsTruncated": foreign_key_violations_truncated,
                    "foreignKeyViolationsSample": foreign_key_violations,
                    "runTotals": run_totals,
                    **totals,
                    **profile(conn, args.database),
                    "estimatedV2GrowthBytes": estimated_growth,
                    "estimateIncludesStops": bool(args.include_stops),
                    "requiredFreeBytes": minimum_free,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2 if validation_failed else 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
