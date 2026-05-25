import csv
import io
import json
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

import requests
from flask import Flask, Response, jsonify, request

from statistics_core.normalizers import (
    as_int as core_as_int,
    midnight_epoch_ms as core_midnight_epoch_ms,
    normalize_category as core_normalize_category,
    pick as core_pick,
    is_service_date_within_lookback as core_is_service_date_within_lookback,
    service_date_from_item as core_service_date_from_item,
    train_key_from_parts as core_train_key_from_parts,
)


APP_TZ = ZoneInfo("Europe/Rome")
VT_BASE_URL = "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno"

SQLITE_PATH = os.getenv("SQLITE_PATH", "/data/statistics.db")
CACHE_DIR = os.getenv("CACHE_DIR", "/data/cache")
SECURITY_TOKEN = os.getenv("STATISTICS_SECURITY_TOKEN", "")
RFI_PROXY_BASE_URL = os.getenv("RFI_PROXY_BASE_URL", "http://rfi-proxy:8080").rstrip("/")
RFI_PROXY_SECURITY_TOKEN = os.getenv("RFI_PROXY_SECURITY_TOKEN", "")


def env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return max(minimum, default)


COLLECTOR_ENABLED = os.getenv("COLLECTOR_ENABLED", "true").lower() == "true"
COLLECTOR_INTERVAL_MINUTES = env_int("COLLECTOR_INTERVAL_MINUTES", 30)
COLLECTOR_MAX_RUNTIME_SECONDS = env_int("COLLECTOR_MAX_RUNTIME_SECONDS", 2400)
COLLECTOR_CONCURRENCY = env_int("COLLECTOR_CONCURRENCY", 4)
COLLECTOR_BOARD_CONCURRENCY = env_int("COLLECTOR_BOARD_CONCURRENCY", 24)
COLLECTOR_DETAIL_CONCURRENCY = env_int("COLLECTOR_DETAIL_CONCURRENCY", 12)
COLLECTOR_REGION_CONCURRENCY = env_int("COLLECTOR_REGION_CONCURRENCY", 6)
COLLECTOR_SCHEDULE_OFFSET_MINUTES = min(59, max(0, env_int("COLLECTOR_SCHEDULE_OFFSET_MINUTES", 5, minimum=0)))
COLLECTOR_CATCHUP_GRACE_MINUTES = env_int("COLLECTOR_CATCHUP_GRACE_MINUTES", 20, minimum=0)
COLLECTOR_FINALIZE_TIME = os.getenv("COLLECTOR_FINALIZE_TIME", "23:55")
COLLECTOR_SERVICE_DATE_LOOKBACK_DAYS = env_int("COLLECTOR_SERVICE_DATE_LOOKBACK_DAYS", 1, minimum=0)
DETAIL_LIMIT_PER_RUN = env_int("DETAIL_LIMIT_PER_RUN", 0, minimum=0)
RETENTION_DAYS = env_int("RETENTION_DAYS", 30)
STATION_REGISTRY_REFRESH_DAYS = env_int("STATION_REGISTRY_REFRESH_DAYS", 7)
REGION_CODES = [
    int(item.strip())
    for item in os.getenv("REGION_CODES", "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22").split(",")
    if item.strip().isdigit()
]
BOARD_TYPES = [
    item.strip()
    for item in os.getenv("BOARD_TYPES", "partenze,arrivi").split(",")
    if item.strip() in {"partenze", "arrivi"}
]
OPTIONAL_STATION_CSV = os.getenv("STATION_CSV_PATH", "/data/stations.csv")

app = Flask(__name__)
collector_lock = threading.Lock()
thread_local = threading.local()


