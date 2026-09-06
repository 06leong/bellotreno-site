"""Offline SQLite index finalizer; run after DuckDB closes, before publication.

The parent sets SQLITE_TMPDIR before this interpreter starts. Keep this module
out of the always-on API image; it must not import DuckDB.
"""
from __future__ import annotations

import sqlite3
import sys
from contextlib import closing
from pathlib import Path


def log(message: str) -> None:
    print(f"[statistics-analytics] {message}", file=sys.stderr, flush=True)


def finalize(database: Path) -> None:
    with closing(sqlite3.connect(database)) as output:
        output.execute("PRAGMA temp_store=FILE")
        output.execute("PRAGMA synchronous=FULL")
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


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: analytics_sqlite.py <unpublished-database>")
    finalize(Path(sys.argv[1]))
