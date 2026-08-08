from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date
from pathlib import Path
from typing import Any, Sequence

from statistics_snapshot import (
    DEFAULT_HANDOFF_ROOT,
    DEFAULT_MAX_AGE_HOURS,
    DEFAULT_SOURCE_DB,
    GIB,
    PreparedSnapshot,
    SnapshotPolicy,
    create_prepared_snapshot,
    list_prepared_snapshots,
    release_prepared_snapshot,
    utc_now,
)


def log(message: str) -> None:
    print(f"[statistics-snapshot] {message}", file=sys.stderr, flush=True)


def parse_date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD")
    return parsed


def prepared_json(value: PreparedSnapshot) -> dict[str, Any]:
    policy = value.policy
    return {
        "snapshotId": value.snapshot_id,
        "createdAt": value.created_at,
        "databasePath": value.database_path.as_posix(),
        "receiptPath": value.receipt_path.as_posix(),
        "databaseBytes": value.database_bytes,
        "pageSize": value.page_size,
        "pageCount": value.page_count,
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare and manage atomic BelloTreno SQLite snapshots for the "
            "offline archive container."
        )
    )
    parser.add_argument(
        "--source-db",
        default=os.environ.get("SQLITE_PATH", DEFAULT_SOURCE_DB),
        help="live SQLite database used by the producer",
    )
    parser.add_argument(
        "--handoff-root",
        default=os.environ.get("SNAPSHOT_HANDOFF_ROOT", DEFAULT_HANDOFF_ROOT),
        help="snapshot handoff directory",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser(
        "prepare",
        aliases=["create"],
        help="pin the current WAL view and atomically publish a ready snapshot",
    )
    prepare.add_argument("--snapshot-id", help="explicit test/operator snapshot ID")
    prepare.add_argument(
        "--as-of-date",
        type=parse_date,
        help="archive as-of date; defaults to the latest ready Europe/Rome date",
    )

    listing = commands.add_parser("list", help="list valid ready snapshots")
    listing.add_argument(
        "--max-age-hours",
        type=int,
        default=os.environ.get(
            "SNAPSHOT_MAX_AGE_HOURS", str(DEFAULT_MAX_AGE_HOURS)
        ),
        help=f"reject receipts older than this value (default: {DEFAULT_MAX_AGE_HOURS})",
    )

    release = commands.add_parser(
        "release", help="revoke one exact receipt, then remove its database"
    )
    release.add_argument(
        "--snapshot-id", required=True, help="exact snapshot ID to release"
    )
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    handoff_root = Path(args.handoff_root)
    if args.command in {"prepare", "create"}:
        created_at = utc_now()
        policy = SnapshotPolicy.from_environment(
            created_at=created_at,
            as_of_date=args.as_of_date,
        )
        seen = -1

        def progress(copied: int, total: int) -> None:
            nonlocal seen
            if total <= 0:
                return
            bucket = min(10, int(10 * copied / total))
            if bucket > seen or copied == total:
                seen = bucket
                log(f"snapshot {bucket * 10}% ({copied}/{total} pages)")

        log("pinning a read transaction and creating a SQLite Backup API snapshot")
        try:
            minimum_free_gib = float(os.environ.get("SNAPSHOT_MIN_FREE_GIB", "5"))
        except ValueError as exc:
            raise ValueError("SNAPSHOT_MIN_FREE_GIB must be a number") from exc
        if (
            not math.isfinite(minimum_free_gib)
            or minimum_free_gib < 1
            or minimum_free_gib > 100
        ):
            raise ValueError("SNAPSHOT_MIN_FREE_GIB must be between 1 and 100")
        snapshot = create_prepared_snapshot(
            Path(args.source_db),
            handoff_root,
            policy,
            snapshot_id=args.snapshot_id,
            created_at=created_at,
            progress=progress,
            minimum_free_bytes=int(minimum_free_gib * GIB),
        )
        log(f"published ready receipt for {snapshot.snapshot_id}")
        return {"mode": "prepare", "status": "success", **prepared_json(snapshot)}
    if args.command == "list":
        snapshots = list_prepared_snapshots(
            handoff_root,
            max_age_hours=args.max_age_hours,
        )
        return {
            "mode": "list",
            "status": "success",
            "snapshots": [prepared_json(snapshot) for snapshot in snapshots],
        }
    if args.command == "release":
        snapshot = release_prepared_snapshot(handoff_root, args.snapshot_id)
        log(f"released {snapshot.snapshot_id}")
        return {
            "mode": "release",
            "status": "success",
            "snapshotId": snapshot.snapshot_id,
        }
    raise RuntimeError(f"unsupported snapshot command {args.command!r}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = run(args)
    except Exception as exc:
        log(f"failed: {exc}")
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