def db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(SQLITE_PATH), exist_ok=True)
    conn = sqlite3.connect(SQLITE_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    except sqlite3.OperationalError:
        return set()


def drop_if_incompatible(conn: sqlite3.Connection, table: str, required_columns: set[str]) -> None:
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    if row and not required_columns.issubset(table_columns(conn, table)):
        conn.execute(f"DROP TABLE {table}")


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    if column not in table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    with db() as conn:
        drop_if_incompatible(conn, "station_registry", {"station_code", "station_name", "region_code", "updated_at"})
        drop_if_incompatible(conn, "trains", {"date", "train_key", "departure_epoch_ms", "has_details", "completed"})
        drop_if_incompatible(conn, "train_stops", {"date", "train_key", "stop_number", "station_code"})

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                finished_at TEXT,
                duration_seconds REAL DEFAULT 0,
                status TEXT DEFAULT 'success',
                treni_giorno INTEGER NOT NULL DEFAULT 0,
                treni_circolanti INTEGER NOT NULL DEFAULT 0,
                raw_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_date_time
                ON snapshots(date, captured_at);

            CREATE TABLE IF NOT EXISTS collector_runs (
                slot_at TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                status TEXT NOT NULL,
                trigger TEXT DEFAULT 'scheduler',
                started_at TEXT,
                finished_at TEXT,
                duration_seconds REAL DEFAULT 0,
                stations INTEGER DEFAULT 0,
                board_rows INTEGER DEFAULT 0,
                detail_queue INTEGER DEFAULT 0,
                details INTEGER DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_collector_runs_date_slot
                ON collector_runs(date, slot_at);

            CREATE TABLE IF NOT EXISTS station_registry (
                station_code TEXT PRIMARY KEY,
                station_name TEXT NOT NULL,
                region_code INTEGER DEFAULT 0,
                latitude REAL,
                longitude REAL,
                source TEXT DEFAULT 'viaggiatreno',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trains (
                date TEXT NOT NULL,
                service_date TEXT,
                train_key TEXT NOT NULL,
                train_number TEXT,
                departure_epoch_ms TEXT,
                category TEXT,
                operator TEXT,
                status TEXT,
                origin TEXT,
                destination TEXT,
                origin_code TEXT,
                destination_code TEXT,
                relation_key TEXT,
                departure_delay INTEGER DEFAULT 0,
                arrival_delay INTEGER DEFAULT 0,
                delay INTEGER DEFAULT 0,
                cancelled INTEGER DEFAULT 0,
                rescheduled INTEGER DEFAULT 0,
                not_departed INTEGER DEFAULT 0,
                scheduled_departure TEXT,
                scheduled_arrival TEXT,
                last_seen TEXT,
                detail_last_seen TEXT,
                has_details INTEGER DEFAULT 0,
                completed INTEGER DEFAULT 0,
                raw_json TEXT,
                PRIMARY KEY (date, train_key)
            );

            CREATE INDEX IF NOT EXISTS idx_trains_date_delay
                ON trains(date, delay DESC);

            CREATE INDEX IF NOT EXISTS idx_trains_detail_queue
                ON trains(date, has_details, completed, last_seen);

            CREATE TABLE IF NOT EXISTS train_stops (
                date TEXT NOT NULL,
                train_key TEXT NOT NULL,
                stop_number INTEGER NOT NULL,
                train_number TEXT,
                category TEXT,
                station_code TEXT,
                station_name TEXT,
                stop_type TEXT,
                platform TEXT,
                arrival_expected TEXT,
                arrival_actual TEXT,
                arrival_delay INTEGER,
                departure_expected TEXT,
                departure_actual TEXT,
                departure_delay INTEGER,
                cancelled INTEGER DEFAULT 0,
                raw_json TEXT,
                PRIMARY KEY (date, train_key, stop_number)
            );

            CREATE INDEX IF NOT EXISTS idx_train_stops_station_date
                ON train_stops(date, station_code);

            CREATE TABLE IF NOT EXISTS station_stats (
                date TEXT NOT NULL,
                station_code TEXT NOT NULL,
                station_name TEXT NOT NULL,
                departures_count INTEGER DEFAULT 0,
                arrivals_count INTEGER DEFAULT 0,
                monitored INTEGER DEFAULT 0,
                cancelled INTEGER DEFAULT 0,
                delayed INTEGER DEFAULT 0,
                total_delay INTEGER DEFAULT 0,
                last_seen TEXT,
                PRIMARY KEY (date, station_code)
            );

            CREATE TABLE IF NOT EXISTS station_board_stats (
                date TEXT NOT NULL,
                station_code TEXT NOT NULL,
                board_type TEXT NOT NULL,
                station_name TEXT NOT NULL,
                monitored INTEGER DEFAULT 0,
                cancelled INTEGER DEFAULT 0,
                delayed INTEGER DEFAULT 0,
                total_delay INTEGER DEFAULT 0,
                last_seen TEXT,
                PRIMARY KEY (date, station_code, board_type)
            );

            CREATE TABLE IF NOT EXISTS relation_stats (
                date TEXT NOT NULL,
                relation_key TEXT NOT NULL,
                from_station TEXT,
                to_station TEXT,
                monitored INTEGER DEFAULT 0,
                cancelled INTEGER DEFAULT 0,
                total_delay INTEGER DEFAULT 0,
                last_seen TEXT,
                PRIMARY KEY (date, relation_key)
            );
            """
        )
        ensure_column(conn, "snapshots", "finished_at", "TEXT")
        ensure_column(conn, "snapshots", "duration_seconds", "REAL DEFAULT 0")
        ensure_column(conn, "snapshots", "status", "TEXT DEFAULT 'success'")
        ensure_column(conn, "trains", "service_date", "TEXT")
        ensure_column(conn, "trains", "not_departed", "INTEGER DEFAULT 0")


def now_rome() -> datetime:
    return datetime.now(APP_TZ)


def today_rome() -> str:
    return now_rome().date().isoformat()


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_utc_iso(dt: datetime) -> str:
    current = dt if dt.tzinfo else dt.replace(tzinfo=APP_TZ)
    return current.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def js_date_string(dt: datetime | None = None) -> str:
    current = (dt or now_rome()).astimezone(APP_TZ)
    weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    offset = current.utcoffset() or timedelta(hours=1)
    total_minutes = int(offset.total_seconds() // 60)
    sign = "+" if total_minutes >= 0 else "-"
    total_minutes = abs(total_minutes)
    hours, minutes = divmod(total_minutes, 60)
    return (
        f"{weekdays[current.weekday()]} {months[current.month - 1]} {current.day:02d} "
        f"{current.year} {current.hour:02d}:{current.minute:02d}:{current.second:02d} "
        f"GMT{sign}{hours:02d}{minutes:02d}"
    )


def midnight_epoch_ms(date_text: str | None = None) -> str:
    return core_midnight_epoch_ms(date_text)


def parse_time_of_day(value: str, fallback_hour: int = 23, fallback_minute: int = 55) -> tuple[int, int]:
    try:
        hour_text, minute_text = value.strip().split(":", 1)
        hour = min(23, max(0, int(hour_text)))
        minute = min(59, max(0, int(minute_text)))
        return hour, minute
    except (AttributeError, ValueError):
        return fallback_hour, fallback_minute


def scheduled_minutes() -> list[int]:
    interval = max(1, COLLECTOR_INTERVAL_MINUTES)
    minutes = set()
    minute = COLLECTOR_SCHEDULE_OFFSET_MINUTES
    while minute < 24 * 60:
        minutes.add(minute)
        minute += interval
    final_hour, final_minute = parse_time_of_day(COLLECTOR_FINALIZE_TIME)
    minutes.add(final_hour * 60 + final_minute)
    return sorted(minutes)


def slots_for_day(day, include_neighbors: bool = False) -> list[datetime]:
    days = [day]
    if include_neighbors:
        days = [day - timedelta(days=1), day, day + timedelta(days=1)]
    slots: list[datetime] = []
    for current_day in days:
        midnight = datetime.combine(current_day, datetime.min.time(), tzinfo=APP_TZ)
        slots.extend(midnight + timedelta(minutes=minute) for minute in scheduled_minutes())
    return sorted(slots)


def previous_scheduled_slot(reference: datetime | None = None) -> datetime:
    current = (reference or now_rome()).astimezone(APP_TZ)
    previous = [slot for slot in slots_for_day(current.date(), include_neighbors=True) if slot <= current]
    return previous[-1] if previous else slots_for_day(current.date() - timedelta(days=1))[-1]


def next_scheduled_slot(reference: datetime | None = None) -> datetime:
    current = (reference or now_rome()).astimezone(APP_TZ)
    future = [slot for slot in slots_for_day(current.date(), include_neighbors=True) if slot > current]
    return future[0] if future else slots_for_day(current.date() + timedelta(days=1))[0]


def run_exists(slot_at: datetime) -> bool:
    with db() as conn:
        row = conn.execute("SELECT 1 FROM collector_runs WHERE slot_at=?", (to_utc_iso(slot_at),)).fetchone()
    return bool(row)


def due_scheduled_slot(reference: datetime | None = None) -> datetime | None:
    current = (reference or now_rome()).astimezone(APP_TZ)
    slot = previous_scheduled_slot(current)
    age = current - slot
    if age < timedelta(0) or age > timedelta(minutes=COLLECTOR_CATCHUP_GRACE_MINUTES):
        return None
    return None if run_exists(slot) else slot


def collector_run_row() -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM collector_runs ORDER BY slot_at DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def record_collector_run(
    slot_at: datetime,
    status: str,
    *,
    trigger: str = "scheduler",
    started_at: str | None = None,
    finished_at: str | None = None,
    duration_seconds: float = 0,
    stations: int = 0,
    board_rows: int = 0,
    detail_queue: int = 0,
    details: int = 0,
    error: str | None = None,
) -> None:
    slot_iso = to_utc_iso(slot_at)
    date = slot_at.astimezone(APP_TZ).date().isoformat()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO collector_runs (
                slot_at, date, status, trigger, started_at, finished_at, duration_seconds,
                stations, board_rows, detail_queue, details, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slot_at) DO UPDATE SET
                date=excluded.date,
                status=excluded.status,
                trigger=excluded.trigger,
                started_at=COALESCE(excluded.started_at, collector_runs.started_at),
                finished_at=excluded.finished_at,
                duration_seconds=excluded.duration_seconds,
                stations=excluded.stations,
                board_rows=excluded.board_rows,
                detail_queue=excluded.detail_queue,
                details=excluded.details,
                error=excluded.error
            """,
            (
                slot_iso,
                date,
                status,
                trigger,
                started_at,
                finished_at,
                duration_seconds,
                stations,
                board_rows,
                detail_queue,
                details,
                error,
                iso_now(),
            ),
        )


def record_skipped_slots(started_slot: datetime, finished_at: datetime) -> None:
    current = finished_at.astimezone(APP_TZ)
    for slot in slots_for_day(current.date(), include_neighbors=True):
        if started_slot < slot <= current and not run_exists(slot):
            record_collector_run(
                slot,
                "skipped",
                finished_at=to_utc_iso(current),
                error="previous_run_active",
            )


def record_missed_slots(reference: datetime | None = None) -> None:
    current = (reference or now_rome()).astimezone(APP_TZ)
    grace_cutoff = current - timedelta(minutes=COLLECTOR_CATCHUP_GRACE_MINUTES)
    lookback_minutes = max(COLLECTOR_INTERVAL_MINUTES * 3, 120)
    earliest = current - timedelta(minutes=lookback_minutes)
    for slot in slots_for_day(current.date(), include_neighbors=True):
        if earliest <= slot < grace_cutoff and not run_exists(slot):
            record_collector_run(
                slot,
                "missed",
                finished_at=to_utc_iso(current),
                error="outside_catchup_grace",
            )


def require_auth() -> Response | None:
    if request.path == "/health":
        return None
    if not SECURITY_TOKEN:
        return jsonify({"available": False, "reason": "not_configured"}), 503
    if request.headers.get("X-Bello-Stats-Token") != SECURITY_TOKEN:
        return jsonify({"available": False, "reason": "forbidden"}), 403
    return None


app.before_request(require_auth)


def vt_session() -> requests.Session:
    session = getattr(thread_local, "vt_session", None)
    if session is None:
        session = requests.Session()
        thread_local.vt_session = session
    return session


def vt_get(path: str, timeout: int = 25) -> Any:
    if not RFI_PROXY_SECURITY_TOKEN:
        raise RuntimeError("RFI_PROXY_SECURITY_TOKEN is not configured")
    target = f"{VT_BASE_URL}/{path.lstrip('/')}"
    proxy_url = f"{RFI_PROXY_BASE_URL}/?{urlencode({'url': target})}"
    response = vt_session().get(
        proxy_url,
        headers={"X-Bello-Token": RFI_PROXY_SECURITY_TOKEN, "Accept": "application/json,text/plain,*/*"},
        timeout=timeout,
    )
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "json" in content_type:
        return response.json()
    text = response.text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def as_int(value: Any, default: int = 0) -> int:
    return core_as_int(value, default)


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value or "").strip().lower()
    return text in {"1", "true", "t", "yes", "y", "si", "s"}


def pick(source: dict[str, Any], *keys: str, default: Any = None) -> Any:
    return core_pick(source, *keys, default=default)


def normalize_category(value: Any) -> str:
    return core_normalize_category(value)


def clean_station_name(value: Any) -> str:
    return str(value or "").strip()


def train_key_from_parts(number: Any, origin_code: Any, departure_epoch_ms: Any, fallback_date: str | None = None) -> str:
    return core_train_key_from_parts(number, origin_code, departure_epoch_ms, fallback_date=fallback_date or today_rome())


def train_key(item: dict[str, Any], fallback_date: str | None = None) -> str:
    return train_key_from_parts(
        pick(item, "numeroTreno", "trainNumber", "compNumeroTreno", default=""),
        pick(item, "codLocOrig", "idOrigine", "codOrigine", default=""),
        pick(item, "dataPartenzaTreno", "dataPartenza", default=midnight_epoch_ms(fallback_date)),
        fallback_date=fallback_date,
    )


def timestamp_to_iso(value: Any) -> str | None:
    if value is None or value == "":
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=APP_TZ).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def service_date_from_item(item: dict[str, Any], fallback_date: str) -> str:
    return core_service_date_from_item(item, fallback_date)


