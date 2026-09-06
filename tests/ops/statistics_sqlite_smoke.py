"""Exercise real SQLite index spill after sqlite3 was initialized in the caller."""
from __future__ import annotations

import argparse
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "rfi-proxy" / "statistics"))
sys.path.insert(0, str(Path.cwd()))

from analytics_statistics import _finalize_read_model
from analytics_sqlite import finalize


def smoke(root: Path, require_tmpfs_failure: bool) -> None:
    root.mkdir(parents=True, exist_ok=True)
    database = root / "sort.db"
    if database.exists():
        raise RuntimeError("use an empty smoke directory")
    definitions = {
        "quality_day": "collection_date TEXT",
        "network_day": "service_date TEXT",
        "dimension_day": "dimension_type TEXT, dimension_key TEXT, service_date TEXT",
        "network_window": "as_of_date TEXT, window_days INTEGER",
        "dimension_window": "as_of_date TEXT, window_days INTEGER, dimension_type TEXT, dimension_key TEXT",
        "outlier_service": "service_date TEXT, cancelled INTEGER, final_arrival_delay REAL, operator TEXT, category TEXT",
        "operator_category_window": "as_of_date TEXT, window_days INTEGER, period TEXT, operator TEXT, category TEXT",
        "rhythm_window": "as_of_date TEXT, window_days INTEGER, period TEXT, filter_type TEXT, filter_key TEXT, weekday INTEGER, hour INTEGER",
        "station_window": "as_of_date TEXT, window_days INTEGER, period TEXT, filter_type TEXT, filter_key TEXT, observed_services INTEGER",
        "station_hour_window": "as_of_date TEXT, window_days INTEGER, station_code TEXT, weekday INTEGER, hour INTEGER",
        "relation_feature_window": "as_of_date TEXT, window_days INTEGER, period TEXT, filter_type TEXT, filter_key TEXT, observed_services INTEGER",
        "cross_midnight_window": "as_of_date TEXT, window_days INTEGER, period TEXT, filter_type TEXT, filter_key TEXT",
        "long_journey_service": "service_date TEXT, operator TEXT, category TEXT, scheduled_duration_minutes REAL",
        "outlier_stop": "service_date TEXT, train_key TEXT, stop_number INTEGER",
    }
    with closing(sqlite3.connect(database)) as connection:
        for table, columns in definitions.items():
            connection.execute(f"CREATE TABLE {table} ({columns})")
        connection.executemany(
            "INSERT INTO dimension_day VALUES ('station', ?, '2026-08-29')",
            ((f"{n:09d}" + "x" * 120,) for n in range(400000, 0, -1)),
        )
        connection.commit()

    if require_tmpfs_failure:
        # Negative control: the old same-process finalizer must overflow the
        # 16 MiB tmpfs. Otherwise this fixture did not exercise disk sorting.
        try:
            finalize(database)
        except sqlite3.OperationalError as exc:
            if exc.sqlite_errorcode != sqlite3.SQLITE_FULL:
                raise
            print("negative_control=SQLITE_FULL", flush=True)
        else:
            raise AssertionError("fixture did not overflow the 16 MiB tmpfs")
        with closing(sqlite3.connect(database)) as connection:
            indexes = connection.execute("SELECT name FROM sqlite_schema WHERE type='index'").fetchall()
            for (name,) in indexes:
                connection.execute(f'DROP INDEX "{name}"')
            connection.commit()

    _finalize_read_model(database)
    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT COUNT(*) FROM dimension_day INDEXED BY idx_dimension_day").fetchone()[0] == 400000
    assert not list(root.glob("sqlite-temp-*"))
    print("sqlite_disk_sort_ok: 400000 rows; fresh process; scratch cleaned", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--require-tmpfs-failure", action="store_true")
    args = parser.parse_args()
    smoke(args.root, args.require_tmpfs_failure)
