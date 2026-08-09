from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable


ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ALLOWED_WINDOWS = (7, 28, 90)
ALLOWED_DIMENSIONS = ("operator", "category", "station", "relation")
METRIC_COUNT_FIELDS = (
    "service_days",
    "observed_services",
    "outcome_eligible_services",
    "cancelled_services",
    "completed_services",
    "arrival_sample",
    "within_5",
    "within_15",
    "over_30",
    "over_60",
    "over_120",
    "bucket_early",
    "bucket_0_5",
    "bucket_6_15",
    "bucket_16_30",
    "bucket_31_60",
    "bucket_61_120",
    "bucket_over_120",
)


class AnalyticsUnavailable(RuntimeError):
    pass


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _rate(numerator: int, denominator: int) -> float | None:
    return round(numerator * 100.0 / denominator, 2) if denominator > 0 else None


def wilson_interval(numerator: int, denominator: int) -> dict[str, float] | None:
    if denominator <= 0:
        return None
    z = 1.959963984540054
    proportion = numerator / denominator
    denominator_adjusted = 1 + z * z / denominator
    centre = (proportion + z * z / (2 * denominator)) / denominator_adjusted
    margin = (
        z
        * math.sqrt(
            proportion * (1 - proportion) / denominator
            + z * z / (4 * denominator * denominator)
        )
        / denominator_adjusted
    )
    return {
        "low": round(max(0.0, centre - margin) * 100, 2),
        "high": round(min(1.0, centre + margin) * 100, 2),
    }