def is_collectable_service_date(item: dict[str, Any], collection_date: str) -> bool:
    return core_is_service_date_within_lookback(
        item,
        collection_date,
        lookback_days=COLLECTOR_SERVICE_DATE_LOOKBACK_DAYS,
    )


def status_from_item(item: dict[str, Any]) -> str:
    provvedimento = as_int(pick(item, "provvedimento", "codProvvedimento", default=0))
    tipo_treno = str(pick(item, "tipoTreno", default="")).upper()
    if provvedimento == 1 or tipo_treno == "ST" or item.get("cancellato"):
        return "cancelled"
    if provvedimento in {2, 3} or str(pick(item, "riprogrammazione", default="N")).upper() not in {"", "N", "NO"}:
        return "rescheduled"
    if is_not_departed(item):
        return "not_departed"
    if as_int(pick(item, "ritardo", "delay", default=0)) > 5:
        return "delayed"
    return "regular"


def is_not_departed(item: dict[str, Any]) -> bool:
    if as_bool(pick(item, "nonPartito", "notDeparted", default=False)):
        return True
    for key in ("compRitardo", "compRitardoAndamento"):
        value = item.get(key)
        values = value if isinstance(value, list) else [value]
        for entry in values:
            if "non partito" in str(entry or "").lower() or "not departed" in str(entry or "").lower():
                return True
    return False


def normalize_station_from_region(raw: dict[str, Any], region_code: int) -> dict[str, Any] | None:
    if as_int(raw.get("tipoStazione")) == 4:
        return None
    localita = raw.get("localita") or {}
    code = str(raw.get("codStazione") or raw.get("codiceStazione") or localita.get("id") or "").strip()
    name = clean_station_name(localita.get("nomeLungo") or localita.get("nomeBreve") or raw.get("nomeCitta"))
    if not code or not name:
        return None
    return {
        "station_code": code,
        "station_name": name,
        "region_code": as_int(raw.get("codReg"), region_code),
        "latitude": raw.get("lat"),
        "longitude": raw.get("lon"),
        "source": "viaggiatreno",
        "updated_at": iso_now(),
    }


def fetch_region_stations(region_code: int) -> list[dict[str, Any]]:
    data = vt_get(f"elencoStazioni/{region_code}", timeout=35)
    if not isinstance(data, list):
        return []
    stations = []
    for raw in data:
        if isinstance(raw, dict):
            station = normalize_station_from_region(raw, region_code)
            if station:
                stations.append(station)
    return stations


