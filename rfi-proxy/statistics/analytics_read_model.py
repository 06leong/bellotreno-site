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

    def explore(
        self,
        *,
        as_of: str | None,
        window: int,
        operator: str = "",
        category: str = "",
        station: str = "",
    ) -> dict[str, Any]:
        meta = self.metadata()
        selected_date = self.validate_date(as_of, str(meta["asOfDate"]))
        window = self.validate_window(window)
        if operator and category:
            raise ValueError("operator and category filters cannot be combined yet")
        if _as_int(meta.get("schemaVersion")) < 2:
            raise AnalyticsUnavailable("analytics_explore_not_built")
        if selected_date != meta["asOfDate"]:
            return {
                "available": False,
                "reason": "analytics_explore_latest_only",
                "asOfDate": selected_date,
                "latestAsOfDate": meta["asOfDate"],
                "windowDays": window,
            }

        filter_type = "operator" if operator else "category" if category else "all"
        filter_key = operator or category or "all"
        start_date = (date.fromisoformat(selected_date) - timedelta(days=window - 1)).isoformat()

        def compact_metric(row: sqlite3.Row) -> dict[str, Any]:
            metric = _metric_payload(row) or {}
            return {
                "observedServices": metric.get("observedServices", 0),
                "outcomeEligibleServices": metric.get("outcomeEligibleServices", 0),
                "arrivalSample": metric.get("arrivalSample", 0),
                "punctuality": metric.get("punctuality"),
                "cancellation": metric.get("cancellation"),
                "severeDelay": metric.get("severeDelay"),
                "delayMinutes": metric.get("delayMinutes"),
            }

        with closing(self.connect()) as connection:
            network = connection.execute(
                "SELECT * FROM network_window WHERE as_of_date=? AND window_days=?",
                (selected_date, window),
            ).fetchone()
            operator_rows = connection.execute(
                """
                SELECT * FROM dimension_window
                WHERE as_of_date=? AND window_days=? AND dimension_type='operator'
                ORDER BY observed_services DESC, dimension_label
                """,
                (selected_date, window),
            ).fetchall()
            category_rows = connection.execute(
                """
                SELECT * FROM dimension_window
                WHERE as_of_date=? AND window_days=? AND dimension_type='category'
                ORDER BY observed_services DESC, dimension_label
                """,
                (selected_date, window),
            ).fetchall()
            matrix_rows = connection.execute(
                """
                SELECT * FROM operator_category_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND (?='' OR operator=?) AND (?='' OR category=?)
                ORDER BY observed_services DESC, operator, category
                """,
                (selected_date, window, operator, operator, category, category),
            ).fetchall()
            rhythm_rows = connection.execute(
                """
                SELECT * FROM rhythm_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND filter_type=? AND filter_key=?
                ORDER BY weekday, hour
                """,
                (selected_date, window, filter_type, filter_key),
            ).fetchall()
            category_rhythm_rows = (
                connection.execute(
                    """
                    SELECT * FROM rhythm_window
                    WHERE as_of_date=? AND window_days=? AND period='current'
                      AND filter_type='category'
                      AND (?='' OR filter_key=?)
                    ORDER BY filter_key, weekday, hour
                    """,
                    (selected_date, window, category, category),
                ).fetchall()
                if not operator
                else []
            )
            station_rows = connection.execute(
                """
                SELECT * FROM station_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND filter_type=? AND filter_key=?
                  AND observed_services>=?
                ORDER BY observed_services DESC, station_label
                LIMIT 100
                """,
                (
                    selected_date,
                    window,
                    filter_type,
                    filter_key,
                    max(1, _as_int(meta.get("minimumRankingSample"))),
                ),
            ).fetchall()
            previous_stations = {
                row["station_code"]: row
                for row in connection.execute(
                    """
                    SELECT * FROM station_window
                    WHERE as_of_date=? AND window_days=? AND period='previous'
                      AND filter_type=? AND filter_key=?
                    """,
                    (selected_date, window, filter_type, filter_key),
                ).fetchall()
            }
            relation_rows = connection.execute(
                """
                SELECT * FROM relation_feature_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND filter_type=? AND filter_key=?
                  AND observed_services>=?
                ORDER BY observed_services DESC, relation_label
                LIMIT 100
                """,
                (
                    selected_date,
                    window,
                    filter_type,
                    filter_key,
                    max(1, _as_int(meta.get("minimumRankingSample"))),
                ),
            ).fetchall()
            concentration_rows = connection.execute(
                """
                SELECT * FROM relation_feature_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND filter_type=? AND filter_key=?
                  AND arrival_sample>=?
                ORDER BY over_60 DESC, arrival_sample DESC, relation_label
                LIMIT 1000
                """,
                (
                    selected_date,
                    window,
                    filter_type,
                    filter_key,
                    max(1, _as_int(meta.get("minimumRankingSample"))),
                ),
            ).fetchall()
            recovery_rows = connection.execute(
                """
                SELECT * FROM relation_feature_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND filter_type=? AND filter_key=?
                  AND recovery_sample>=?
                  AND delay_change_mean IS NOT NULL
                ORDER BY ABS(delay_change_mean) DESC, recovery_sample DESC, relation_label
                LIMIT 10
                """,
                (
                    selected_date,
                    window,
                    filter_type,
                    filter_key,
                    max(1, _as_int(meta.get("minimumRankingSample"))),
                ),
            ).fetchall()
            previous_relations = {
                row["relation_id"]: row
                for row in connection.execute(
                    """
                    SELECT * FROM relation_feature_window
                    WHERE as_of_date=? AND window_days=? AND period='previous'
                      AND filter_type=? AND filter_key=?
                    """,
                    (selected_date, window, filter_type, filter_key),
                ).fetchall()
            }
            selected_station = station or (station_rows[0]["station_code"] if station_rows else "")
            station_hour_rows = connection.execute(
                """
                SELECT weekday, hour, observed_services, arrivals, departures, transits
                FROM station_hour_window
                WHERE as_of_date=? AND window_days=? AND station_code=?
                ORDER BY weekday, hour
                """,
                (selected_date, window, selected_station),
            ).fetchall() if selected_station else []
            cross_midnight = connection.execute(
                """
                SELECT * FROM cross_midnight_window
                WHERE as_of_date=? AND window_days=? AND period='current'
                  AND filter_type=? AND filter_key=?
                """,
                (selected_date, window, filter_type, filter_key),
            ).fetchone()
            previous_cross_midnight = connection.execute(
                """
                SELECT * FROM cross_midnight_window
                WHERE as_of_date=? AND window_days=? AND period='previous'
                  AND filter_type=? AND filter_key=?
                """,
                (selected_date, window, filter_type, filter_key),
            ).fetchone()
            journey_where = ["service_date BETWEEN ? AND ?"]
            journey_params: list[Any] = [start_date, selected_date]
            if operator:
                journey_where.append("operator=?")
                journey_params.append(operator)
            if category:
                journey_where.append("category=?")
                journey_params.append(category)
            longest_journeys = connection.execute(
                f"""
                SELECT * FROM long_journey_service
                WHERE {' AND '.join(journey_where)}
                ORDER BY scheduled_duration_minutes DESC, service_date DESC, train_number
                LIMIT 8
                """,
                journey_params,
            ).fetchall()
            outlier_where = ["service_date BETWEEN ? AND ?"]
            outlier_params: list[Any] = [start_date, selected_date]
            if operator:
                outlier_where.append("operator=?")
                outlier_params.append(operator)
            if category:
                outlier_where.append("category=?")
                outlier_params.append(category)
            spotlight = connection.execute(
                f"""
                SELECT * FROM outlier_service
                WHERE {' AND '.join(outlier_where)}
                ORDER BY cancelled ASC, final_arrival_delay DESC NULLS LAST,
                         observation_count DESC, service_date DESC
                LIMIT 1
                """,
                outlier_params,
            ).fetchone()
            spotlight_stops = connection.execute(
                """
                SELECT * FROM outlier_stop
                WHERE service_date=? AND train_key=? ORDER BY stop_number
                """,
                (spotlight["service_date"], spotlight["train_key"]),
            ).fetchall() if spotlight else []

        network_observed = _as_int(network["observed_services"] if network else 0)
        operator_mix_rows = (
            matrix_rows
            if category
            else [row for row in operator_rows if not operator or row["dimension_key"] == operator]
        )
        category_mix_rows = (
            matrix_rows
            if operator
            else [row for row in category_rows if not category or row["dimension_key"] == category]
        )
        operator_mix_observed = (
            sum(_as_int(row["observed_services"]) for row in operator_mix_rows)
            if operator or category
            else network_observed
        )
        category_mix_observed = (
            sum(_as_int(row["observed_services"]) for row in category_mix_rows)
            if operator or category
            else network_observed
        )

        def mix_item(
            row: sqlite3.Row,
            *,
            key_column: str = "dimension_key",
            label_column: str = "dimension_label",
            denominator: int = network_observed,
        ) -> dict[str, Any]:
            observed = _as_int(row["observed_services"])
            return {
                "key": row[key_column],
                "label": row[label_column],
                "sharePercent": _rate(observed, denominator),
                **compact_metric(row),
            }

        def station_item(row: sqlite3.Row) -> dict[str, Any]:
            previous = previous_stations.get(row["station_code"])
            observed = _as_int(row["observed_services"])
            arrivals = _as_int(row["arrivals"])
            departures = _as_int(row["departures"])
            transits = _as_int(row["transits"])
            role_total = arrivals + departures + transits
            arrival_sample = _as_int(row["arrival_sample"])
            outcome_sample = _as_int(row["outcome_eligible_services"])
            return {
                "key": row["station_code"],
                "label": row["station_label"],
                "observedServices": observed,
                "roles": {
                    "arrivals": arrivals,
                    "departures": departures,
                    "transits": transits,
                    "arrivalPercent": _rate(arrivals, role_total),
                    "departurePercent": _rate(departures, role_total),
                    "transitPercent": _rate(transits, role_total),
                },
                "punctuality": {
                    "within5": {
                        "numerator": _as_int(row["within_5"]),
                        "denominator": arrival_sample,
                        "percent": _rate(_as_int(row["within_5"]), arrival_sample),
                    }
                },
                "cancellation": {
                    "numerator": _as_int(row["cancelled_services"]),
                    "denominator": outcome_sample,
                    "percent": _rate(_as_int(row["cancelled_services"]), outcome_sample),
                },
                "arrivalSample": arrival_sample,
                "delayMinutes": {
                    "p50": _as_float(row["delay_p50"]),
                    "p90": _as_float(row["delay_p90"]),
                },
                "previousObservedServices": _as_int(previous["observed_services"] if previous else 0),
            }

        def relation_item(row: sqlite3.Row) -> dict[str, Any]:
            previous = previous_relations.get(row["relation_id"])
            return {
                "key": row["relation_id"],
                "label": row["relation_label"],
                **compact_metric(row),
                "recovery": {
                    "sample": _as_int(row["recovery_sample"]),
                    "recoveredServices": _as_int(row["recovered_services"]),
                    "meanMinutes": _as_float(row["delay_change_mean"]),
                    "p50Minutes": _as_float(row["delay_change_p50"]),
                },
                "crossMidnightServices": _as_int(row["cross_midnight_services"]),
                "previousObservedServices": _as_int(previous["observed_services"] if previous else 0),
            }

        relation_items = [relation_item(row) for row in relation_rows]
        concentration_items = [relation_item(row) for row in concentration_rows]
        severe_total = sum(
            _as_int((item.get("severeDelay") or {}).get("over60", {}).get("numerator"))
            for item in concentration_items
        )
        concentration = []
        cumulative = 0
        for item in sorted(
            concentration_items,
            key=lambda value: _as_int((value.get("severeDelay") or {}).get("over60", {}).get("numerator")),
            reverse=True,
        )[:10]:
            events = _as_int((item.get("severeDelay") or {}).get("over60", {}).get("numerator"))
            cumulative += events
            concentration.append(
                {
                    "key": item["key"],
                    "label": item["label"],
                    "events": events,
                    "sharePercent": _rate(events, severe_total),
                    "cumulativePercent": _rate(cumulative, severe_total),
                }
            )

        cross_observed = _as_int(cross_midnight["observed_services"] if cross_midnight else 0)
        cross_count = _as_int(cross_midnight["cross_midnight_services"] if cross_midnight else 0)
        previous_cross_observed = _as_int(previous_cross_midnight["observed_services"] if previous_cross_midnight else 0)
        previous_cross_count = _as_int(previous_cross_midnight["cross_midnight_services"] if previous_cross_midnight else 0)

        return {
            "available": True,
            "asOfDate": selected_date,
            "windowDays": window,
            "filter": {"type": None if filter_type == "all" else filter_type, "key": None if filter_key == "all" else filter_key},
            "composition": {
                "activeOperators": sum(
                    1
                    for row in operator_mix_rows
                    if row["operator" if category else "dimension_key"] != "unknown"
                    and _as_int(row["observed_services"]) > 0
                ),
                "operators": [
                    mix_item(
                        row,
                        key_column="operator" if category else "dimension_key",
                        label_column="operator" if category else "dimension_label",
                        denominator=operator_mix_observed,
                    )
                    for row in operator_mix_rows
                ],
                "categories": [
                    mix_item(
                        row,
                        key_column="category" if operator else "dimension_key",
                        label_column="category" if operator else "dimension_label",
                        denominator=category_mix_observed,
                    )
                    for row in category_mix_rows
                ],
                "matrix": [
                    {
                        "operator": row["operator"],
                        "category": row["category"],
                        **compact_metric(row),
                    }
                    for row in matrix_rows
                ],
            },
            "rhythm": [
                {
                    "weekday": _as_int(row["weekday"]),
                    "hour": _as_int(row["hour"]),
                    **compact_metric(row),
                }
                for row in rhythm_rows
            ],
            "categoryRhythm": [
                {
                    "category": row["filter_key"],
                    "weekday": _as_int(row["weekday"]),
                    "hour": _as_int(row["hour"]),
                    **compact_metric(row),
                }
                for row in category_rhythm_rows
            ],
            "network": {
                "stations": [station_item(row) for row in station_rows],
                "relations": relation_items,
                "stationRhythm": {
                    "stationCode": selected_station or None,
                    "stationLabel": next((row["station_label"] for row in station_rows if row["station_code"] == selected_station), selected_station or None),
                    "items": [dict(row) for row in station_hour_rows],
                    "filterScope": "all_services",
                },
            },
            "services": {
                "crossMidnight": {
                    "numerator": cross_count,
                    "denominator": cross_observed,
                    "percent": _rate(cross_count, cross_observed),
                    "previousPercent": _rate(previous_cross_count, previous_cross_observed),
                    "durationSample": _as_int(cross_midnight["duration_sample"] if cross_midnight else 0),
                    "durationMeanMinutes": _as_float(cross_midnight["duration_mean"] if cross_midnight else None),
                    "durationP90Minutes": _as_float(cross_midnight["duration_p90"] if cross_midnight else None),
                },
                "longestJourneys": [dict(row) for row in longest_journeys],
                "recoveryRelations": sorted(
                    [relation_item(row) for row in recovery_rows],
                    key=lambda item: abs(item["recovery"]["meanMinutes"]),
                    reverse=True,
                )[:10],
                "spotlight": {
                    "service": dict(spotlight) if spotlight else None,
                    "stops": [dict(row) for row in spotlight_stops],
                },
                "disruptionConcentration": {
                    "eventDefinition": "relation_services_over_60_minutes",
                    "totalEvents": severe_total,
                    "items": concentration,
                },
            },
            "disclaimer": "Distinct observable services and stop outcomes; not passenger counts or official full-network statistics. Missing evidence is not zero.",
        }


def rows_to_csv(rows: Iterable[dict[str, Any]]) -> tuple[list[str], list[list[Any]]]:
    materialized = list(rows)
    if not materialized:
        return [], []
    keys = list(materialized[0])
    return keys, [[row.get(key) for key in keys] for row in materialized]


def default_analytics_path() -> str:
    return os.environ.get("ANALYTICS_SQLITE_PATH", "/analytics/analytics.db")