def _metric_payload(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    counts = {field: _as_int(row[field]) for field in METRIC_COUNT_FIELDS}
    outcome_denominator = counts["outcome_eligible_services"]
    arrival_denominator = counts["arrival_sample"]
    cancellation = counts["cancelled_services"]
    within_5 = counts["within_5"]
    within_15 = counts["within_15"]
    return {
        "serviceDays": counts["service_days"],
        "observedServices": counts["observed_services"],
        "outcomeEligibleServices": outcome_denominator,
        "excludedServices": max(0, counts["observed_services"] - outcome_denominator),
        "completedServices": counts["completed_services"],
        "arrivalSample": arrival_denominator,
        "punctuality": {
            "within5": {
                "numerator": within_5,
                "denominator": arrival_denominator,
                "percent": _rate(within_5, arrival_denominator),
                "confidence95": wilson_interval(within_5, arrival_denominator),
            },
            "within15": {
                "numerator": within_15,
                "denominator": arrival_denominator,
                "percent": _rate(within_15, arrival_denominator),
                "confidence95": wilson_interval(within_15, arrival_denominator),
            },
        },
        "cancellation": {
            "numerator": cancellation,
            "denominator": outcome_denominator,
            "percent": _rate(cancellation, outcome_denominator),
            "confidence95": wilson_interval(cancellation, outcome_denominator),
        },
        "severeDelay": {
            "over30": {
                "numerator": counts["over_30"],
                "denominator": arrival_denominator,
                "percent": _rate(counts["over_30"], arrival_denominator),
            },
            "over60": {
                "numerator": counts["over_60"],
                "denominator": arrival_denominator,
                "percent": _rate(counts["over_60"], arrival_denominator),
            },
            "over120": {
                "numerator": counts["over_120"],
                "denominator": arrival_denominator,
                "percent": _rate(counts["over_120"], arrival_denominator),
            },
        },
        "delayMinutes": {
            "p50": _as_float(row["delay_p50"]),
            "p75": _as_float(row["delay_p75"]),
            "p90": _as_float(row["delay_p90"]),
            "p95": _as_float(row["delay_p95"]),
            "mean": _as_float(row["delay_mean"]),
        },
        "distribution": [
            {"key": "early", "count": counts["bucket_early"]},
            {"key": "0_5", "count": counts["bucket_0_5"]},
            {"key": "6_15", "count": counts["bucket_6_15"]},
            {"key": "16_30", "count": counts["bucket_16_30"]},
            {"key": "31_60", "count": counts["bucket_31_60"]},
            {"key": "61_120", "count": counts["bucket_61_120"]},
            {"key": "over_120", "count": counts["bucket_over_120"]},
        ],
    }


class AnalyticsReadModel:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)

    def available(self) -> bool:
        return self.database_path.is_file()

    def connect(self) -> sqlite3.Connection:
        if not self.available():
            raise AnalyticsUnavailable("analytics_not_built")
        uri = f"file:{self.database_path.resolve().as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def metadata(self) -> dict[str, Any]:
        with closing(self.connect()) as connection:
            raw = dict(connection.execute("SELECT name, value FROM analytics_metadata"))
            available = connection.execute(
                "SELECT MIN(service_date), MAX(service_date), COUNT(*) FROM network_day"
            ).fetchone()
            quality = connection.execute(
                "SELECT MIN(collection_date), MAX(collection_date) FROM quality_day"
            ).fetchone()
            dimensions = {}
            for dimension in ("operator", "category"):
                rows = connection.execute(
                    """
                    SELECT dimension_key, MAX(dimension_label) AS label,
                           SUM(observed_services) AS sample
                    FROM dimension_day
                    WHERE dimension_type=?
                    GROUP BY dimension_key
                    ORDER BY sample DESC, dimension_key
                    """,
                    (dimension,),
                ).fetchall()
                dimensions[dimension] = [
                    {"key": row["dimension_key"], "label": row["label"], "sample": row["sample"]}
                    for row in rows
                ]
        return {
            "available": True,
            "schemaVersion": _as_int(raw.get("schemaVersion")),
            "metricDefinitionVersion": raw.get("metricDefinitionVersion"),
            "buildId": raw.get("buildId"),
            "builtAt": raw.get("builtAt"),
            "asOfDate": raw.get("asOfDate"),
            "sourceLatestCreatedAt": raw.get("sourceLatestCreatedAt"),
            "sourceLatestAsOfDate": raw.get("sourceLatestAsOfDate"),
            "sourceManifests": json.loads(raw.get("sourceManifests") or "[]"),
            "windows": json.loads(raw.get("windows") or "[]"),
            "minimumRankingSample": _as_int(raw.get("minimumRankingSample")),
            "serviceDate": {
                "availableFrom": available[0],
                "availableTo": available[1],
                "days": _as_int(available[2]),
            },
            "collectionDate": {
                "availableFrom": quality[0],
                "availableTo": quality[1],
            },
            "dimensions": dimensions,
        }

    @staticmethod
    def validate_window(value: Any) -> int:
        parsed = _as_int(value)
        if parsed not in ALLOWED_WINDOWS:
            raise ValueError("window must be one of 7, 28, or 90")
        return parsed

    @staticmethod
    def validate_date(value: str | None, fallback: str) -> str:
        current = value or fallback
        if not ISO_DATE.fullmatch(current):
            raise ValueError("asOf must be an ISO date")
        date.fromisoformat(current)
        return current

    def overview(
        self,
        *,
        as_of: str | None,
        window: int,
        operator: str = "",
        category: str = "",
    ) -> dict[str, Any]:
        meta = self.metadata()
        selected_date = self.validate_date(as_of, str(meta["asOfDate"]))
        window = self.validate_window(window)
        if operator and category:
            raise ValueError("operator and category filters cannot be combined yet")
        dimension_type = "operator" if operator else "category" if category else ""
        dimension_key = operator or category
        selected_day = date.fromisoformat(selected_date)
        start_date = (selected_day - timedelta(days=window - 1)).isoformat()
        previous_as_of = (selected_day - timedelta(days=window)).isoformat()
        previous_start = (selected_day - timedelta(days=window * 2 - 1)).isoformat()

        with closing(self.connect()) as connection:
            if dimension_type:
                current = connection.execute(
                    """
                    SELECT * FROM dimension_window
                    WHERE as_of_date=? AND window_days=?
                      AND dimension_type=? AND dimension_key=?
                    """,
                    (selected_date, window, dimension_type, dimension_key),
                ).fetchone()
                previous = connection.execute(
                    """
                    SELECT * FROM dimension_window
                    WHERE as_of_date=? AND window_days=?
                      AND dimension_type=? AND dimension_key=?
                    """,
                    (previous_as_of, window, dimension_type, dimension_key),
                ).fetchone()
                series_rows = connection.execute(
                    """
                    SELECT * FROM dimension_day
                    WHERE service_date BETWEEN ? AND ?
                      AND dimension_type=? AND dimension_key=?
                    ORDER BY service_date
                    """,
                    (start_date, selected_date, dimension_type, dimension_key),
                ).fetchall()
            else:
                current = connection.execute(
                    "SELECT * FROM network_window WHERE as_of_date=? AND window_days=?",
                    (selected_date, window),
                ).fetchone()
                previous = connection.execute(
                    "SELECT * FROM network_window WHERE as_of_date=? AND window_days=?",
                    (previous_as_of, window),
                ).fetchone()
                series_rows = connection.execute(
                    "SELECT * FROM network_day WHERE service_date BETWEEN ? AND ? ORDER BY service_date",
                    (start_date, selected_date),
                ).fetchall()
            quality_rows = connection.execute(
                "SELECT * FROM quality_day WHERE collection_date BETWEEN ? AND ? ORDER BY collection_date",
                (start_date, selected_date),
            ).fetchall()

        if current is None:
            return {
                "available": False,
                "reason": "analytics_window_not_available",
                "asOfDate": selected_date,
                "windowDays": window,
            }
        series = []
        for row in series_rows:
            metric = _metric_payload(row)
            series.append({"date": row["service_date"], **(metric or {})})
        complete_days = sum(_as_int(row["comparison_eligible"]) for row in quality_rows)
        current_payload = _metric_payload(current)
        previous_payload = _metric_payload(previous)
        current_window_complete = bool(
            current_payload and current_payload["serviceDays"] >= window
        )
        previous_window_complete = bool(
            previous_payload and previous_payload["serviceDays"] >= window
        )
        return {
            "available": True,
            "build": {
                "buildId": meta["buildId"],
                "builtAt": meta["builtAt"],
                "metricDefinitionVersion": meta["metricDefinitionVersion"],
                "sourceManifests": meta["sourceManifests"],
            },
            "context": {
                "asOfDate": selected_date,
                "windowDays": window,
                "windowStart": start_date,
                "previousAsOfDate": previous_as_of,
                "previousWindowStart": previous_start,
                "filter": {"type": dimension_type or None, "key": dimension_key or None},
                "windowComplete": current_window_complete,
                "previousWindowComplete": previous_window_complete,
            },
            "current": current_payload,
            "previous": (
                previous_payload
                if current_window_complete and previous_window_complete
                else None
            ),
            "series": series,
            "quality": {
                "days": len(quality_rows),
                "completeDays": complete_days,
                "partialDays": len(quality_rows) - complete_days,
                "items": [dict(row) for row in quality_rows],
            },
            "disclaimer": "Observable ViaggiaTreno data; not an official full-network statistic.",
        }

    def rankings(
        self,
        *,
        dimension: str,
        as_of: str | None,
        window: int,
        sort: str,
        direction: str,
        minimum_sample: int,
        limit: int,
        offset: int,
        query: str = "",
    ) -> dict[str, Any]:
        if dimension not in ALLOWED_DIMENSIONS:
            raise ValueError("unsupported ranking dimension")
        meta = self.metadata()
        selected_date = self.validate_date(as_of, str(meta["asOfDate"]))
        window = self.validate_window(window)
        sort_map = {
            "sample": "arrival_sample",
            "punctuality": "CASE WHEN arrival_sample>0 THEN within_5*1.0/arrival_sample END",
            "cancellation": "CASE WHEN outcome_eligible_services>0 THEN cancelled_services*1.0/outcome_eligible_services END",
            "p90": "delay_p90",
        }
        order_column = sort_map.get(sort)
        if order_column is None:
            raise ValueError("unsupported ranking sort")
        sample_column = (
            "outcome_eligible_services" if sort == "cancellation" else "arrival_sample"
        )
        order = "ASC" if direction == "asc" else "DESC"
        limit = min(max(limit, 1), 100)
        offset = max(offset, 0)
        minimum_sample = max(1, minimum_sample)
        where = [
            "as_of_date=?",
            "window_days=?",
            "dimension_type=?",
            f"{sample_column}>=?",
        ]
        params: list[Any] = [selected_date, window, dimension, minimum_sample]
        if query:
            where.append("(dimension_key LIKE ? OR dimension_label LIKE ?)")
            wildcard = f"%{query}%"
            params.extend([wildcard, wildcard])
        where_sql = " AND ".join(where)
        with closing(self.connect()) as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM dimension_window WHERE {where_sql}", params
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT * FROM dimension_window
                WHERE {where_sql}
                ORDER BY {order_column} {order} NULLS LAST, dimension_label
                LIMIT ? OFFSET ?
                """,
                [*params, limit, offset],
            ).fetchall()
        return {
            "available": True,
            "dimension": dimension,
            "asOfDate": selected_date,
            "windowDays": window,
            "minimumSample": minimum_sample,
            "sort": sort,
            "direction": direction,
            "items": [
                {
                    "key": row["dimension_key"],
                    "label": row["dimension_label"],
                    **(_metric_payload(row) or {}),
                }
                for row in rows
            ],
            "total": _as_int(total),
            "limit": limit,
            "offset": offset,
        }

    def outliers(
        self,
        *,
        as_of: str | None,
        window: int,
        operator: str = "",
        category: str = "",
        query: str = "",
        limit: int = 25,
        offset: int = 0,
    ) -> dict[str, Any]:
        meta = self.metadata()
        selected_date = self.validate_date(as_of, str(meta["asOfDate"]))
        window = self.validate_window(window)
        start_date = (date.fromisoformat(selected_date) - timedelta(days=window - 1)).isoformat()
        where = ["service_date BETWEEN ? AND ?"]
        params: list[Any] = [start_date, selected_date]
        if operator:
            where.append("operator=?")
            params.append(operator)
        if category:
            where.append("category=?")
            params.append(category)
        if query:
            wildcard = f"%{query}%"
            where.append(
                "(train_number LIKE ? OR origin LIKE ? OR destination LIKE ? OR relation_key LIKE ?)"
            )
            params.extend([wildcard, wildcard, wildcard, wildcard])
        where_sql = " AND ".join(where)
        limit = min(max(limit, 1), 100)
        offset = max(offset, 0)
        with closing(self.connect()) as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM outlier_service WHERE {where_sql}", params
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT * FROM outlier_service
                WHERE {where_sql}
                ORDER BY cancelled DESC, final_arrival_delay DESC NULLS LAST,
                         service_date DESC, train_number
                LIMIT ? OFFSET ?
                """,
                [*params, limit, offset],
            ).fetchall()
        return {
            "available": True,
            "asOfDate": selected_date,
            "windowDays": window,
            "items": [dict(row) for row in rows],
            "total": _as_int(total),
            "limit": limit,
            "offset": offset,
        }


def rows_to_csv(rows: Iterable[dict[str, Any]]) -> tuple[list[str], list[list[Any]]]:
    materialized = list(rows)
    if not materialized:
        return [], []
    keys = list(materialized[0])
    return keys, [[row.get(key) for key in keys] for row in materialized]


def default_analytics_path() -> str:
    return os.environ.get("ANALYTICS_SQLITE_PATH", "/analytics/analytics.db")