def normalize_header(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def load_optional_station_csv() -> list[dict[str, Any]]:
    path = Path(OPTIONAL_STATION_CSV)
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        sample = handle.read(4096)
        handle.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(handle, dialect=dialect)
        for raw in reader:
            mapped = {normalize_header(key or ""): value for key, value in raw.items()}
            code = str(mapped.get("idstazione") or mapped.get("stationcode") or mapped.get("code") or "").strip()
            name = clean_station_name(mapped.get("stazione") or mapped.get("luogo") or mapped.get("station") or mapped.get("name"))
            region_code = as_int(mapped.get("idregione") or mapped.get("region") or mapped.get("regioncode"), 0)
            if not code or not name:
                continue
            rows.append(
                {
                    "station_code": code,
                    "station_name": name,
                    "region_code": region_code,
                    "latitude": None,
                    "longitude": None,
                    "source": "csv",
                    "updated_at": iso_now(),
                }
            )
    return rows


def load_station_registry() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT station_code, station_name, region_code, latitude, longitude, source, updated_at
            FROM station_registry
            ORDER BY region_code, station_name
            """
        ).fetchall()
    return [dict(row) for row in rows]


def station_registry_refresh_due() -> bool:
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated FROM station_registry"
        ).fetchone()
    if not row or as_int(row["total"]) == 0:
        return True
    last_updated = parse_iso_datetime(row["last_updated"])
    if not last_updated:
        return True
    age = datetime.now(timezone.utc) - last_updated.astimezone(timezone.utc)
    return age >= timedelta(days=STATION_REGISTRY_REFRESH_DAYS)


def refresh_station_registry(require_complete: bool = False) -> list[dict[str, Any]]:
    stations_by_code: dict[str, dict[str, Any]] = {}
    failed_regions = 0
    with ThreadPoolExecutor(max_workers=COLLECTOR_REGION_CONCURRENCY) as executor:
        futures = [executor.submit(fetch_region_stations, region_code) for region_code in REGION_CODES]
        for future in as_completed(futures):
            try:
                for station in future.result():
                    stations_by_code.setdefault(station["station_code"], station)
            except Exception as exc:
                failed_regions += 1
                app.logger.warning("station region fetch failed: %s", exc)

    for station in load_optional_station_csv():
        stations_by_code.setdefault(station["station_code"], station)

    if failed_regions and require_complete:
        raise RuntimeError(f"station registry refresh failed for {failed_regions} region(s)")

    stations = sorted(stations_by_code.values(), key=lambda item: (item["region_code"], item["station_name"]))
    if not stations:
        raise RuntimeError("station registry refresh returned no stations")
    with db() as conn:
        conn.executemany(
            """
            INSERT INTO station_registry (
                station_code, station_name, region_code, latitude, longitude, source, updated_at
            ) VALUES (
                :station_code, :station_name, :region_code, :latitude, :longitude, :source, :updated_at
            )
            ON CONFLICT(station_code) DO UPDATE SET
                station_name=excluded.station_name,
                region_code=CASE WHEN excluded.region_code > 0 THEN excluded.region_code ELSE station_registry.region_code END,
                latitude=COALESCE(excluded.latitude, station_registry.latitude),
                longitude=COALESCE(excluded.longitude, station_registry.longitude),
                source=excluded.source,
                updated_at=excluded.updated_at
            """,
            stations,
        )
    return load_station_registry()


def stations_for_collection() -> tuple[list[dict[str, Any]], bool]:
    cached = load_station_registry()
    if cached and not station_registry_refresh_due():
        return cached, False
    try:
        return refresh_station_registry(require_complete=bool(cached)), True
    except Exception as exc:
        if cached:
            app.logger.warning("station registry refresh failed; using cached registry: %s", exc)
            return cached, False
        raise


def fetch_board(station_code: str, board_type: str, board_time: datetime) -> list[dict[str, Any]]:
    date_string = quote(js_date_string(board_time), safe="")
    data = vt_get(f"{board_type}/{station_code}/{date_string}", timeout=25)
    return data if isinstance(data, list) else []


def board_candidate(item: dict[str, Any], fallback_date: str) -> dict[str, str] | None:
    number = str(pick(item, "numeroTreno", "compNumeroTreno", default="")).strip()
    origin_code = str(pick(item, "codLocOrig", "idOrigine", "codOrigine", default="")).strip()
    departure_epoch = str(pick(item, "dataPartenzaTreno", "dataPartenza", default=midnight_epoch_ms(fallback_date))).strip()
    if not number or not origin_code:
        return None
    return {
        "number": number,
        "origin_code": origin_code,
        "departure_epoch_ms": departure_epoch,
        "train_key": train_key_from_parts(number, origin_code, departure_epoch, fallback_date=fallback_date),
    }


def normalize_train(
    item: dict[str, Any],
    seen_at: str,
    has_details: bool = False,
    fallback_date: str | None = None,
    stats_date: str | None = None,
) -> dict[str, Any]:
    service_date = service_date_from_item(item, fallback_date or today_rome())
    record_date = stats_date or service_date
    stops = item.get("fermate") if isinstance(item.get("fermate"), list) else []
    first_stop = stops[0] if stops else {}
    last_stop = stops[-1] if stops else {}
    category = normalize_category(pick(item, "categoria", "compCategoria", "categoriaDescrizione", default=""))
    number = str(pick(item, "numeroTreno", "trainNumber", "compNumeroTreno", default="")).strip()
    origin = clean_station_name(pick(item, "origine", "stazioneOrigine", default="") or first_stop.get("stazione"))
    destination = clean_station_name(pick(item, "destinazione", "stazioneDestinazione", default="") or last_stop.get("stazione"))
    origin_code = str(pick(item, "idOrigine", "codLocOrig", "codOrigine", default="") or first_stop.get("id") or "").strip()
    destination_code = str(pick(item, "idDestinazione", "codDestinazione", default="") or last_stop.get("id") or "").strip()
    departure_epoch = str(pick(item, "dataPartenzaTreno", "dataPartenza", default=midnight_epoch_ms(service_date))).strip()
    delay = as_int(pick(item, "ritardo", "delay", default=0))
    departure_delay = as_int(pick(first_stop, "ritardoPartenza", default=pick(item, "ritardoPartenza", default=delay)))
    arrival_delay = as_int(pick(last_stop, "ritardoArrivo", default=pick(item, "ritardoArrivo", default=delay)))
    status = status_from_item(item)
    cancelled = 1 if status == "cancelled" else 0
    rescheduled = 1 if status == "rescheduled" else 0
    not_departed = 1 if is_not_departed(item) else 0
    completed = cancelled
    if stops:
        last_arrival_actual = pick(last_stop, "arrivoReale", "effettiva", default=None)
        completed = 1 if cancelled or last_arrival_actual else 0
    relation_key = f"{origin} -> {destination}" if origin or destination else ""
    scheduled_departure = timestamp_to_iso(pick(first_stop, "partenza_teorica", "programmata", default=None)) or str(
        pick(item, "compOrarioPartenza", "orarioPartenza", default="")
    ).strip()
    scheduled_arrival = timestamp_to_iso(pick(last_stop, "arrivo_teorico", "programmata", default=None)) or str(
        pick(item, "compOrarioArrivo", "orarioArrivo", default="")
    ).strip()
    return {
        "date": record_date,
        "service_date": service_date,
        "train_key": train_key_from_parts(number, origin_code, departure_epoch, fallback_date=service_date),
        "train_number": number,
        "departure_epoch_ms": departure_epoch,
        "category": category,
        "operator": str(pick(item, "cliente", "operatore", "operator", "codiceCliente", default="")).strip(),
        "status": status,
        "origin": origin,
        "destination": destination,
        "origin_code": origin_code,
        "destination_code": destination_code,
        "relation_key": relation_key,
        "departure_delay": departure_delay,
        "arrival_delay": arrival_delay,
        "delay": max(delay, departure_delay, arrival_delay),
        "cancelled": cancelled,
        "rescheduled": rescheduled,
        "not_departed": not_departed,
        "scheduled_departure": scheduled_departure,
        "scheduled_arrival": scheduled_arrival,
        "last_seen": seen_at,
        "detail_last_seen": seen_at if has_details else None,
        "has_details": 1 if has_details else 0,
        "completed": completed,
        "raw_json": json.dumps(item, ensure_ascii=False, separators=(",", ":")),
    }


def upsert_train(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO trains (
            date, service_date, train_key, train_number, departure_epoch_ms, category, operator, status, origin, destination,
            origin_code, destination_code, relation_key, departure_delay, arrival_delay, delay,
            cancelled, rescheduled, not_departed, scheduled_departure, scheduled_arrival, last_seen, detail_last_seen,
            has_details, completed, raw_json
        ) VALUES (
            :date, :service_date, :train_key, :train_number, :departure_epoch_ms, :category, :operator, :status, :origin, :destination,
            :origin_code, :destination_code, :relation_key, :departure_delay, :arrival_delay, :delay,
            :cancelled, :rescheduled, :not_departed, :scheduled_departure, :scheduled_arrival, :last_seen, :detail_last_seen,
            :has_details, :completed, :raw_json
        )
        ON CONFLICT(date, train_key) DO UPDATE SET
            service_date=COALESCE(excluded.service_date, trains.service_date),
            train_number=COALESCE(NULLIF(excluded.train_number, ''), trains.train_number),
            departure_epoch_ms=COALESCE(NULLIF(excluded.departure_epoch_ms, ''), trains.departure_epoch_ms),
            category=COALESCE(NULLIF(excluded.category, ''), trains.category),
            operator=COALESCE(NULLIF(excluded.operator, ''), trains.operator),
            status=excluded.status,
            origin=COALESCE(NULLIF(excluded.origin, ''), trains.origin),
            destination=COALESCE(NULLIF(excluded.destination, ''), trains.destination),
            origin_code=COALESCE(NULLIF(excluded.origin_code, ''), trains.origin_code),
            destination_code=COALESCE(NULLIF(excluded.destination_code, ''), trains.destination_code),
            relation_key=COALESCE(NULLIF(excluded.relation_key, ''), trains.relation_key),
            departure_delay=excluded.departure_delay,
            arrival_delay=excluded.arrival_delay,
            delay=excluded.delay,
            cancelled=excluded.cancelled,
            rescheduled=excluded.rescheduled,
            not_departed=excluded.not_departed,
            scheduled_departure=COALESCE(NULLIF(excluded.scheduled_departure, ''), trains.scheduled_departure),
            scheduled_arrival=COALESCE(NULLIF(excluded.scheduled_arrival, ''), trains.scheduled_arrival),
            last_seen=excluded.last_seen,
            detail_last_seen=COALESCE(excluded.detail_last_seen, trains.detail_last_seen),
            has_details=MAX(excluded.has_details, trains.has_details),
            completed=MAX(excluded.completed, trains.completed),
            raw_json=CASE WHEN excluded.has_details = 1 THEN excluded.raw_json ELSE trains.raw_json END
        """,
        row,
    )


def normalize_stop(detail: dict[str, Any], stop: dict[str, Any], index: int, row: dict[str, Any]) -> dict[str, Any]:
    stop_type = str(pick(stop, "tipoFermata", default="")).upper()
    actual_type = as_int(stop.get("actualFermataType"), 1)
    cancelled = 1 if stop_type == "C" or actual_type == 3 else 0
    platform = str(
        pick(
            stop,
            "binarioEffettivoArrivoDescrizione",
            "binarioEffettivoPartenzaDescrizione",
            "binarioProgrammatoArrivoDescrizione",
            "binarioProgrammatoPartenzaDescrizione",
            default="",
        )
    ).strip()
    return {
        "date": row["date"],
        "train_key": row["train_key"],
        "stop_number": index,
        "train_number": row["train_number"],
        "category": row["category"],
        "station_code": str(stop.get("id") or "").strip(),
        "station_name": clean_station_name(stop.get("stazione")),
        "stop_type": stop_type,
        "platform": platform,
        "arrival_expected": timestamp_to_iso(pick(stop, "arrivo_teorico", "programmata", default=None)),
        "arrival_actual": timestamp_to_iso(pick(stop, "arrivoReale", default=None)),
        "arrival_delay": as_int(stop.get("ritardoArrivo"), 0),
        "departure_expected": timestamp_to_iso(pick(stop, "partenza_teorica", "programmata", default=None)),
        "departure_actual": timestamp_to_iso(pick(stop, "partenzaReale", default=None)),
        "departure_delay": as_int(stop.get("ritardoPartenza"), 0),
        "cancelled": cancelled,
        "raw_json": json.dumps(stop, ensure_ascii=False, separators=(",", ":")),
    }


def replace_train_stops(conn: sqlite3.Connection, detail: dict[str, Any], row: dict[str, Any]) -> None:
    stops = detail.get("fermate")
    if not isinstance(stops, list):
        return
    conn.execute("DELETE FROM train_stops WHERE date=? AND train_key=?", (row["date"], row["train_key"]))
    normalized = [normalize_stop(detail, stop, index, row) for index, stop in enumerate(stops) if isinstance(stop, dict)]
    conn.executemany(
        """
        INSERT INTO train_stops (
            date, train_key, stop_number, train_number, category, station_code, station_name, stop_type,
            platform, arrival_expected, arrival_actual, arrival_delay, departure_expected, departure_actual,
            departure_delay, cancelled, raw_json
        ) VALUES (
            :date, :train_key, :stop_number, :train_number, :category, :station_code, :station_name, :stop_type,
            :platform, :arrival_expected, :arrival_actual, :arrival_delay, :departure_expected, :departure_actual,
            :departure_delay, :cancelled, :raw_json
        )
        """,
        normalized,
    )


def update_station_board_stats(conn: sqlite3.Connection, date: str, station_code: str, station_name: str, board_type: str, trains: list[dict[str, Any]], seen_at: str) -> None:
    monitored = len(trains)
    cancelled = sum(1 for item in trains if status_from_item(item) == "cancelled")
    delayed = sum(1 for item in trains if as_int(pick(item, "ritardo", default=0)) > 5)
    total_delay = sum(max(0, as_int(pick(item, "ritardo", default=0))) for item in trains)
    conn.execute(
        """
        INSERT INTO station_board_stats (
            date, station_code, board_type, station_name, monitored, cancelled, delayed, total_delay, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, station_code, board_type) DO UPDATE SET
            station_name=excluded.station_name,
            monitored=excluded.monitored,
            cancelled=excluded.cancelled,
            delayed=excluded.delayed,
            total_delay=excluded.total_delay,
            last_seen=excluded.last_seen
        """,
        (date, station_code, board_type, station_name, monitored, cancelled, delayed, total_delay, seen_at),
    )


def fetch_board_task(task: tuple[dict[str, Any], str, datetime]) -> dict[str, Any]:
    station, board_type, board_time = task
    try:
        rows = fetch_board(station["station_code"], board_type, board_time)
    except Exception as exc:
        app.logger.warning("board fetch failed %s %s: %s", station["station_code"], board_type, exc)
        rows = []
    return {"station": station, "board_type": board_type, "rows": rows}


def fetch_detail(candidate: dict[str, str]) -> dict[str, Any] | None:
    try:
        data = vt_get(
            f"andamentoTreno/{candidate['origin_code']}/{candidate['number']}/{candidate['departure_epoch_ms']}",
            timeout=30,
        )
        return data if isinstance(data, dict) else None
    except Exception as exc:
        app.logger.info("andamentoTreno failed for %s: %s", candidate, exc)
        return None


def bounded_futures(items: list[Any], worker: Any, max_workers: int):
    max_workers = max(1, max_workers)
    max_pending = max_workers * 2
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        iterator = iter(items)
        pending = set()

        def submit_more() -> None:
            while len(pending) < max_pending:
                try:
                    item = next(iterator)
                except StopIteration:
                    break
                pending.add(executor.submit(worker, item))

        submit_more()
        while pending:
            future = next(as_completed(pending))
            pending.remove(future)
            yield future
            submit_more()


def detail_queue(date: str, board_candidates: dict[str, dict[str, str]]) -> list[dict[str, str]]:
    queue: list[dict[str, str]] = []
    with db() as conn:
        existing = {
            row["train_key"]: row
            for row in conn.execute(
                "SELECT train_key, has_details, completed FROM trains WHERE date=?",
                (date,),
            ).fetchall()
        }
        for key, candidate in board_candidates.items():
            row = existing.get(key)
            if row and row["has_details"] and row["completed"]:
                continue
            queue.append(candidate)
        unfinished = conn.execute(
            """
            SELECT train_key, train_number, origin_code, departure_epoch_ms
            FROM trains
            WHERE date=? AND (has_details=0 OR completed=0)
            ORDER BY last_seen DESC
            """,
            (date,),
        ).fetchall()
        for row in unfinished:
            if row["train_key"] in board_candidates:
                continue
            if not row["train_number"] or not row["origin_code"] or not row["departure_epoch_ms"]:
                continue
            queue.append(
                {
                    "train_key": row["train_key"],
                    "number": row["train_number"],
                    "origin_code": row["origin_code"],
                    "departure_epoch_ms": row["departure_epoch_ms"],
                }
            )
    if DETAIL_LIMIT_PER_RUN:
        return queue[:DETAIL_LIMIT_PER_RUN]
    return queue


def rebuild_daily_aggregates(conn: sqlite3.Connection, date: str) -> None:
    conn.execute("DELETE FROM station_stats WHERE date=?", (date,))
    conn.execute(
        """
        INSERT INTO station_stats (
            date, station_code, station_name, departures_count, arrivals_count, monitored,
            cancelled, delayed, total_delay, last_seen
        )
        SELECT
            ts.date,
            ts.station_code,
            MAX(ts.station_name),
            SUM(CASE WHEN ts.departure_expected IS NOT NULL THEN 1 ELSE 0 END),
            SUM(CASE WHEN ts.arrival_expected IS NOT NULL THEN 1 ELSE 0 END),
            COUNT(DISTINCT ts.train_key),
            SUM(CASE WHEN ts.cancelled=1 THEN 1 ELSE 0 END),
            SUM(CASE WHEN MAX(COALESCE(ts.arrival_delay, 0), COALESCE(ts.departure_delay, 0)) > 5 THEN 1 ELSE 0 END),
            SUM(MAX(COALESCE(ts.arrival_delay, 0), COALESCE(ts.departure_delay, 0))),
            MAX(t.last_seen)
        FROM train_stops ts
        LEFT JOIN trains t ON t.date=ts.date AND t.train_key=ts.train_key
        WHERE ts.date=? AND ts.station_code IS NOT NULL AND ts.station_code<>''
        GROUP BY ts.date, ts.station_code
        """,
        (date,),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO station_stats (
            date, station_code, station_name, departures_count, arrivals_count, monitored,
            cancelled, delayed, total_delay, last_seen
        )
        SELECT
            b.date,
            b.station_code,
            MAX(b.station_name),
            SUM(CASE WHEN b.board_type='partenze' THEN b.monitored ELSE 0 END),
            SUM(CASE WHEN b.board_type='arrivi' THEN b.monitored ELSE 0 END),
            SUM(b.monitored),
            SUM(b.cancelled),
            SUM(b.delayed),
            SUM(b.total_delay),
            MAX(b.last_seen)
        FROM station_board_stats b
        LEFT JOIN station_stats s ON s.date=b.date AND s.station_code=b.station_code
        WHERE b.date=? AND s.station_code IS NULL
        GROUP BY b.date, b.station_code
        """,
        (date,),
    )
    conn.execute("DELETE FROM relation_stats WHERE date=?", (date,))
    conn.execute(
        """
        INSERT INTO relation_stats (
            date, relation_key, from_station, to_station, monitored, cancelled, total_delay, last_seen
        )
        SELECT
            date,
            relation_key,
            MAX(origin),
            MAX(destination),
            COUNT(*),
            SUM(cancelled),
            SUM(CASE WHEN delay > 0 THEN delay ELSE 0 END),
            MAX(last_seen)
        FROM trains
        WHERE date=? AND relation_key IS NOT NULL AND relation_key<>''
        GROUP BY date, relation_key
        """,
        (date,),
    )


def cleanup_old_rows(conn: sqlite3.Connection) -> None:
    cutoff = (now_rome().date() - timedelta(days=RETENTION_DAYS)).isoformat()
    for table in ("snapshots", "collector_runs", "trains", "train_stops", "station_stats", "station_board_stats", "relation_stats"):
        conn.execute(f"DELETE FROM {table} WHERE date < ?", (cutoff,))


def collect_once(slot_at: datetime | None = None, trigger: str = "manual") -> dict[str, Any]:
    slot = (slot_at or previous_scheduled_slot()).astimezone(APP_TZ).replace(second=0, microsecond=0)
    started = time.monotonic()
    started_at = iso_now()
    date = slot.date().isoformat()
    seen_at = to_utc_iso(slot)
    summary = {}
    record_collector_run(slot, "running", trigger=trigger, started_at=started_at)

    try:
        try:
            summary = vt_get("statistiche/0")
        except Exception as exc:
            app.logger.warning("statistiche/0 failed: %s", exc)
            summary = {}

        stations, station_registry_refreshed = stations_for_collection()
        board_rows_count = 0
        detail_candidates_by_key: dict[str, dict[str, str]] = {}
        board_tasks = [(station, board_type, slot) for station in stations for board_type in BOARD_TYPES]

        with db() as conn:
            processed_boards = 0
            for future in bounded_futures(board_tasks, fetch_board_task, COLLECTOR_BOARD_CONCURRENCY):
                if time.monotonic() - started > COLLECTOR_MAX_RUNTIME_SECONDS:
                    break
                result = future.result()
                station = result["station"]
                board_type = result["board_type"]
                rows = result["rows"]
                collectable_rows = [
                    item
                    for item in rows
                    if isinstance(item, dict) and is_collectable_service_date(item, date)
                ]
                board_rows_count += len(collectable_rows)
                update_station_board_stats(
                    conn,
                    date,
                    station["station_code"],
                    station["station_name"],
                    board_type,
                    collectable_rows,
                    seen_at,
                )
                for item in collectable_rows:
                    row = normalize_train(item, seen_at, has_details=False, fallback_date=date, stats_date=date)
                    upsert_train(conn, row)
                    candidate = board_candidate(item, date)
                    if candidate:
                        detail_candidates_by_key[candidate["train_key"]] = candidate
                processed_boards += 1
                if processed_boards % 500 == 0:
                    conn.commit()

        queue = detail_queue(date, detail_candidates_by_key)
        detail_rows = []
        if queue:
            for future in bounded_futures(queue, fetch_detail, COLLECTOR_DETAIL_CONCURRENCY):
                if time.monotonic() - started > COLLECTOR_MAX_RUNTIME_SECONDS:
                    break
                detail = future.result()
                if detail and is_collectable_service_date(detail, date):
                    detail_rows.append(detail)

        with db() as conn:
            for detail in detail_rows:
                row = normalize_train(detail, seen_at, has_details=True, fallback_date=date, stats_date=date)
                upsert_train(conn, row)
                replace_train_stops(conn, detail, row)
            rebuild_daily_aggregates(conn, date)
            cleanup_old_rows(conn)
            finished_at = iso_now()
            duration_seconds = round(time.monotonic() - started, 2)
            conn.execute("DELETE FROM snapshots WHERE date=? AND captured_at=?", (date, seen_at))
            conn.execute(
                """
                INSERT INTO snapshots (
                    date, captured_at, finished_at, duration_seconds, status,
                    treni_giorno, treni_circolanti, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    date,
                    seen_at,
                    finished_at,
                    duration_seconds,
                    "success",
                    as_int((summary or {}).get("treniGiorno")),
                    as_int((summary or {}).get("treniCircolanti")),
                    json.dumps(summary or {}, ensure_ascii=False, separators=(",", ":")),
                ),
            )

        record_collector_run(
            slot,
            "success",
            trigger=trigger,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration_seconds,
            stations=len(stations),
            board_rows=board_rows_count,
            detail_queue=len(queue),
            details=len(detail_rows),
        )

        return {
            "available": True,
            "date": date,
            "snapshotTime": seen_at,
            "lastUpdated": finished_at,
            "collectionCompletedAt": finished_at,
            "collectionDurationSeconds": duration_seconds,
            "collectionStatus": "success",
            "nextScheduledAt": to_utc_iso(next_scheduled_slot()),
            "stations": len(stations),
            "stationRegistryRefreshed": station_registry_refreshed,
            "stationRegistryRefreshDays": STATION_REGISTRY_REFRESH_DAYS,
            "boardTypes": BOARD_TYPES,
            "boardRows": board_rows_count,
            "detailQueue": len(queue),
            "details": len(detail_rows),
            "summary": summary or {},
        }
    except Exception as exc:
        finished_at = iso_now()
        duration_seconds = round(time.monotonic() - started, 2)
        record_collector_run(
            slot,
            "failed",
            trigger=trigger,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration_seconds,
            error=str(exc)[:500],
        )
        raise


def collector_loop() -> None:
    while True:
        record_missed_slots()
        slot = due_scheduled_slot()
        if not slot:
            sleep_seconds = max(1, min(60, int((next_scheduled_slot() - now_rome()).total_seconds())))
            time.sleep(sleep_seconds)
            continue

        if collector_lock.acquire(blocking=False):
            try:
                app.logger.info("statistics collector started for slot %s", to_utc_iso(slot))
                collect_once(slot_at=slot, trigger="scheduler")
                record_skipped_slots(slot, now_rome())
                app.logger.info("statistics collector finished for slot %s", to_utc_iso(slot))
            except Exception as exc:
                app.logger.exception("statistics collector failed for slot %s: %s", to_utc_iso(slot), exc)
            finally:
                collector_lock.release()
        else:
            record_collector_run(slot, "skipped", finished_at=iso_now(), error="collector_busy")
            app.logger.info("statistics collector skipped for slot %s: previous run still active", to_utc_iso(slot))


def summary_for_date(date: str) -> dict[str, Any]:
    with db() as conn:
        snapshot = conn.execute(
            "SELECT * FROM snapshots WHERE date=? ORDER BY captured_at DESC LIMIT 1",
            (date,),
        ).fetchone()
        counts = conn.execute(
            """
            SELECT
                COUNT(*) AS monitored,
                SUM(cancelled) AS cancelled,
                SUM(rescheduled) AS rescheduled,
                SUM(CASE WHEN status='delayed' THEN 1 ELSE 0 END) AS delayed,
                SUM(CASE WHEN status='not_departed' THEN 1 ELSE 0 END) AS not_departed,
                SUM(CASE WHEN status='regular' THEN 1 ELSE 0 END) AS regular,
                AVG(CASE WHEN status<>'not_departed' THEN delay END) AS avg_delay
            FROM trains WHERE date=?
            """,
            (date,),
        ).fetchone()
        arrival = conn.execute(
            """
            SELECT
                SUM(CASE WHEN arrival_delay < 0 THEN 1 ELSE 0 END) AS early,
                SUM(CASE WHEN arrival_delay BETWEEN 0 AND 5 THEN 1 ELSE 0 END) AS on_time,
                SUM(CASE WHEN arrival_delay > 5 THEN 1 ELSE 0 END) AS delayed
            FROM trains WHERE date=? AND status<>'not_departed'
            """,
            (date,),
        ).fetchone()
        departure = conn.execute(
            """
            SELECT
                SUM(CASE WHEN departure_delay BETWEEN 0 AND 5 THEN 1 ELSE 0 END) AS on_time,
                SUM(CASE WHEN departure_delay > 5 THEN 1 ELSE 0 END) AS delayed
            FROM trains WHERE date=? AND status<>'not_departed'
            """,
            (date,),
        ).fetchone()
        categories = conn.execute(
            "SELECT category AS label, COUNT(*) AS value FROM trains WHERE date=? AND category<>'' GROUP BY category ORDER BY value DESC",
            (date,),
        ).fetchall()
        worst = conn.execute(
            "SELECT train_key, train_number, category, origin, destination, relation_key, delay FROM trains WHERE date=? ORDER BY delay DESC LIMIT 1",
            (date,),
        ).fetchone()
        station_total = conn.execute("SELECT COUNT(*) AS total FROM station_registry").fetchone()
        last_run = conn.execute(
            "SELECT * FROM collector_runs WHERE date=? ORDER BY slot_at DESC LIMIT 1",
            (date,),
        ).fetchone()

    monitored = as_int(counts["monitored"] if counts else 0)
    treni_giorno = as_int(snapshot["treni_giorno"] if snapshot else 0)
    coverage_rate = (monitored / treni_giorno) if treni_giorno else 0
    snapshot_time = snapshot["captured_at"] if snapshot else None
    last_run_dict = dict(last_run) if last_run else None
    completed_at = snapshot["finished_at"] if snapshot and "finished_at" in snapshot.keys() else None
    completed_at = completed_at or (last_run_dict or {}).get("finished_at") or snapshot_time
    duration_seconds = as_int(
        snapshot["duration_seconds"]
        if snapshot and "duration_seconds" in snapshot.keys()
        else (last_run_dict or {}).get("duration_seconds", 0)
    )
    collection_status = (
        (snapshot["status"] if snapshot and "status" in snapshot.keys() else None)
        or (last_run_dict or {}).get("status")
        or "unknown"
    )
    return {
        "available": True,
        "date": date,
        "lastUpdated": completed_at,
        "snapshotTime": snapshot_time,
        "collectionCompletedAt": completed_at,
        "collectionDurationSeconds": duration_seconds,
        "collectionStatus": collection_status,
        "nextScheduledAt": to_utc_iso(next_scheduled_slot()) if date == today_rome() else None,
        "lastCollectorRun": last_run_dict,
        "collectionCadenceMinutes": COLLECTOR_INTERVAL_MINUTES,
        "coverage": {"rate": coverage_rate, "percent": coverage_rate * 100, "stations": as_int(station_total["total"] if station_total else 0)},
        "counts": {
            "running": as_int(snapshot["treni_circolanti"] if snapshot else 0),
            "circulated": treni_giorno,
            "monitored": monitored,
            "regular": as_int(counts["regular"] if counts else 0),
            "delayed": as_int(counts["delayed"] if counts else 0),
            "cancelled": as_int(counts["cancelled"] if counts else 0),
            "rescheduled": as_int(counts["rescheduled"] if counts else 0),
            "notDeparted": as_int(counts["not_departed"] if counts else 0),
        },
        "delayTotals": {"average": round(float(counts["avg_delay"] or 0), 2) if counts else 0},
        "punctuality": {
            "departure": {
                "onTime": as_int(departure["on_time"] if departure else 0),
                "delayed": as_int(departure["delayed"] if departure else 0),
            },
            "arrival": {
                "early": as_int(arrival["early"] if arrival else 0),
                "onTime": as_int(arrival["on_time"] if arrival else 0),
                "delayed": as_int(arrival["delayed"] if arrival else 0),
            },
        },
        "categories": [dict(row) for row in categories],
        "worstTrain": {
            "trainKey": worst["train_key"],
            "trainNumber": worst["train_number"],
            "category": worst["category"],
            "origin": worst["origin"],
            "destination": worst["destination"],
            "route": worst["relation_key"],
            "delay": worst["delay"],
        } if worst else None,
        "disclaimer": "Unofficial statistics derived from observable ViaggiaTreno data.",
    }


@app.get("/health")
def health() -> Response:
    return jsonify({
        "ok": True,
        "collectorEnabled": COLLECTOR_ENABLED,
        "cadenceMinutes": COLLECTOR_INTERVAL_MINUTES,
        "scheduleOffsetMinutes": COLLECTOR_SCHEDULE_OFFSET_MINUTES,
        "finalizeTime": COLLECTOR_FINALIZE_TIME,
        "boardConcurrency": COLLECTOR_BOARD_CONCURRENCY,
        "detailConcurrency": COLLECTOR_DETAIL_CONCURRENCY,
        "regionConcurrency": COLLECTOR_REGION_CONCURRENCY,
        "serviceDateLookbackDays": COLLECTOR_SERVICE_DATE_LOOKBACK_DAYS,
        "nextScheduledAt": to_utc_iso(next_scheduled_slot()),
        "lastCollectorRun": collector_run_row(),
    })


@app.post("/v1/collect")
def collect_endpoint() -> Response:
    if not collector_lock.acquire(blocking=False):
        return jsonify({"available": False, "reason": "collector_busy"}), 409
    try:
        slot_text = request.args.get("slotAt") or request.args.get("slot")
        parsed_slot = parse_iso_datetime(slot_text)
        slot = parsed_slot.astimezone(APP_TZ) if parsed_slot else previous_scheduled_slot()
        return jsonify(collect_once(slot_at=slot, trigger="manual"))
    except Exception as exc:
        app.logger.exception("manual statistics collection failed: %s", exc)
        return jsonify({"available": False, "reason": "collector_failed", "error": str(exc)}), 500
    finally:
        collector_lock.release()


@app.get("/v1/days")
def days_endpoint() -> Response:
    limit = min(max(as_int(request.args.get("limit"), 30), 1), 90)
    with db() as conn:
        rows = conn.execute(
            "SELECT date, MAX(COALESCE(finished_at, captured_at)) AS lastUpdated FROM snapshots GROUP BY date ORDER BY date DESC LIMIT ?",
            (limit,),
        ).fetchall()
    if not rows:
        return jsonify({"days": [{"date": today_rome(), "label": today_rome(), "finalized": False}]})
    return jsonify({"days": [{"date": row["date"], "label": row["date"], "lastUpdated": row["lastUpdated"], "finalized": row["date"] < today_rome()} for row in rows]})


@app.get("/v1/summary")
def summary_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    return jsonify(summary_for_date(date))


@app.get("/v1/timeseries")
def timeseries_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    with db() as conn:
        rows = conn.execute(
            """
            SELECT
                captured_at AS timestamp,
                finished_at AS completedAt,
                duration_seconds AS durationSeconds,
                status,
                treni_circolanti AS running,
                treni_giorno AS circulated
            FROM snapshots
            WHERE date=?
            ORDER BY captured_at
            """,
            (date,),
        ).fetchall()
    return jsonify({"date": date, "points": [dict(row) for row in rows]})


def paged_query(sql: str, params: list[Any], page: int, page_size: int) -> tuple[list[dict[str, Any]], int]:
    offset = (page - 1) * page_size
    count_sql = f"SELECT COUNT(*) AS total FROM ({sql})"
    with db() as conn:
        total = as_int(conn.execute(count_sql, params).fetchone()["total"])
        rows = conn.execute(f"{sql} LIMIT ? OFFSET ?", [*params, page_size, offset]).fetchall()
    return [dict(row) for row in rows], total


@app.get("/v1/trains")
def trains_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    q = f"%{request.args.get('q', '').strip()}%"
    category = request.args.get("category", "").strip().upper()
    status = request.args.get("status", "").strip().lower()
    page = max(1, as_int(request.args.get("page"), 1))
    page_size = min(max(as_int(request.args.get("pageSize"), 25), 1), 100)
    where = ["date=?"]
    params: list[Any] = [date]
    if q != "%%":
        where.append("(train_number LIKE ? OR origin LIKE ? OR destination LIKE ? OR relation_key LIKE ?)")
        params.extend([q, q, q, q])
    if category:
        where.append("category=?")
        params.append(category)
    if status:
        where.append("status=?")
        params.append(status)
    sql = f"""
        SELECT train_key, train_number AS trainNumber, category, operator, status,
               service_date AS serviceDate, origin, destination, relation_key AS route, delay, departure_delay AS departureDelay,
               arrival_delay AS arrivalDelay, not_departed AS notDeparted,
               has_details AS hasDetails, completed, last_seen AS lastSeen
        FROM trains
        WHERE {' AND '.join(where)}
        ORDER BY last_seen DESC, delay DESC
    """
    items, total = paged_query(sql, params, page, page_size)
    return jsonify({"items": items, "total": total, "page": page, "pageSize": page_size})


@app.get("/v1/trains/<date>/<path:key>")
def train_detail_endpoint(date: str, key: str) -> Response:
    with db() as conn:
        row = conn.execute("SELECT * FROM trains WHERE date=? AND train_key=?", (date, key)).fetchone()
        stops = conn.execute(
            "SELECT * FROM train_stops WHERE date=? AND train_key=? ORDER BY stop_number",
            (date, key),
        ).fetchall()
    if not row:
        return jsonify({"available": False, "reason": "not_found"}), 404
    item = dict(row)
    try:
        item["raw"] = json.loads(item.pop("raw_json") or "{}")
    except json.JSONDecodeError:
        item["raw"] = {}
    item["stops"] = [dict(stop) for stop in stops]
    return jsonify({"available": True, "train": item})


@app.get("/v1/stations/search")
def stations_search_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    q = f"%{request.args.get('q', '').strip()}%"
    page = max(1, as_int(request.args.get("page"), 1))
    page_size = min(max(as_int(request.args.get("pageSize"), 25), 1), 100)
    params: list[Any] = [date]
    where = "date=?"
    if q != "%%":
        where += " AND (station_name LIKE ? OR station_code LIKE ?)"
        params.extend([q, q])
    sql = f"""
        SELECT station_code AS code, station_name AS station, monitored, cancelled,
               delayed, ROUND(CASE WHEN monitored > 0 THEN total_delay * 1.0 / monitored ELSE 0 END, 2) AS avgDelay
        FROM station_stats
        WHERE {where}
        ORDER BY monitored DESC
    """
    items, total = paged_query(sql, params, page, page_size)
    return jsonify({"items": items, "total": total, "page": page, "pageSize": page_size})


@app.get("/v1/stations/<station_code>")
def station_endpoint(station_code: str) -> Response:
    date = request.args.get("date") or today_rome()
    with db() as conn:
        row = conn.execute("SELECT * FROM station_stats WHERE date=? AND station_code=?", (date, station_code)).fetchone()
    if not row:
        return jsonify({"available": False, "reason": "not_found"}), 404
    return jsonify({"available": True, "station": dict(row)})


@app.get("/v1/relations")
def relations_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    from_q = request.args.get("from", "").strip()
    to_q = request.args.get("to", "").strip()
    q = request.args.get("q", "").strip()
    page = max(1, as_int(request.args.get("page"), 1))
    page_size = min(max(as_int(request.args.get("pageSize"), 25), 1), 100)
    where = ["date=?"]
    params: list[Any] = [date]
    if from_q:
        where.append("from_station LIKE ?")
        params.append(f"%{from_q}%")
    if to_q:
        where.append("to_station LIKE ?")
        params.append(f"%{to_q}%")
    if q:
        where.append("relation_key LIKE ?")
        params.append(f"%{q}%")
    sql = f"""
        SELECT relation_key AS relation, from_station AS fromStation, to_station AS toStation,
               monitored, cancelled, ROUND(CASE WHEN monitored > 0 THEN total_delay * 1.0 / monitored ELSE 0 END, 2) AS avgDelay
        FROM relation_stats
        WHERE {' AND '.join(where)}
        ORDER BY monitored DESC
    """
    items, total = paged_query(sql, params, page, page_size)
    return jsonify({"items": items, "total": total, "page": page, "pageSize": page_size})


@app.get("/v1/ranking")
def ranking_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    metric = request.args.get("metric", "delay")
    metric_map = {
        "delay": "delay",
        "arrival_delay": "arrival_delay",
        "departure_delay": "departure_delay",
    }
    column = metric_map.get(metric, "delay")
    limit = min(max(as_int(request.args.get("limit"), 25), 1), 100)
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT train_key, train_number AS trainNumber, category, origin, destination,
                   relation_key AS route, service_date AS serviceDate, status, {column} AS delay
            FROM trains
            WHERE date=?
            ORDER BY {column} DESC
            LIMIT ?
            """,
            (date, limit),
        ).fetchall()
    return jsonify({"items": [dict(row) for row in rows], "total": len(rows)})


@app.get("/v1/export.csv")
def export_csv_endpoint() -> Response:
    date = request.args.get("date") or today_rome()
    view = request.args.get("view", "trains")
    with db() as conn:
        if view == "station":
            rows = conn.execute("SELECT * FROM station_stats WHERE date=? ORDER BY monitored DESC", (date,)).fetchall()
        elif view == "relation":
            rows = conn.execute("SELECT * FROM relation_stats WHERE date=? ORDER BY monitored DESC", (date,)).fetchall()
        elif view == "stops":
            rows = conn.execute("SELECT * FROM train_stops WHERE date=? ORDER BY train_key, stop_number", (date,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM trains WHERE date=? ORDER BY last_seen DESC", (date,)).fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    if rows:
        keys = [key for key in rows[0].keys() if key != "raw_json"]
        writer.writerow(keys)
        for row in rows:
            writer.writerow([row[key] for key in keys])
    return Response(
        output.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=bellotreno-{view}-{date}.csv"},
    )


init_db()
if COLLECTOR_ENABLED:
    thread = threading.Thread(target=collector_loop, daemon=True)
    thread.start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081)
